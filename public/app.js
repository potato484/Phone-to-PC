import { createControl } from './lib/control.js';
import { createFiles } from './lib/files.js';
import { createGestures } from './lib/gestures.js';
import { createMonitor } from './lib/monitor.js';
import { createTerm } from './lib/term.js';
import { createUi } from './lib/ui.js';

let control = null;
let term = null;
let desktop = null;

const getControl = () => control;
const getTerm = () => term;

const ui = createUi({ getControl, getTerm });

term = createTerm({
  getControl,
  statusBar: ui.StatusBar,
  toast: ui.Toast,
  onActiveSessionChange: (sessionId) => {
    ui.onActiveSessionChanged(sessionId);
  }
});

control = createControl({
  term,
  sessionTabs: ui.SessionTabs,
  statusBar: ui.StatusBar,
  toast: ui.Toast,
  actions: ui.Actions
});

const gestures = createGestures({
  getTerm,
  sessionTabs: ui.SessionTabs,
  toast: ui.Toast
});

const files = createFiles({
  toast: ui.Toast
});

const monitor = createMonitor({
  toast: ui.Toast
});

function markDesktopUnavailable(message) {
  if (typeof document === 'undefined') {
    return;
  }
  const viewDesktopBtn = document.getElementById('view-desktop-btn');
  const desktopConnectBtn = document.getElementById('desktop-connect-btn');
  const desktopStatusText = document.getElementById('desktop-status-text');
  const desktopPlaceholder = document.getElementById('desktop-placeholder');

  if (viewDesktopBtn) {
    viewDesktopBtn.setAttribute('aria-disabled', 'true');
    viewDesktopBtn.disabled = true;
    viewDesktopBtn.title = message;
  }
  if (desktopConnectBtn) {
    desktopConnectBtn.disabled = true;
    desktopConnectBtn.textContent = '桌面不可用';
  }
  if (desktopStatusText) {
    desktopStatusText.textContent = '不可用';
  }
  if (desktopPlaceholder) {
    desktopPlaceholder.hidden = false;
    desktopPlaceholder.textContent = message;
  }
}

async function initDesktop() {
  try {
    const { createDesktop } = await import('./lib/desktop.js');
    desktop = createDesktop({
      getTerm,
      statusBar: ui.StatusBar,
      toast: ui.Toast
    });
    desktop.init();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = '桌面模块加载失败';
    markDesktopUnavailable(message);
    ui.Toast.show(`${message}，终端功能可继续使用`, 'warn');
    console.error('[c2p] desktop bootstrap failed:', detail);
  }
}

ui.bootstrap();
files.init();
monitor.init();
gestures.bind();
void initDesktop();
