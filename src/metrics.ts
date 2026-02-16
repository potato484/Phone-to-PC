import { monitorEventLoopDelay } from 'node:perf_hooks';

export type WsChannelName = 'control' | 'terminal' | 'desktop';

function toFiniteNumber(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatMetricLine(name: string, labels: Record<string, string> | null, value: number): string {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${value}`;
  }
  const formattedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${labelValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
  return `${name}{${formattedLabels}} ${value}`;
}

export class MetricsRegistry {
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private wsConnections: Record<WsChannelName, number> = {
    control: 0,
    terminal: 0,
    desktop: 0
  };
  private wsAuthFailTotal = 0;
  private terminalSessionsActive = 0;
  private desktopUpstreamBufferedBytes = 0;
  private terminalSendBufferedBytes = 0;
  private readonly startedAt = Date.now();

  constructor() {
    this.eventLoopDelay.enable();
  }

  dispose(): void {
    this.eventLoopDelay.disable();
  }

  incWsConnection(channel: WsChannelName): void {
    this.wsConnections[channel] = Math.max(0, this.wsConnections[channel] + 1);
  }

  decWsConnection(channel: WsChannelName): void {
    this.wsConnections[channel] = Math.max(0, this.wsConnections[channel] - 1);
  }

  incWsAuthFailTotal(): void {
    this.wsAuthFailTotal += 1;
  }

  setTerminalSessionsActive(value: number): void {
    this.terminalSessionsActive = Math.max(0, Math.floor(toFiniteNumber(value)));
  }

  setDesktopUpstreamBufferedBytes(value: number): void {
    this.desktopUpstreamBufferedBytes = Math.max(0, Math.floor(toFiniteNumber(value)));
  }

  setTerminalSendBufferedBytes(value: number): void {
    this.terminalSendBufferedBytes = Math.max(0, Math.floor(toFiniteNumber(value)));
  }

  getEventLoopLagMs(): { p50: number; p95: number; p99: number } {
    const p50 = toFiniteNumber(this.eventLoopDelay.percentile(50) / 1_000_000, 0);
    const p95 = toFiniteNumber(this.eventLoopDelay.percentile(95) / 1_000_000, 0);
    const p99 = toFiniteNumber(this.eventLoopDelay.percentile(99) / 1_000_000, 0);
    return {
      p50: Number(p50.toFixed(3)),
      p95: Number(p95.toFixed(3)),
      p99: Number(p99.toFixed(3))
    };
  }

  getHealthSnapshot(): {
    timestamp: string;
    uptimeSec: number;
    memory: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
      external: number;
      arrayBuffers: number;
    };
    eventLoopLagMs: {
      p50: number;
      p95: number;
      p99: number;
    };
  } {
    const memoryUsage = process.memoryUsage();
    return {
      timestamp: nowIso(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      memory: {
        rss: memoryUsage.rss,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      eventLoopLagMs: this.getEventLoopLagMs()
    };
  }

  renderPrometheus(): string {
    const memoryUsage = process.memoryUsage();
    const lag = this.getEventLoopLagMs();
    const lines: string[] = [];

    lines.push('# HELP c2p_ws_connections Active websocket connections by channel');
    lines.push('# TYPE c2p_ws_connections gauge');
    lines.push(formatMetricLine('c2p_ws_connections', { channel: 'control' }, this.wsConnections.control));
    lines.push(formatMetricLine('c2p_ws_connections', { channel: 'terminal' }, this.wsConnections.terminal));
    lines.push(formatMetricLine('c2p_ws_connections', { channel: 'desktop' }, this.wsConnections.desktop));

    lines.push('# HELP c2p_ws_auth_fail_total Total websocket auth failures');
    lines.push('# TYPE c2p_ws_auth_fail_total counter');
    lines.push(`c2p_ws_auth_fail_total ${this.wsAuthFailTotal}`);

    lines.push('# HELP c2p_event_loop_lag_ms Event loop lag quantiles in milliseconds');
    lines.push('# TYPE c2p_event_loop_lag_ms gauge');
    lines.push(formatMetricLine('c2p_event_loop_lag_ms', { quantile: 'p50' }, lag.p50));
    lines.push(formatMetricLine('c2p_event_loop_lag_ms', { quantile: 'p95' }, lag.p95));
    lines.push(formatMetricLine('c2p_event_loop_lag_ms', { quantile: 'p99' }, lag.p99));

    lines.push('# HELP c2p_terminal_sessions_active Active terminal sessions');
    lines.push('# TYPE c2p_terminal_sessions_active gauge');
    lines.push(`c2p_terminal_sessions_active ${this.terminalSessionsActive}`);

    lines.push('# HELP c2p_desktop_upstream_buffered_bytes Buffered bytes on desktop upstream path');
    lines.push('# TYPE c2p_desktop_upstream_buffered_bytes gauge');
    lines.push(`c2p_desktop_upstream_buffered_bytes ${this.desktopUpstreamBufferedBytes}`);

    lines.push('# HELP c2p_terminal_send_buffered_bytes Buffered bytes pending terminal send');
    lines.push('# TYPE c2p_terminal_send_buffered_bytes gauge');
    lines.push(`c2p_terminal_send_buffered_bytes ${this.terminalSendBufferedBytes}`);

    lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
    lines.push('# TYPE process_resident_memory_bytes gauge');
    lines.push(`process_resident_memory_bytes ${memoryUsage.rss}`);

    lines.push('# HELP nodejs_heap_size_used_bytes V8 heap used bytes');
    lines.push('# TYPE nodejs_heap_size_used_bytes gauge');
    lines.push(`nodejs_heap_size_used_bytes ${memoryUsage.heapUsed}`);

    return `${lines.join('\n')}\n`;
  }
}
