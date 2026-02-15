import { createControl } from './lib/control.js';
import { createDesktop } from './lib/desktop.js';
import { createFiles } from './lib/files.js';
import { createGestures } from './lib/gestures.js';
import { createMonitor } from './lib/monitor.js';
import { createTerm } from './lib/term.js';
import { createUi } from './lib/ui.js';

let control = null;
let term = null;

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

const desktop = createDesktop({
  getTerm,
  statusBar: ui.StatusBar,
  toast: ui.Toast
});

const files = createFiles({
  toast: ui.Toast
});

const monitor = createMonitor({
  toast: ui.Toast
});

ui.bootstrap();
desktop.init();
files.init();
monitor.init();
gestures.bind();
