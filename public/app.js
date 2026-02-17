import { createControl } from './lib/control.js';
import { createFiles } from './lib/files.js';
import { createGestures } from './lib/gestures.js';
import { createMonitor } from './lib/monitor.js';
import { createQualityMonitor } from './lib/quality.js';
import { createTerm } from './lib/term.js';
import { createUi } from './lib/ui.js';
import { State } from './lib/state.js';

let control = null;
let term = null;
let qualityMonitor = null;

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

const gestures = createGestures({
  getTerm,
  toast: ui.Toast
});

const files = createFiles({
  toast: ui.Toast,
  openTerminalAtPath: (cwd) => {
    ui.Actions.spawn({ cwd });
  }
});

const monitor = createMonitor({
  toast: ui.Toast
});

qualityMonitor = createQualityMonitor({
  sendHeartbeat(payload) {
    const channel = getControl();
    if (!channel || typeof channel.send !== 'function') {
      return false;
    }
    return channel.send(payload);
  },
  onSnapshot(snapshot) {
    monitor.setConnectionQuality(snapshot);
  }
});

control = createControl({
  term,
  sessionTabs: ui.SessionTabs,
  statusBar: ui.StatusBar,
  toast: ui.Toast,
  actions: ui.Actions,
  qualityMonitor
});

let deferredModulesInited = false;

function initDeferredModules() {
  if (deferredModulesInited) {
    return;
  }
  deferredModulesInited = true;
  files.init({ silentAuthRetry: true });
  monitor.init({ silentAuthRetry: true });
}

window.addEventListener(
  'c2p:authenticated',
  () => {
    initDeferredModules();
  },
  { passive: true }
);

const bootstrapResult = ui.bootstrap();
gestures.bind();

Promise.resolve(bootstrapResult).finally(() => {
  if (State.token) {
    initDeferredModules();
    return;
  }

  const timer = window.setInterval(() => {
    if (State.token) {
      window.clearInterval(timer);
      initDeferredModules();
    }
  }, 600);
});
