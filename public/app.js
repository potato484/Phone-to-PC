import { createControl } from './lib/control.js';
import { createFiles } from './lib/files.js';
import { createGestures } from './lib/gestures.js';
import { createMonitor } from './lib/monitor.js';
import { createQualityMonitor } from './lib/quality.js';
import { createTelemetry } from './lib/telemetry.js';
import { createTerm } from './lib/term.js';
import { createUi } from './lib/ui.js';

let control = null;
let term = null;
let telemetry = null;
let qualityMonitor = null;

const getControl = () => control;
const getTerm = () => term;
const getTelemetry = () => telemetry;

const ui = createUi({ getControl, getTerm, getTelemetry });

telemetry = createTelemetry({
  toast: ui.Toast
});

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
  },
  telemetry
});

control = createControl({
  term,
  sessionTabs: ui.SessionTabs,
  statusBar: ui.StatusBar,
  toast: ui.Toast,
  actions: ui.Actions,
  qualityMonitor,
  telemetry
});

ui.bootstrap();
telemetry.init();
files.init();
monitor.init();
gestures.bind();
