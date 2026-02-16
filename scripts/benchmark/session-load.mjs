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

async function closeWs(ws) {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return;
  }
  await new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args['base-url'] || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  const concurrency = Math.max(1, Number.parseInt(args.concurrency || '20', 10));
  const holdMs = Math.max(200, Number.parseInt(args['hold-ms'] || '2000', 10));
  const timeoutMs = Math.max(1000, Number.parseInt(args['timeout-ms'] || '5000', 10));
  const minSuccessRate = Math.max(0, Math.min(1, Number.parseFloat(args['min-success-rate'] || '0.995')));

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

  try {
    controlWs.send(
      JSON.stringify({
        type: 'auth',
        token: accessToken,
        client: {
          ua: 'benchmark-session-load',
          version: 1
        }
      })
    );

    await waitForJson(controlWs, (payload) => payload.type === 'auth.ok', timeoutMs);
    await waitForJson(controlWs, (payload) => payload.type === 'sessions' && Array.isArray(payload.list), timeoutMs);

    let sessionId = args['session-id'] || '';
    let sessionCreated = false;

    if (!sessionId) {
      controlWs.send(
        JSON.stringify({
          type: 'spawn',
          cli: 'shell',
          cols: 120,
          rows: 36
        })
      );
      const spawned = await waitForJson(
        controlWs,
        (payload) => payload.type === 'spawned' && typeof payload.sessionId === 'string',
        timeoutMs
      );
      sessionId = spawned.sessionId;
      sessionCreated = true;
    }

    const authLatencies = [];
    const tasks = Array.from({ length: concurrency }, async (_, index) => {
      const terminalUrl = `${wsBase}/ws/terminal?session=${encodeURIComponent(sessionId)}&cols=120&rows=36`;
      const ws = await openWebSocket(terminalUrl);
      const startedAt = performance.now();

      ws.send(
        JSON.stringify({
          type: 'auth',
          token: accessToken,
          client: {
            ua: `benchmark-session-load-${index + 1}`,
            version: 1
          }
        })
      );

      await waitForJson(ws, (payload) => payload.type === 'auth.ok', timeoutMs);
      authLatencies.push(performance.now() - startedAt);

      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await closeWs(ws);
      return true;
    });

    const results = await Promise.allSettled(tasks);
    const success = results.filter((entry) => entry.status === 'fulfilled').length;
    const failure = results.length - success;
    const successRate = results.length === 0 ? 0 : success / results.length;

    authLatencies.sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(authLatencies.length * 0.95) - 1);
    const p95 = authLatencies[p95Index] ?? 0;

    console.log('Session load benchmark');
    console.log(`Base URL         : ${baseUrl}`);
    console.log(`Session ID       : ${sessionId}`);
    console.log(`Concurrency      : ${concurrency}`);
    console.log(`Hold per client  : ${holdMs}ms`);
    console.log(`Success / Failure: ${success} / ${failure}`);
    console.log(`Success rate     : ${(successRate * 100).toFixed(2)}%`);
    console.log(`Auth p95         : ${p95.toFixed(2)}ms`);

    if (successRate < minSuccessRate) {
      console.error(`FAIL: success rate ${(successRate * 100).toFixed(2)}% < ${(minSuccessRate * 100).toFixed(2)}%`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: success rate ${(successRate * 100).toFixed(2)}% >= ${(minSuccessRate * 100).toFixed(2)}%`);
    }

    if (sessionCreated) {
      controlWs.send(
        JSON.stringify({
          type: 'kill',
          sessionId
        })
      );
    }
  } finally {
    await closeWs(controlWs);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`session load benchmark failed: ${message}`);
  process.exit(1);
});
