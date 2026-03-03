import { TerminalRelay } from './terminal-relay';

interface Env {
  TERMINAL_RELAY: DurableObjectNamespace;
  UPSTREAM_WS_BASE: string;
}

function json(payload: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    ...init,
    headers
  });
}

export { TerminalRelay };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET' && new URL(request.url).pathname === '/healthz') {
      return json({
        ok: true
      });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const relayKey =
      url.searchParams.get('relayKey') || url.searchParams.get('session') || url.searchParams.get('channel') || 'default';
    const relayId = env.TERMINAL_RELAY.idFromName(relayKey);
    const relay = env.TERMINAL_RELAY.get(relayId);
    return relay.fetch(request);
  }
};
