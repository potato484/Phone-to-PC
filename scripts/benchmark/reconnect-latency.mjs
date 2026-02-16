#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) {
      continue;
    }
    const [key, value = ''] = item.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function rawDataToText(raw) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString('utf8');
  }
  return Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item)))).toString('utf8');
}

function waitForJson(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for websocket message'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('websocket closed before expected message'));
    };

    const onMessage = (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(rawDataToText(raw));
      } catch {
        payload = null;
      }
      if (!payload) {
        return;
      }
      if (predicate(payload)) {
        cleanup();
        resolve(payload);
      }
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

async function openWebSocket(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function percentile(values, q) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[index];
}

async function exchangeAccessToken(baseUrl, bootstrapToken) {
  const response = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrapToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`exchange failed status=${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload.accessToken !== 'string') {
    throw new Error('exchange response missing accessToken');
  }
  return payload.accessToken;
}

async function authenticateControl(controlWs, token, timeoutMs) {
  controlWs.send(
    JSON.stringify({
      type: 'auth',
      token,
      client: {
        ua: 'benchmark-reconnect',
        version: 1
      }
    })
  );
  await waitForJson(controlWs, (payload) => payload.type === 'auth.ok', timeoutMs);
}

async function ensureSession(controlWs, timeoutMs, providedSessionId = '') {
  if (providedSessionId) {
    return {
      sessionId: providedSessionId,
      created: false
    };
  }

  controlWs.send(
    JSON.stringify({
      type: 'spawn',
      cli: 'shell',
      cols: 120,
      rows: 36
    })
  );

  const payload = await waitForJson(
    controlWs,
    (message) => message.type === 'spawned' && typeof message.sessionId === 'string',
    timeoutMs
  );

  return {
    sessionId: payload.sessionId,
    created: true
  };
}

async function closeWs(ws) {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return;
  }
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args['base-url'] || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  const iterations = Math.max(1, Number.parseInt(args.iterations || '20', 10));
  const timeoutMs = Math.max(1000, Number.parseInt(args['timeout-ms'] || '5000', 10));
  const assertLtMs = Math.max(1, Number.parseInt(args['assert-lt-ms'] || '2000', 10));
  const providedSessionId = args['session-id'] || '';

  let bootstrapToken = args['bootstrap-token'] || '';
  if (!bootstrapToken) {
    const tokenPath = path.resolve(process.cwd(), '.auth-token');
    if (!fs.existsSync(tokenPath)) {
      throw new Error('missing bootstrap token, provide --bootstrap-token=<token>');
    }
    bootstrapToken = fs.readFileSync(tokenPath, 'utf8').trim();
  }

  const accessToken = await exchangeAccessToken(baseUrl, bootstrapToken);
  const controlWs = await openWebSocket(`${wsBase}/ws/control`);
  let createdSession = '';

  try {
    await authenticateControl(controlWs, accessToken, timeoutMs);
    await waitForJson(controlWs, (payload) => payload.type === 'sessions' && Array.isArray(payload.list), timeoutMs);

    const sessionResult = await ensureSession(controlWs, timeoutMs, providedSessionId);
    const sessionId = sessionResult.sessionId;
    createdSession = sessionResult.created ? sessionId : '';

    const latencyMs = [];
    for (let i = 0; i < iterations; i += 1) {
      const terminalUrl = `${wsBase}/ws/terminal?session=${encodeURIComponent(sessionId)}&cols=120&rows=36`;
      const terminalWs = await openWebSocket(terminalUrl);
      const startedAt = performance.now();

      terminalWs.send(
        JSON.stringify({
          type: 'auth',
          token: accessToken,
          client: {
            ua: 'benchmark-reconnect',
            version: 1
          }
        })
      );

      await waitForJson(terminalWs, (payload) => payload.type === 'auth.ok', timeoutMs);
      latencyMs.push(performance.now() - startedAt);

      await closeWs(terminalWs);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const p50 = percentile(latencyMs, 50);
    const p95 = percentile(latencyMs, 95);
    const p99 = percentile(latencyMs, 99);

    console.log('Reconnect latency benchmark');
    console.log(`Base URL      : ${baseUrl}`);
    console.log(`Iterations    : ${iterations}`);
    console.log(`Session ID    : ${sessionResult.sessionId}`);
    console.log(`p50 / p95 / p99 (ms): ${p50.toFixed(2)} / ${p95.toFixed(2)} / ${p99.toFixed(2)}`);

    if (p95 >= assertLtMs) {
      console.error(`FAIL: p95=${p95.toFixed(2)}ms >= ${assertLtMs}ms`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: p95=${p95.toFixed(2)}ms < ${assertLtMs}ms`);
    }

    if (createdSession) {
      controlWs.send(
        JSON.stringify({
          type: 'kill',
          sessionId: createdSession
        })
      );
    }
  } finally {
    await closeWs(controlWs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reconnect benchmark failed: ${message}`);
  process.exit(1);
});
