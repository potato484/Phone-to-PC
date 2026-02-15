import { createControl } from './lib/control.js';
import { createGestures } from './lib/gestures.js';
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

ui.bootstrap();
gestures.bind();
