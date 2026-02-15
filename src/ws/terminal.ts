import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { PtyManager } from '../pty-manager.js';
import type { WsChannel } from './channel.js';
import { WS_PER_MESSAGE_DEFLATE } from './ws-config.js';

interface TerminalChannelDeps {
  ptyManager: PtyManager;
}

const TERMINAL_SEND_BATCH_MS = 16;
const TERMINAL_SEND_HIGH_WATER_BYTES = 64 * 1024;
const TERMINAL_SEND_LOW_WATER_BYTES = 32 * 1024;
const TERMINAL_REPLAY_CHUNK_BYTES = 64 * 1024;
const TERMINAL_FRAME_HEADER_BYTES = 5;
const TERMINAL_FRAME_TYPE_OUTPUT = 1;
const TERMINAL_FRAME_TYPE_INPUT = 2;
const TERMINAL_CODEC_BINARY_V1 = 'binary-v1';

function parseReplayOffset(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function useBinaryCodec(value: string | null): boolean {
  return value === TERMINAL_CODEC_BINARY_V1;
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return Buffer.from(raw, 'utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  return Buffer.concat(raw.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
}

function rawDataToString(raw: RawData): string {
  return rawDataToBuffer(raw).toString('utf8');
}

function hashSessionId(sessionId: string): number {
  const source = Buffer.from(sessionId, 'utf8');
  let hash = 0x811c9dc5;
  for (const byte of source) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function encodeTerminalFrame(frameType: number, sessionHash: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(TERMINAL_FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = frameType;
  frame.writeUInt32BE(sessionHash >>> 0, 1);
  payload.copy(frame, TERMINAL_FRAME_HEADER_BYTES);
  return frame;
}

function decodeTerminalFrame(raw: RawData, expectedSessionHash: number): { frameType: number; payload: Buffer } | null {
  const frame = rawDataToBuffer(raw);
  if (frame.byteLength < TERMINAL_FRAME_HEADER_BYTES) {
    return null;
  }
  const sessionHash = frame.readUInt32BE(1);
  if (sessionHash !== expectedSessionHash) {
    return null;
  }
  return {
    frameType: frame[0],
    payload: frame.subarray(TERMINAL_FRAME_HEADER_BYTES)
  };
}

async function streamLogRange(
  logPath: string,
  startOffset: number,
  endOffset: number,
  onChunk: (data: string) => void
): Promise<void> {
  if (endOffset <= startOffset) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const decoder = new TextDecoder();
    const stream = fs.createReadStream(logPath, {
      start: startOffset,
      end: endOffset - 1,
      highWaterMark: TERMINAL_REPLAY_CHUNK_BYTES
    });

    stream.on('data', (chunk) => {
      const payload = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const text = decoder.decode(payload, { stream: true });
      if (text.length > 0) {
        onChunk(text);
      }
    });

    stream.on('end', () => {
      const tail = decoder.decode();
      if (tail.length > 0) {
        onChunk(tail);
      }
      resolve();
    });

    stream.on('error', reject);
  });
}

function trimChunkToOffset(
  chunk: { data: string; startOffset: number; endOffset: number },
  offset: number
): string {
  if (offset <= chunk.startOffset) {
    return chunk.data;
  }
  if (offset >= chunk.endOffset) {
    return '';
  }
  const skipBytes = offset - chunk.startOffset;
  return Buffer.from(chunk.data, 'utf8').subarray(skipBytes).toString('utf8');
}

export function createTerminalChannel(deps: TerminalChannelDeps): WsChannel {
  const { ptyManager } = deps;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: WS_PER_MESSAGE_DEFLATE });

  wss.on('connection', (ws, request) => {
    const host = request.headers.host ?? 'localhost';
    const parsed = new URL(request.url ?? '/', `http://${host}`);
    const sessionId = parsed.searchParams.get('session');
    const replayFrom = parseReplayOffset(parsed.searchParams.get('replayFrom'));
    const binaryCodec = useBinaryCodec(parsed.searchParams.get('codec'));

    if (!sessionId || !ptyManager.hasSession(sessionId)) {
      ws.close(1008, 'invalid session');
      return;
    }

    const sessionHash = hashSessionId(sessionId);
    const sendQueue: Buffer[] = [];
    let queuedBytes = 0;
    let flushTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    let flowPaused = false;
    let replayReady = false;
    let replayCursor = Math.max(0, replayFrom);
    const liveQueue: Array<{ data: string; startOffset: number; endOffset: number }> = [];

    const releaseFlowControl = (): void => {
      if (!flowPaused) {
        return;
      }
      flowPaused = false;
      ptyManager.resumeOutput(sessionId);
    };

    const maybeReleaseFlowControl = (): void => {
      if (
        flowPaused &&
        queuedBytes <= TERMINAL_SEND_LOW_WATER_BYTES &&
        ws.bufferedAmount <= TERMINAL_SEND_LOW_WATER_BYTES
      ) {
        releaseFlowControl();
      }
    };

    const applyFlowControl = (): void => {
      if (flowPaused) {
        return;
      }
      if (queuedBytes < TERMINAL_SEND_HIGH_WATER_BYTES && ws.bufferedAmount <= TERMINAL_SEND_HIGH_WATER_BYTES) {
        return;
      }
      flowPaused = true;
      ptyManager.pauseOutput(sessionId);
    };

    const clearTimers = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushQueue();
      }, TERMINAL_SEND_BATCH_MS);
    };

    const waitForDrain = (): void => {
      if (drainTimer || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const checkDrain = (): void => {
        drainTimer = null;
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        if (ws.bufferedAmount <= TERMINAL_SEND_LOW_WATER_BYTES) {
          if (sendQueue.length > 0) {
            scheduleFlush();
          }
          maybeReleaseFlowControl();
          return;
        }
        drainTimer = setTimeout(checkDrain, TERMINAL_SEND_BATCH_MS);
      };
      drainTimer = setTimeout(checkDrain, TERMINAL_SEND_BATCH_MS);
    };

    const flushQueue = (): void => {
      if (ws.readyState !== WebSocket.OPEN || sendQueue.length === 0) {
        return;
      }
      if (ws.bufferedAmount > TERMINAL_SEND_HIGH_WATER_BYTES) {
        waitForDrain();
        return;
      }

      const payload = Buffer.concat(sendQueue, queuedBytes);
      sendQueue.length = 0;
      queuedBytes = 0;
      const outbound = binaryCodec
        ? encodeTerminalFrame(TERMINAL_FRAME_TYPE_OUTPUT, sessionHash, payload)
        : payload.toString('utf8');

      ws.send(outbound, (error) => {
        if (error && ws.readyState === WebSocket.OPEN) {
          ws.close(1011, 'terminal send failed');
          return;
        }
        if (sendQueue.length > 0) {
          scheduleFlush();
        }
        maybeReleaseFlowControl();
      });

      if (ws.bufferedAmount > TERMINAL_SEND_HIGH_WATER_BYTES) {
        waitForDrain();
        applyFlowControl();
        return;
      }
      maybeReleaseFlowControl();
    };

    const enqueueOutput = (data: string): void => {
      if (!data || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const chunk = Buffer.from(data, 'utf8');
      if (chunk.byteLength === 0) {
        return;
      }
      sendQueue.push(chunk);
      queuedBytes += chunk.byteLength;
      if (queuedBytes >= TERMINAL_SEND_HIGH_WATER_BYTES) {
        applyFlowControl();
        flushQueue();
        return;
      }
      applyFlowControl();
      scheduleFlush();
    };

    const flushLiveQueue = (): void => {
      while (liveQueue.length > 0) {
        const chunk = liveQueue.shift();
        if (!chunk || chunk.endOffset <= replayCursor) {
          continue;
        }
        const text = trimChunkToOffset(chunk, replayCursor);
        replayCursor = chunk.endOffset;
        if (text.length > 0) {
          enqueueOutput(text);
        }
      }
    };

    const offDataChunk = ptyManager.onDataChunk((id, chunk) => {
      if (id !== sessionId) {
        return;
      }
      if (!replayReady) {
        liveQueue.push(chunk);
        return;
      }
      if (chunk.endOffset <= replayCursor) {
        return;
      }
      const text = trimChunkToOffset(chunk, replayCursor);
      replayCursor = chunk.endOffset;
      if (text.length > 0) {
        enqueueOutput(text);
      }
    });

    const offExit = ptyManager.onExit((id) => {
      if (id === sessionId && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'session exited');
      }
    });

    void (async () => {
      const logPath = ptyManager.getLogPath(sessionId);
      const snapshotEnd = ptyManager.getLogBytes(sessionId);
      const replayStart = Math.min(replayCursor, snapshotEnd);
      replayCursor = replayStart;
      if (logPath && replayStart < snapshotEnd) {
        try {
          await streamLogRange(logPath, replayStart, snapshotEnd, enqueueOutput);
        } catch {
          // skip replay on read failure and continue with live data
        }
      }
      replayCursor = Math.max(replayCursor, snapshotEnd);
      replayReady = true;
      flushLiveQueue();
    })();

    ws.on('message', (raw, isBinary) => {
      if (!ptyManager.hasSession(sessionId)) {
        return;
      }
      if (isBinary) {
        const frame = decodeTerminalFrame(raw, sessionHash);
        if (!frame || frame.frameType !== TERMINAL_FRAME_TYPE_INPUT) {
          ws.close(1003, 'invalid terminal frame');
          return;
        }
        if (frame.payload.byteLength > 0) {
          ptyManager.write(sessionId, frame.payload.toString('utf8'));
        }
        return;
      }
      ptyManager.write(sessionId, rawDataToString(raw));
    });

    ws.on('close', () => {
      clearTimers();
      releaseFlowControl();
      offDataChunk();
      offExit();
    });
  });

  return {
    pathname: '/ws/terminal',
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  };
}
