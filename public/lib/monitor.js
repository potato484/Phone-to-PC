import { DOM, apiUrl, authedFetch } from './state.js';

const MONITOR_POLL_INTERVAL_MS = 5_000;

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.min(100, num));
}

function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  const fixed = next >= 100 || index === 0 ? 0 : 1;
  return `${next.toFixed(fixed)} ${units[index]}`;
}

function formatUptime(totalSeconds) {
  const value = Number(totalSeconds);
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  const sec = Math.floor(value);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function setMeter(fillEl, percent) {
  if (!fillEl) {
    return;
  }
  fillEl.style.width = `${Math.round(clampPercent(percent))}%`;
}

function setText(node, text) {
  if (!node) {
    return;
  }
  node.textContent = text;
}

function gradeLabel(grade) {
  if (grade === 'excellent') {
    return '优秀';
  }
  if (grade === 'good') {
    return '良好';
  }
  if (grade === 'fair') {
    return '一般';
  }
  if (grade === 'poor') {
    return '较差';
  }
  return '离线';
}

export function createMonitor({ toast }) {
  let pollTimer = 0;
  let firstLoad = true;
  let qualitySnapshot = null;

  async function fetchStats() {
    const response = await authedFetch(apiUrl('/api/system/stats'));
    if (!response.ok) {
      throw new Error(`stats failed (${response.status})`);
    }
    return response.json();
  }

  function render(stats) {
    const cpuPercent = clampPercent(stats && stats.cpu ? stats.cpu.usagePercent : 0);
    setMeter(DOM.monitorCpuFill, cpuPercent);
    setText(DOM.monitorCpuText, `${cpuPercent.toFixed(1)}%`);

    const memoryPercent = clampPercent(stats && stats.memory ? stats.memory.usagePercent : 0);
    const memoryUsed = stats && stats.memory ? formatBytes(stats.memory.usedBytes) : '-';
    const memoryTotal = stats && stats.memory ? formatBytes(stats.memory.totalBytes) : '-';
    setMeter(DOM.monitorMemoryFill, memoryPercent);
    setText(DOM.monitorMemoryText, `${memoryPercent.toFixed(1)}% (${memoryUsed}/${memoryTotal})`);

    if (stats && stats.disk) {
      const diskPercent = clampPercent(stats.disk.usagePercent);
      setMeter(DOM.monitorDiskFill, diskPercent);
      setText(
        DOM.monitorDiskText,
        `${diskPercent.toFixed(1)}% (${formatBytes(stats.disk.usedBytes)}/${formatBytes(stats.disk.totalBytes)})`
      );
    } else {
      setMeter(DOM.monitorDiskFill, 0);
      setText(DOM.monitorDiskText, '不可用');
    }

    if (stats && stats.network) {
      setText(DOM.monitorNetRxText, `↓ ${formatBytes(stats.network.rxRateBytesPerSec)}/s`);
      setText(DOM.monitorNetTxText, `↑ ${formatBytes(stats.network.txRateBytesPerSec)}/s`);
    } else {
      setText(DOM.monitorNetRxText, '↓ -');
      setText(DOM.monitorNetTxText, '↑ -');
    }

    setText(DOM.monitorUptimeText, formatUptime(stats ? stats.uptimeSec : 0));
    if (stats && stats.vnc) {
      const prefix = stats.vnc.available ? '在线' : '离线';
      setText(DOM.monitorVncText, `${prefix} · ${stats.vnc.backend}`);
    } else {
      setText(DOM.monitorVncText, '离线');
    }

    const updatedAt = stats && stats.timestamp ? new Date(stats.timestamp) : new Date();
    const hh = String(updatedAt.getHours()).padStart(2, '0');
    const mm = String(updatedAt.getMinutes()).padStart(2, '0');
    const ss = String(updatedAt.getSeconds()).padStart(2, '0');
    setText(DOM.monitorUpdatedAt, `${hh}:${mm}:${ss}`);

    renderQuality();
  }

  function renderQuality() {
    const snapshot = qualitySnapshot;
    if (!snapshot || !snapshot.connected) {
      setText(DOM.monitorCqsText, '离线');
      setText(DOM.monitorRttText, 'RTT -');
      setText(DOM.monitorJitterText, '抖动 -');
      setText(DOM.monitorLossText, '丢包 -');
      setText(DOM.monitorProfileText, `桌面档位 ${snapshot && snapshot.desktopProfile ? snapshot.desktopProfile : 'balanced'}`);
      return;
    }

    const score = Number.isFinite(snapshot.score) ? Math.max(0, Math.min(100, Math.round(snapshot.score))) : 0;
    const rttMs = Number.isFinite(snapshot.rttMs) ? Number(snapshot.rttMs).toFixed(1) : '-';
    const jitterMs = Number.isFinite(snapshot.jitterMs) ? Number(snapshot.jitterMs).toFixed(1) : '-';
    const lossPercent = Number.isFinite(snapshot.lossPercent) ? Number(snapshot.lossPercent).toFixed(1) : '-';

    setText(DOM.monitorCqsText, `${score}/100 · ${gradeLabel(snapshot.grade)}`);
    setText(DOM.monitorRttText, `RTT ${rttMs}ms`);
    setText(DOM.monitorJitterText, `抖动 ${jitterMs}ms`);
    setText(DOM.monitorLossText, `丢包 ${lossPercent}%`);
    setText(DOM.monitorProfileText, `桌面档位 ${snapshot.desktopProfile || 'balanced'}`);
  }

  async function pollOnce() {
    try {
      const stats = await fetchStats();
      render(stats);
      firstLoad = false;
    } catch (error) {
      if (firstLoad) {
        toast.show(`系统监控初始化失败: ${error.message}`, 'warn');
        firstLoad = false;
      }
    }
  }

  function schedule() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
    }
    pollTimer = window.setTimeout(async () => {
      pollTimer = 0;
      await pollOnce();
      schedule();
    }, MONITOR_POLL_INTERVAL_MS);
  }

  return {
    init() {
      if (!DOM.monitorPanel) {
        return;
      }
      void pollOnce();
      schedule();
    },
    refresh() {
      void pollOnce();
    },
    setConnectionQuality(snapshot) {
      qualitySnapshot = snapshot || null;
      renderQuality();
    }
  };
}
