import {
  clearPersistedAccessToken,
  DOM,
  KEYBOARD_VISIBLE_THRESHOLD_PX,
  KILL_REQUEST_TIMEOUT_MS,
  QUICK_KEY_SEQUENCES,
  State,
  ZOOM_RESIZE_MIN_INTERVAL_MS,
  ZOOM_SCALE_EPSILON,
  ZOOM_SETTLE_MS,
  apiUrl,
  authedFetch,
  normalizeSessionEntry,
  persistAccessToken,
  pruneSessionOffsets,
  readPersistedAccessToken,
  readTokenFromHash,
  setActionButtonsEnabled,
  setSignalState,
  shortenSessionId
} from './state.js';
import { createThemeManager } from './theme.js';
import {
  clampScrollDeltaToRemaining,
  shouldAutoAlignKeyboardViewport
} from './viewport-scroll-policy.js';
import { shouldScheduleZoomResize } from './viewport-zoom-policy.js';

const QUICK_KEY_ROWS = [
  [
    { id: 'ctrl-c', label: '^C' },
    { id: 'tab', label: 'Tab' },
    { id: 'shift-tab', label: '⇤' }
  ],
  [
    { id: 'up', label: '↑' },
    { id: 'down', label: '↓' },
    { id: 'left', label: '←' },
    { id: 'right', label: '→' },
    { id: '/', label: '/' },
    { id: 'enter', label: '⏎' }
  ]
];
const SERVICE_WORKER_URL = '/sw.js?v=60';
const LEGACY_QUICK_KEY_STORAGE_KEY = 'c2p_quick_keys_v1';
const SESSION_TAB_LONG_PRESS_MS = 520;
const SESSION_TAB_FOCUS_SUPPRESS_MS = 700;
const AUTH_TOKEN_WARN_LEAD_MS = 5 * 60 * 1000;
const AUTH_TOKEN_REFRESH_LEAD_MS = 2 * 60 * 1000;
const QUICK_KEYS_TOGGLE_TEXT_SHOW = '显示快捷键';
const QUICK_KEYS_TOGGLE_TEXT_HIDE = '隐藏快捷键';
const DOCK_TOGGLE_TEXT_SHOW = '展开控制面板';
const DOCK_TOGGLE_TEXT_HIDE = '收起控制面板';
const SIDE_ACTIONS_TOGGLE_TEXT_SHOW = '展开快捷操作';
const SIDE_ACTIONS_TOGGLE_TEXT_HIDE = '收起快捷操作';
const SIDE_ACTIONS_POSITION_STORAGE_KEY = 'c2p_side_actions_pos_v1';
const SIDE_ACTIONS_DRAG_THRESHOLD_PX = 8;
const SIDE_ACTIONS_VIEWPORT_MARGIN_PX = 6;
const SIDE_ACTIONS_CLICK_SUPPRESS_MS = 320;
const TERMINAL_CONTEXT_LINES = 8;
const KEYBOARD_INSET_APPLY_DELAY_MS = 120;
const DOCK_INPUT_PRESERVE_MS = 2000;
const UI_STATE_STORAGE_KEY = 'c2p_ui_state_v1';
const UI_STATE_WRITE_DEBOUNCE_MS = 120;
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
]);
const SERVICE_WORKER_DEBUG_BYPASS_QUERY_KEYS = ['debugGestures', 'noSW'];

function resolveSessionIcon(cli) {
  const normalized = typeof cli === 'string' ? cli.trim().toLowerCase() : '';
  if (!normalized || normalized === 'shell' || normalized === 'bash' || normalized === 'zsh') {
    return '>_';
  }
  if (normalized.includes('python')) {
    return 'Py';
  }
  if (normalized.includes('node') || normalized.includes('javascript')) {
    return 'JS';
  }
  if (normalized.includes('go')) {
    return 'Go';
  }
  return 'T';
}

function syncQuickKeysToggleVisual(button, visible) {
  if (!button) {
    return;
  }
  const nextVisible = !!visible;
  button.textContent = '⌨';
  button.setAttribute('aria-label', nextVisible ? QUICK_KEYS_TOGGLE_TEXT_HIDE : QUICK_KEYS_TOGGLE_TEXT_SHOW);
  button.title = nextVisible ? QUICK_KEYS_TOGGLE_TEXT_HIDE : QUICK_KEYS_TOGGLE_TEXT_SHOW;
  button.classList.toggle('is-active', nextVisible);
}

function syncDockHandleVisual(button, expanded) {
  if (!button) {
    return;
  }
  const nextExpanded = !!expanded;
  button.textContent = '⚙';
  button.setAttribute('aria-label', nextExpanded ? DOCK_TOGGLE_TEXT_HIDE : DOCK_TOGGLE_TEXT_SHOW);
  button.title = nextExpanded ? DOCK_TOGGLE_TEXT_HIDE : DOCK_TOGGLE_TEXT_SHOW;
  button.setAttribute('aria-pressed', nextExpanded ? 'true' : 'false');
  button.classList.toggle('is-active', nextExpanded);
}

function syncSideActionsToggleVisual(button, expanded) {
  if (!button) {
    return;
  }
  const nextExpanded = !!expanded;
  button.textContent = nextExpanded ? '✕' : '☰';
  button.setAttribute('aria-label', nextExpanded ? SIDE_ACTIONS_TOGGLE_TEXT_HIDE : SIDE_ACTIONS_TOGGLE_TEXT_SHOW);
  button.title = nextExpanded ? SIDE_ACTIONS_TOGGLE_TEXT_HIDE : SIDE_ACTIONS_TOGGLE_TEXT_SHOW;
  button.setAttribute('aria-pressed', nextExpanded ? 'true' : 'false');
  button.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
  button.classList.toggle('is-active', nextExpanded);
}

function isTruthyQueryValue(value) {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on';
}

function shouldBypassServiceWorkerInDebug() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    return SERVICE_WORKER_DEBUG_BYPASS_QUERY_KEYS.some((key) => isTruthyQueryValue(params.get(key)));
  } catch {
    return false;
  }
}

function isKeyboardInputTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.classList.contains('xterm-helper-textarea')) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return target.isContentEditable;
}

function isTerminalFocusTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return target.classList.contains('xterm-helper-textarea') || !!target.closest('#terminal-wrap');
}

function isDockFocusTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return !!target.closest('#dock');
}

function shouldPreserveDockInputFocus(target) {
  return isDockFocusTarget(target) && isKeyboardInputTarget(target);
}

function resolveKeyboardAlignmentScope(target) {
  if (shouldPreserveDockInputFocus(target)) {
    return 'dock-input';
  }
  if (isTerminalFocusTarget(target)) {
    return 'terminal';
  }
  return 'other';
}

function resolveActiveDockInputElement() {
  const active = document.activeElement;
  if (shouldPreserveDockInputFocus(active)) {
    return active;
  }
  if (State.lastDockInputElement && document.contains(State.lastDockInputElement)) {
    return State.lastDockInputElement;
  }
  return null;
}

function restoreDockInputFocus(inputEl) {
  if (!(inputEl instanceof HTMLElement)) {
    return;
  }
  if (!document.contains(inputEl)) {
    return;
  }
  const isTextInput = inputEl instanceof HTMLInputElement || inputEl instanceof HTMLTextAreaElement;
  const selectionStart = isTextInput && Number.isFinite(inputEl.selectionStart) ? inputEl.selectionStart : null;
  const selectionEnd = isTextInput && Number.isFinite(inputEl.selectionEnd) ? inputEl.selectionEnd : null;
  try {
    inputEl.focus({ preventScroll: true });
  } catch {
    inputEl.focus();
  }
  if (isTextInput && selectionStart !== null && selectionEnd !== null) {
    try {
      inputEl.setSelectionRange(selectionStart, selectionEnd);
    } catch {
      // ignore unsupported setSelectionRange for certain input types
    }
  }
}

function blurTerminalKeyboardInputIfFocused() {
  const active = document.activeElement;
  if (!isTerminalFocusTarget(active) || !isKeyboardInputTarget(active)) {
    return;
  }
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

function tryLockPortraitOrientation() {
  const orientation = window.screen && window.screen.orientation;
  if (!orientation || typeof orientation.lock !== 'function') {
    return;
  }
  orientation.lock('portrait-primary').catch(() => {
    // Ignore lock failures when browser does not allow programmatic orientation lock.
  });
}

export function createUi({ getControl, getTerm }) {
  let sessionCache = [];
  let preserveDockInputUntilMs = 0;
  let uiStateWriteTimer = 0;
  let keyboardAlignmentScope = '';
  State.lastDockInputElement = null;
  const Theme = createThemeManager();

  function readPersistedUiState() {
    try {
      const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function writePersistedUiState(nextState) {
    try {
      window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // Ignore storage write failures.
    }
  }

  function collectUiStateSnapshot() {
    const dockExpanded = !!(DOM.dock && DOM.dock.classList.contains('is-expanded'));
    const quickKeysVisible = !!(DOM.dock && DOM.dock.classList.contains('is-quick-keys-visible'));
    return {
      dockExpanded,
      quickKeysVisible,
      currentSessionId: State.currentSessionId || '',
      updatedAt: Date.now()
    };
  }

  function persistUiStateNow() {
    if (uiStateWriteTimer) {
      window.clearTimeout(uiStateWriteTimer);
      uiStateWriteTimer = 0;
    }
    writePersistedUiState(collectUiStateSnapshot());
  }

  function scheduleUiStatePersist() {
    if (uiStateWriteTimer) {
      window.clearTimeout(uiStateWriteTimer);
    }
    uiStateWriteTimer = window.setTimeout(() => {
      uiStateWriteTimer = 0;
      writePersistedUiState(collectUiStateSnapshot());
    }, UI_STATE_WRITE_DEBOUNCE_MS);
  }

  function restoreUiStateSnapshot() {
    const restored = readPersistedUiState();
    if (!restored) {
      return;
    }

    if (typeof restored.currentSessionId === 'string' && restored.currentSessionId) {
      State.currentSessionId = restored.currentSessionId;
      StatusBar.setSession(restored.currentSessionId);
    }
    if (restored.dockExpanded) {
      Dock.expand();
    } else {
      Dock.collapse();
    }
    if (restored.quickKeysVisible) {
      QuickKeys.setVisible(true, {
        skipMeasure: true,
        keepTerminalFocus: false
      });
    }
  }

  function bindUiStatePersistence() {
    window.addEventListener(
      'pagehide',
      () => {
        persistUiStateNow();
      },
      { passive: true }
    );
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') {
          persistUiStateNow();
        }
      },
      { passive: true }
    );
  }

  const Toast = {
    show(message, type = 'info', options = {}) {
      if (!message) {
        return;
      }

      const text = String(message);
      if (DOM.statusText && options.updateStatus !== false) {
        DOM.statusText.textContent = text;
      }

      if (!DOM.toastRoot || options.popup !== true) {
        return;
      }

      const toast = document.createElement('div');
      toast.className = `toast is-${type}`;
      toast.textContent = text;
      DOM.toastRoot.appendChild(toast);

      window.setTimeout(() => {
        toast.classList.add('is-leaving');
      }, 1800);

      window.setTimeout(() => {
        toast.remove();
      }, 2100);
    }
  };

  const StatusBar = {
    setControl(state) {
      const cls = state === 'online' ? 'is-online' : state === 'warn' ? 'is-warn' : 'is-offline';
      setSignalState(DOM.controlSignal, cls);
    },

    setTerminal(state) {
      const cls = state === 'online' ? 'is-online' : state === 'warn' ? 'is-warn' : 'is-offline';
      setSignalState(DOM.terminalSignal, cls);
    },

    setText(text) {
      if (DOM.statusText) {
        DOM.statusText.textContent = text;
      }
    },

    setCwd(cwd) {
      if (DOM.cwdText) {
        DOM.cwdText.textContent = cwd || '-';
      }
    },

    setSession(sessionId) {
      if (!DOM.sessionPill) {
        return;
      }
      if (!sessionId) {
        DOM.sessionPill.hidden = true;
        DOM.sessionPill.dataset.sessionId = '';
        scheduleUiStatePersist();
        return;
      }
      DOM.sessionPill.hidden = false;
      DOM.sessionPill.dataset.sessionId = sessionId;
      DOM.sessionPill.textContent = `会话 ${shortenSessionId(sessionId)}`;
      scheduleUiStatePersist();
    }
  };

  const Dock = {
    updateHeight() {
      if (!DOM.dock) {
        return;
      }
      const height = Math.ceil(DOM.dock.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--dock-height', `${height}px`);
      this.syncTerminalScrollReserve();
    },

    syncTerminalScrollReserve() {
      if (!DOM.dock) {
        document.documentElement.style.setProperty('--terminal-scroll-reserve', '0px');
        return 0;
      }
      const dockRect = DOM.dock.getBoundingClientRect();
      const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const visibleDockHeight = Math.max(
        0,
        Math.min(dockRect.bottom, viewportHeight) - Math.max(dockRect.top, 0)
      );
      const reserve = Math.max(0, Math.ceil(visibleDockHeight));
      document.documentElement.style.setProperty('--terminal-scroll-reserve', `${reserve}px`);
      return reserve;
    },

    scheduleMeasure() {
      if (State.dockMeasureRafId) {
        return;
      }
      State.dockMeasureRafId = window.requestAnimationFrame(() => {
        State.dockMeasureRafId = 0;
        this.updateHeight();
        const term = getTerm();
        if (term) {
          term.scheduleResize();
        }
      });
    },

    setKeyboardVisibility(visible) {
      if (!DOM.dock) {
        return;
      }
      const nextVisible = !!visible;
      if (nextVisible) {
        SideActions.collapse();
      }
      const hasRecentDockInput =
        preserveDockInputUntilMs > Date.now() &&
        State.lastDockInputElement &&
        document.contains(State.lastDockInputElement);
      const focusInsideDock = isDockFocusTarget(document.activeElement) || hasRecentDockInput;
      const useKeyboardDockMode = nextVisible && !focusInsideDock;
      DOM.dock.classList.toggle('is-keyboard-visible', useKeyboardDockMode);
      if (useKeyboardDockMode && DOM.dock.classList.contains('is-expanded')) {
        this.collapse();
        return;
      }
      this.scheduleMeasure();
    },

    ensureQuickKeysVisible() {
      if (
        !DOM.quickKeys ||
        !State.keyboardVisible ||
        !DOM.dock ||
        !DOM.dock.classList.contains('is-quick-keys-visible')
      ) {
        return;
      }
      const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const rect = DOM.quickKeys.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > viewportHeight) {
        DOM.quickKeys.scrollIntoView({
          block: 'nearest',
          inline: 'nearest'
        });
      }
    },

    ensureTerminalVisible() {
      if (DOM.terminalWrap) {
        const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const rect = DOM.terminalWrap.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > viewportHeight) {
          DOM.terminalWrap.scrollIntoView({
            block: 'nearest',
            inline: 'nearest'
          });
        }
      }
      const term = getTerm();
      if (term && typeof term.scrollActivePaneNearBottom === 'function') {
        term.scrollActivePaneNearBottom(TERMINAL_CONTEXT_LINES);
      }
    },

    expand() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dock.classList.add('is-expanded');
      DOM.dockHandle.setAttribute('aria-expanded', 'true');
      syncDockHandleVisual(DOM.dockHandle, true);
      this.scheduleMeasure();
      scheduleUiStatePersist();
    },

    collapse() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dock.classList.remove('is-expanded');
      DOM.dockHandle.setAttribute('aria-expanded', 'false');
      syncDockHandleVisual(DOM.dockHandle, false);
      this.scheduleMeasure();
      scheduleUiStatePersist();
    },

    toggle() {
      if (!DOM.dock) {
        return;
      }
      if (State.keyboardVisible) {
        return;
      }
      if (DOM.dock.classList.contains('is-expanded')) {
        this.collapse();
      } else {
        this.expand();
      }
    },

    bind() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      syncDockHandleVisual(DOM.dockHandle, DOM.dock.classList.contains('is-expanded'));
      DOM.dockHandle.addEventListener('click', () => this.toggle());

      let touchStartY = 0;
      DOM.dockHandle.addEventListener(
        'touchstart',
        (event) => {
          touchStartY = event.changedTouches[0].clientY;
        },
        { passive: true }
      );
      DOM.dockHandle.addEventListener(
        'touchend',
        (event) => {
          const touchEndY = event.changedTouches[0].clientY;
          const delta = touchEndY - touchStartY;
          if (delta < -18) {
            this.expand();
          }
          if (delta > 18) {
            this.collapse();
          }
        },
        { passive: true }
      );
      DOM.dock.addEventListener('transitionend', () => this.scheduleMeasure());
      window.addEventListener(
        'resize',
        () => {
          this.scheduleMeasure();
        },
        { passive: true }
      );
      window.addEventListener(
        'scroll',
        () => {
          this.syncTerminalScrollReserve();
        },
        { passive: true }
      );
      this.scheduleMeasure();
    }
  };

  const SideActions = {
    expanded: false,
    dragState: null,
    suppressToggleUntilMs: 0,

    readStoredPosition() {
      try {
        const raw = window.localStorage.getItem(SIDE_ACTIONS_POSITION_STORAGE_KEY);
        if (!raw) {
          return null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          return null;
        }
        const left = Number(parsed.left);
        const top = Number(parsed.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) {
          return null;
        }
        return { left, top };
      } catch {
        return null;
      }
    },

    writeStoredPosition(position) {
      if (!position) {
        return;
      }
      try {
        window.localStorage.setItem(
          SIDE_ACTIONS_POSITION_STORAGE_KEY,
          JSON.stringify({
            left: Math.round(position.left),
            top: Math.round(position.top)
          })
        );
      } catch {
        // Ignore storage write failures.
      }
    },

    clampPosition(position, size = {}) {
      const margin = SIDE_ACTIONS_VIEWPORT_MARGIN_PX;
      const viewportWidth = Math.max(
        0,
        Math.round(window.visualViewport ? Number(window.visualViewport.width) || window.innerWidth : window.innerWidth)
      );
      const viewportHeight = Math.max(
        0,
        Math.round(
          window.visualViewport ? Number(window.visualViewport.height) || window.innerHeight : window.innerHeight
        )
      );
      const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 44;
      const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 44;
      const minLeft = margin;
      const minTop = margin;
      const maxLeft = Math.max(minLeft, viewportWidth - width - margin);
      const maxTop = Math.max(minTop, viewportHeight - height - margin);
      return {
        left: Math.min(Math.max(minLeft, Number(position.left) || 0), maxLeft),
        top: Math.min(Math.max(minTop, Number(position.top) || 0), maxTop)
      };
    },

    applyPosition(position, options = {}) {
      if (!DOM.sideActions || !position) {
        return null;
      }
      const rect = DOM.sideActions.getBoundingClientRect();
      const clamped = this.clampPosition(position, {
        width: Number.isFinite(options.width) ? options.width : rect.width,
        height: Number.isFinite(options.height) ? options.height : rect.height
      });
      DOM.sideActions.style.left = `${Math.round(clamped.left)}px`;
      DOM.sideActions.style.top = `${Math.round(clamped.top)}px`;
      DOM.sideActions.style.right = 'auto';
      DOM.sideActions.style.bottom = 'auto';
      if (options.persist) {
        this.writeStoredPosition(clamped);
      }
      return clamped;
    },

    restorePosition() {
      const stored = this.readStoredPosition();
      if (!stored) {
        return;
      }
      this.applyPosition(stored, { persist: false });
    },

    nudgeIntoViewport(options = {}) {
      if (!DOM.sideActions) {
        return;
      }
      if (!DOM.sideActions.style.left || !DOM.sideActions.style.top) {
        return;
      }
      const rect = DOM.sideActions.getBoundingClientRect();
      this.applyPosition(
        {
          left: rect.left,
          top: rect.top
        },
        { persist: !!options.persist, width: rect.width, height: rect.height }
      );
    },

    setExpanded(expanded) {
      const nextExpanded = !!expanded;
      this.expanded = nextExpanded;
      if (DOM.sideActions) {
        DOM.sideActions.classList.toggle('is-expanded', nextExpanded);
      }
      if (DOM.sideActionsMenu) {
        DOM.sideActionsMenu.hidden = !nextExpanded;
      }
      syncSideActionsToggleVisual(DOM.sideActionsToggle, nextExpanded);
    },

    collapse() {
      this.setExpanded(false);
    },

    toggle() {
      this.setExpanded(!this.expanded);
    },

    beginDrag(event) {
      if (!DOM.sideActions || !DOM.sideActionsToggle) {
        return;
      }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        return;
      }
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      const rect = DOM.sideActions.getBoundingClientRect();
      this.dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        width: rect.width || 44,
        height: rect.height || 44,
        dragging: false
      };
      try {
        DOM.sideActionsToggle.setPointerCapture(event.pointerId);
      } catch {
        // Ignore pointer capture failures.
      }
    },

    updateDrag(event) {
      const dragState = this.dragState;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return false;
      }
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      if (!dragState.dragging) {
        const distance = Math.hypot(deltaX, deltaY);
        if (distance < SIDE_ACTIONS_DRAG_THRESHOLD_PX) {
          return false;
        }
        dragState.dragging = true;
        this.suppressToggleUntilMs = Date.now() + SIDE_ACTIONS_CLICK_SUPPRESS_MS;
        this.collapse();
        if (DOM.sideActions) {
          DOM.sideActions.classList.add('is-dragging');
          const collapsedRect = DOM.sideActions.getBoundingClientRect();
          dragState.width = collapsedRect.width || dragState.width;
          dragState.height = collapsedRect.height || dragState.height;
        }
      }
      this.applyPosition(
        {
          left: dragState.originLeft + deltaX,
          top: dragState.originTop + deltaY
        },
        {
          persist: false,
          width: dragState.width,
          height: dragState.height
        }
      );
      event.preventDefault();
      return true;
    },

    endDrag(event) {
      const dragState = this.dragState;
      if (!dragState) {
        return;
      }
      if (event && dragState.pointerId !== event.pointerId) {
        return;
      }
      this.dragState = null;
      if (DOM.sideActions) {
        DOM.sideActions.classList.remove('is-dragging');
      }
      if (dragState.dragging) {
        this.nudgeIntoViewport({ persist: true });
      }
      if (DOM.sideActionsToggle && event) {
        try {
          if (DOM.sideActionsToggle.hasPointerCapture(event.pointerId)) {
            DOM.sideActionsToggle.releasePointerCapture(event.pointerId);
          }
        } catch {
          // Ignore pointer capture release failures.
        }
      }
    },

    bind() {
      if (!DOM.sideActions || !DOM.sideActionsToggle || !DOM.sideActionsMenu) {
        return;
      }
      this.setExpanded(false);
      this.restorePosition();

      DOM.sideActionsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.suppressToggleUntilMs > Date.now()) {
          return;
        }
        this.toggle();
      });
      DOM.sideActionsToggle.addEventListener(
        'pointerdown',
        (event) => {
          this.beginDrag(event);
        },
        { passive: true }
      );
      DOM.sideActionsToggle.addEventListener(
        'pointermove',
        (event) => {
          this.updateDrag(event);
        },
        { passive: false }
      );
      DOM.sideActionsToggle.addEventListener('pointerup', (event) => {
        this.endDrag(event);
      });
      DOM.sideActionsToggle.addEventListener('pointercancel', (event) => {
        this.endDrag(event);
      });
      DOM.sideActionsToggle.addEventListener('lostpointercapture', (event) => {
        this.endDrag(event);
      });

      if (DOM.spawnSessionBtn) {
        DOM.spawnSessionBtn.addEventListener('click', (event) => {
          event.preventDefault();
          this.collapse();
          Actions.spawn();
        });
      }

      if (DOM.quickKeysToggle) {
        DOM.quickKeysToggle.addEventListener('click', () => {
          window.setTimeout(() => {
            this.collapse();
          }, 0);
        });
      }

      if (DOM.dockHandle) {
        DOM.dockHandle.addEventListener('click', () => {
          window.setTimeout(() => {
            this.collapse();
          }, 0);
        });
      }

      document.addEventListener(
        'pointerdown',
        (event) => {
          if (!this.expanded || !DOM.sideActions) {
            return;
          }
          if (event.target instanceof Node && DOM.sideActions.contains(event.target)) {
            return;
          }
          this.collapse();
        },
        { passive: true, capture: true }
      );

      document.addEventListener('keydown', (event) => {
        if (!this.expanded || event.key !== 'Escape') {
          return;
        }
        this.collapse();
      });
      window.addEventListener(
        'resize',
        () => {
          this.nudgeIntoViewport({ persist: true });
        },
        { passive: true }
      );
      if (window.visualViewport) {
        window.visualViewport.addEventListener(
          'resize',
          () => {
            this.nudgeIntoViewport({ persist: true });
          },
          { passive: true }
        );
      }
    }
  };

  const SessionTabs = {
    getById(sessionId) {
      return sessionCache.find((entry) => entry.id === sessionId) || null;
    },

    activateSession(sessionId, options = {}) {
      const { showStatusText = true, suppressKeyboardFocus = true } = options;
      if (!sessionId) {
        return;
      }
      const term = getTerm();
      if (!term) {
        return;
      }
      const blurTerminalInput = () => {
        blurTerminalKeyboardInputIfFocused();
        if (typeof term.blurActivePane === 'function') {
          term.blurActivePane();
        }
      };

      if (suppressKeyboardFocus) {
        if (typeof term.suppressActivePaneFocus === 'function') {
          term.suppressActivePaneFocus(SESSION_TAB_FOCUS_SUPPRESS_MS);
        }
        blurTerminalInput();
      }
      const session = this.getById(sessionId);
      State.currentSessionId = sessionId;
      State.killRequested = false;
      Actions.resetKillRequest();
      setActionButtonsEnabled(true);
      if (session && session.cwd) {
        State.cwd = session.cwd;
        StatusBar.setCwd(session.cwd);
      }
      StatusBar.setSession(sessionId);
      this.renderActiveState();
      void term.connect(sessionId, {
        cwd: session && session.cwd ? session.cwd : undefined
      });
      term.scheduleResize();
      if (showStatusText) {
        StatusBar.setText(`已切换到会话 ${shortenSessionId(sessionId)}`);
      }
    },

    switchByOffset(offset) {
      if (!Number.isFinite(offset) || offset === 0 || sessionCache.length === 0) {
        return false;
      }
      const currentIndex = sessionCache.findIndex((session) => session.id === State.currentSessionId);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const step = offset > 0 ? 1 : -1;
      const nextIndex = (startIndex + step + sessionCache.length) % sessionCache.length;
      const target = sessionCache[nextIndex];
      if (!target) {
        return false;
      }
      this.activateSession(target.id);
      return true;
    },

    openSessionInNewPane(sessionId) {
      if (!sessionId) {
        return false;
      }
      const term = getTerm();
      if (!term || typeof term.openSessionInNewPane !== 'function') {
        return false;
      }
      const session = this.getById(sessionId);
      const opened = term.openSessionInNewPane(sessionId, {
        cwd: session && session.cwd ? session.cwd : undefined
      });
      if (!opened) {
        return false;
      }
      State.currentSessionId = sessionId;
      State.killRequested = false;
      Actions.resetKillRequest();
      setActionButtonsEnabled(true);
      StatusBar.setSession(sessionId);
      if (session && session.cwd) {
        State.cwd = session.cwd;
        StatusBar.setCwd(session.cwd);
      }
      this.renderActiveState();
      StatusBar.setText(`会话 ${shortenSessionId(sessionId)} 已在新面板打开`);
      return true;
    },

    bind() {
      if (!DOM.sessionTabs) {
        return;
      }

      const MENU_MARGIN_PX = 8;
      const POINTER_MOVE_CANCEL_PX = 6;
      const allowMouseLongPressOpen =
        typeof window.matchMedia === 'function'
          ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
          : false;
      let longPressTimer = 0;
      let longPressSessionId = '';
      let longPressAction = '';
      let suppressClick = false;
      let pointerStartX = 0;
      let pointerStartY = 0;
      let pointerLastX = 0;
      let pointerLastY = 0;
      let deleteMenuEl = null;
      let deleteMenuSessionId = '';

      const clearLongPress = () => {
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };

      const clampDeleteMenuPosition = (x, y, menuWidth, menuHeight) => {
        const safeWidth = Number.isFinite(menuWidth) ? menuWidth : 0;
        const safeHeight = Number.isFinite(menuHeight) ? menuHeight : 0;
        const maxX = Math.max(MENU_MARGIN_PX, window.innerWidth - safeWidth - MENU_MARGIN_PX);
        const maxY = Math.max(MENU_MARGIN_PX, window.innerHeight - safeHeight - MENU_MARGIN_PX);
        return {
          x: Math.min(Math.max(MENU_MARGIN_PX, x), maxX),
          y: Math.min(Math.max(MENU_MARGIN_PX, y), maxY)
        };
      };

      const hideDeleteMenu = () => {
        deleteMenuSessionId = '';
        if (!deleteMenuEl) {
          return;
        }
        deleteMenuEl.hidden = true;
      };

      const ensureDeleteMenu = () => {
        if (deleteMenuEl) {
          return deleteMenuEl;
        }
        deleteMenuEl = document.createElement('div');
        deleteMenuEl.className = 'touch-context-menu session-tab-delete-menu';
        deleteMenuEl.hidden = true;
        deleteMenuEl.innerHTML = `
          <button type="button" class="touch-context-btn is-danger" data-action="delete-session">删除终端</button>
        `;
        document.body.appendChild(deleteMenuEl);

        deleteMenuEl.addEventListener('click', (event) => {
          const button =
            event.target instanceof Element ? event.target.closest('[data-action="delete-session"]') : null;
          if (!button) {
            return;
          }
          const sessionId = deleteMenuSessionId || '';
          hideDeleteMenu();
          if (!sessionId || sessionId !== State.currentSessionId || State.killInFlight) {
            return;
          }
          Actions.requestKill(sessionId);
        });

        const dismissOnOutsidePress = (event) => {
          if (!deleteMenuEl || deleteMenuEl.hidden) {
            return;
          }
          if (event.target instanceof Node && deleteMenuEl.contains(event.target)) {
            return;
          }
          hideDeleteMenu();
        };
        document.addEventListener('pointerdown', dismissOnOutsidePress, { passive: true, capture: true });
        document.addEventListener('click', dismissOnOutsidePress, { passive: true, capture: true });

        return deleteMenuEl;
      };

      const showDeleteMenu = (sessionId, clientX, clientY) => {
        const menu = ensureDeleteMenu();
        deleteMenuSessionId = sessionId || '';
        const deleteButton = menu.querySelector('[data-action="delete-session"]');
        const canDelete = !!sessionId && sessionId === State.currentSessionId && !State.killInFlight;
        if (deleteButton instanceof HTMLButtonElement) {
          deleteButton.disabled = !canDelete;
        }
        menu.hidden = false;
        menu.style.left = '0px';
        menu.style.top = '0px';
        const { width, height } = menu.getBoundingClientRect();
        const next = clampDeleteMenuPosition(clientX, clientY, width || 124, height || 46);
        menu.style.left = `${Math.round(next.x)}px`;
        menu.style.top = `${Math.round(next.y)}px`;
      };

      const resetLongPressTracking = () => {
        clearLongPress();
        longPressSessionId = '';
        longPressAction = '';
      };
      const suppressTerminalFocusFromSessionToolbar = () => {
        const term = getTerm();
        if (!term) {
          blurTerminalKeyboardInputIfFocused();
          return;
        }
        if (typeof term.suppressActivePaneFocus === 'function') {
          term.suppressActivePaneFocus(SESSION_TAB_FOCUS_SUPPRESS_MS);
        }
        if (typeof term.blurActivePane === 'function') {
          term.blurActivePane();
        } else {
          blurTerminalKeyboardInputIfFocused();
        }
      };

      DOM.sessionTabs.addEventListener(
        'touchstart',
        (event) => {
          if (!(event.target instanceof Element)) {
            return;
          }
          if (!event.target.closest('.session-tab')) {
            return;
          }
          suppressTerminalFocusFromSessionToolbar();
        },
        { passive: true, capture: true }
      );

      DOM.sessionTabs.addEventListener('click', (event) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (event.target instanceof Element && event.target.closest('.session-tab')) {
          suppressTerminalFocusFromSessionToolbar();
        }
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab) {
          hideDeleteMenu();
          return;
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId) {
          hideDeleteMenu();
          return;
        }
        if (sessionId === State.currentSessionId) {
          setActionButtonsEnabled(true);
          hideDeleteMenu();
          return;
        }
        hideDeleteMenu();
        this.activateSession(sessionId);
      });

      DOM.sessionTabs.addEventListener('pointerdown', (event) => {
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab) {
          hideDeleteMenu();
          resetLongPressTracking();
          return;
        }
        if (event.pointerType !== 'mouse') {
          suppressTerminalFocusFromSessionToolbar();
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId) {
          resetLongPressTracking();
          return;
        }
        hideDeleteMenu();
        resetLongPressTracking();
        pointerStartX = event.clientX;
        pointerStartY = event.clientY;
        pointerLastX = event.clientX;
        pointerLastY = event.clientY;
        longPressSessionId = sessionId;
        const useMouseLongPressOpen = allowMouseLongPressOpen && event.pointerType === 'mouse';
        if (!useMouseLongPressOpen && sessionId !== State.currentSessionId) {
          resetLongPressTracking();
          return;
        }
        longPressAction = useMouseLongPressOpen ? 'open-pane' : 'delete';
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          const targetSessionId = longPressSessionId;
          const action = longPressAction;
          longPressSessionId = '';
          longPressAction = '';
          if (!targetSessionId) {
            return;
          }
          suppressClick = true;
          if (action === 'open-pane') {
            this.openSessionInNewPane(targetSessionId);
            return;
          }
          showDeleteMenu(targetSessionId, pointerLastX, pointerLastY);
        }, SESSION_TAB_LONG_PRESS_MS);
      });

      DOM.sessionTabs.addEventListener('pointerup', resetLongPressTracking);
      DOM.sessionTabs.addEventListener('pointercancel', resetLongPressTracking);
      DOM.sessionTabs.addEventListener('lostpointercapture', resetLongPressTracking);
      DOM.sessionTabs.addEventListener(
        'pointermove',
        (event) => {
          if (!longPressTimer) {
            return;
          }
          pointerLastX = event.clientX;
          pointerLastY = event.clientY;
          const deltaX = Math.abs(event.clientX - pointerStartX);
          const deltaY = Math.abs(event.clientY - pointerStartY);
          if (deltaX > POINTER_MOVE_CANCEL_PX || deltaY > POINTER_MOVE_CANCEL_PX) {
            resetLongPressTracking();
          }
        },
        { passive: true }
      );
    },

    renderActiveState() {
      if (!DOM.sessionTabs) {
        return;
      }
      const pendingSessionId = State.killInFlight ? State.currentSessionId : '';
      DOM.sessionTabs.querySelectorAll('.session-tab-item[data-session-id]').forEach((item) => {
        const sessionId = item.dataset.sessionId || '';
        const tab = item.querySelector('.session-tab[data-session-id]');
        const active = sessionId === State.currentSessionId;
        const pending = !!pendingSessionId && sessionId === pendingSessionId;

        item.classList.toggle('is-active', active);
        item.classList.toggle('is-delete-pending', pending);

        if (tab) {
          tab.classList.toggle('is-active', active);
          tab.setAttribute('aria-selected', active ? 'true' : 'false');
        }
      });
    },

    update(list) {
      if (!DOM.sessionTabs) {
        return [];
      }
      const sessions = Array.isArray(list) ? list.map((item) => normalizeSessionEntry(item)).filter(Boolean) : [];
      sessionCache = sessions;
      pruneSessionOffsets(sessions.map((session) => session.id));
      DOM.sessionTabs.textContent = '';

      const fragment = document.createDocumentFragment();

      sessions.forEach((session, index) => {
        const active = session.id === State.currentSessionId;
        const pending = active && State.killInFlight;
        const terminalName = `终端${index + 1}`;

        const item = document.createElement('div');
        item.className = active ? 'session-tab-item is-active' : 'session-tab-item';
        item.dataset.sessionId = session.id;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = active ? 'session-tab is-active' : 'session-tab';
        button.dataset.sessionId = session.id;
        button.dataset.sessionIndex = String(index + 1);
        const cliLabel = session.cli || 'session';
        button.setAttribute('aria-label', terminalName);
        if (session.cwd) {
          button.dataset.cwd = session.cwd;
          button.title = `${terminalName}\n${session.cwd}`;
        } else {
          button.title = terminalName;
        }
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', active ? 'true' : 'false');

        const icon = document.createElement('span');
        icon.className = 'session-tab-icon';
        icon.textContent = resolveSessionIcon(cliLabel);
        button.appendChild(icon);

        const srLabel = document.createElement('span');
        srLabel.className = 'visually-hidden';
        srLabel.textContent = terminalName;
        button.appendChild(srLabel);

        item.appendChild(button);
        if (pending) {
          item.classList.add('is-delete-pending');
        }
        fragment.appendChild(item);
      });

      DOM.sessionTabs.appendChild(fragment);
      DOM.sessionTabs.hidden = false;
      this.renderActiveState();
      Dock.scheduleMeasure();
      return sessions;
    }
  };

  const Actions = {
    bind() {
    },

    resetKillRequest() {
      if (State.killRequestTimer) {
        window.clearTimeout(State.killRequestTimer);
        State.killRequestTimer = 0;
      }
      const wasKillInFlight = State.killInFlight;
      State.killInFlight = false;
      State.killTargetSessionId = '';
      if (wasKillInFlight) {
        SessionTabs.renderActiveState();
      }
    },

    spawn(options = {}) {
      const term = getTerm();
      const control = getControl();
      if (!term || !State.terminal) {
        Toast.show('终端尚未就绪', 'warn');
        return;
      }
      const preferredCwd = typeof options.cwd === 'string' ? options.cwd.trim() : '';
      this.resetKillRequest();
      State.killRequested = false;
      const ok = control
        ? control.send({
            type: 'spawn',
            cli: 'shell',
            cwd: preferredCwd || State.cwd || undefined,
            cols: State.terminal.cols,
            rows: State.terminal.rows
          })
        : false;
      if (!ok) {
        StatusBar.setText('控制通道未就绪');
        Toast.show('控制通道未就绪', 'warn');
        return;
      }
      StatusBar.setText('启动请求已发送');
      Dock.collapse();
    },

    requestKill(sessionId) {
      const control = getControl();
      const targetSessionId = sessionId || State.currentSessionId;
      if (!targetSessionId || !control || State.killInFlight) {
        return false;
      }
      const ok = control.send({
        type: 'kill',
        sessionId: targetSessionId
      });
      if (!ok) {
        StatusBar.setText('关闭请求发送失败');
        Toast.show('关闭请求发送失败', 'danger');
        return false;
      }

      const isCurrentSession = targetSessionId === State.currentSessionId;
      State.killRequested = isCurrentSession;
      State.killInFlight = true;
      State.killTargetSessionId = targetSessionId;

      if (isCurrentSession) {
        const term = getTerm();
        if (term && typeof term.handleSessionExit === 'function') {
          term.handleSessionExit(targetSessionId);
        }
        State.currentSessionId = '';
        StatusBar.setSession('');
      }
      sessionCache = sessionCache.filter((entry) => entry.id !== targetSessionId);
      SessionTabs.update(sessionCache);
      setActionButtonsEnabled(!!State.currentSessionId && !State.killInFlight);
      StatusBar.setText('关闭请求已发送');
      Toast.show('会话关闭中', 'warn');
      if (State.killRequestTimer) {
        window.clearTimeout(State.killRequestTimer);
      }
      State.killRequestTimer = window.setTimeout(() => {
        State.killRequestTimer = 0;
        if (!State.killInFlight) {
          return;
        }
        State.killInFlight = false;
        State.killRequested = false;
        State.killTargetSessionId = '';
        setActionButtonsEnabled(!!State.currentSessionId);
        SessionTabs.renderActiveState();
        StatusBar.setText('关闭操作仍在后台处理中，可刷新会话列表确认状态');
        Toast.show('关闭操作仍在后台处理中', 'warn');
      }, KILL_REQUEST_TIMEOUT_MS);
      return true;
    },

    async initServiceWorker() {
      if (!('serviceWorker' in navigator)) {
        return;
      }
      if (shouldBypassServiceWorkerInDebug()) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        } catch {
          // Ignore unregister failures in debug bypass mode.
        }
        try {
          if ('caches' in window) {
            const cacheKeys = await caches.keys();
            await Promise.all(cacheKeys.map((key) => caches.delete(key)));
          }
        } catch {
          // Ignore cache deletion failures in debug bypass mode.
        }
        StatusBar.setText('调试模式：已禁用离线缓存');
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);

        const requestSkipWaiting = (worker) => {
          if (!worker || typeof worker.postMessage !== 'function') {
            return;
          }
          worker.postMessage({ type: 'SKIP_WAITING' });
        };

        if (registration.waiting) {
          requestSkipWaiting(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) {
            return;
          }
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              requestSkipWaiting(installing);
            }
          });
        });

        let controllerChangeNotified = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (controllerChangeNotified) {
            return;
          }
          controllerChangeNotified = true;
          StatusBar.setText('应用已在后台更新，保持当前界面不中断');
          Toast.show('应用更新已生效，本次不会自动刷新页面', 'info');
        });
      } catch {
        StatusBar.setText('Service Worker 注册失败');
      }
    }
  };

  const QuickKeys = {
    pointerHandledUntilMsByKey: {},
    togglePointerHandledUntilMs: 0,
    visible: false,

    setVisible(visible, options = {}) {
      const { skipMeasure = false, keepTerminalFocus = false, preserveDockInputFocus = false } = options;
      const nextVisible = !!visible;
      const previousDockHeight = DOM.dock ? Math.ceil(DOM.dock.getBoundingClientRect().height) : 0;
      this.visible = nextVisible;
      if (DOM.dock) {
        DOM.dock.classList.toggle('is-quick-keys-visible', nextVisible);
      }
      Dock.syncTerminalScrollReserve();
      if (DOM.quickKeysToggle) {
        DOM.quickKeysToggle.setAttribute('aria-expanded', nextVisible ? 'true' : 'false');
        DOM.quickKeysToggle.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
        syncQuickKeysToggleVisual(DOM.quickKeysToggle, nextVisible);
      }
      scheduleUiStatePersist();
      if (!skipMeasure) {
        Dock.scheduleMeasure();
      }
      window.requestAnimationFrame(() => {
        if (keepTerminalFocus) {
          const term = getTerm();
          if (term && typeof term.focusActivePane === 'function') {
            term.focusActivePane();
          }
        }
        const nextDockHeight = DOM.dock ? Math.ceil(DOM.dock.getBoundingClientRect().height) : previousDockHeight;
        const reserve = Dock.syncTerminalScrollReserve();
        if (nextVisible && !preserveDockInputFocus) {
          const scrollDelta = Math.max(0, nextDockHeight - previousDockHeight, reserve);
          const scrollingEl = document.scrollingElement;
          const clampedScrollDelta = scrollingEl
            ? clampScrollDeltaToRemaining(scrollDelta, {
                scrollTop: scrollingEl.scrollTop,
                scrollHeight: scrollingEl.scrollHeight,
                clientHeight: scrollingEl.clientHeight
              })
            : scrollDelta;
          if (clampedScrollDelta > 0) {
            window.scrollBy({
              top: Math.ceil(clampedScrollDelta),
              left: 0,
              behavior: 'auto'
            });
          }
        }
        if (keepTerminalFocus && !preserveDockInputFocus) {
          Dock.ensureTerminalVisible();
        }
        if (nextVisible && !preserveDockInputFocus) {
          Dock.ensureQuickKeysVisible();
        }
      });
    },

    toggle(options = {}) {
      this.setVisible(!this.visible, options);
    },

    render() {
      if (!DOM.quickKeys) {
        return;
      }
      DOM.quickKeys.textContent = '';

      QUICK_KEY_ROWS.forEach((row, rowIndex) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'quick-key-row';
        rowEl.dataset.row = rowIndex === 0 ? 'control' : 'nav';
        row.forEach((entry) => {
          if (!QUICK_KEY_SEQUENCES[entry.id]) {
            return;
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'quick-key-btn';
          button.dataset.key = entry.id;
          button.textContent = entry.label;
          rowEl.appendChild(button);
        });
        DOM.quickKeys.appendChild(rowEl);
      });
    },

    runKeyById(keyId) {
      if (!keyId) {
        return false;
      }
      const sequence = QUICK_KEY_SEQUENCES[keyId];
      if (!sequence) {
        return false;
      }
      this.runSequence(sequence);
      return true;
    },

    markPointerHandled(keyId) {
      if (!keyId) {
        return;
      }
      this.pointerHandledUntilMsByKey[keyId] = Date.now() + 420;
    },

    wasPointerHandledRecently(keyId) {
      if (!keyId) {
        return false;
      }
      const until = this.pointerHandledUntilMsByKey[keyId];
      return Number.isFinite(until) && until > Date.now();
    },

    runSequence(sequence) {
      if (!sequence) {
        return;
      }
      const term = getTerm();
      const sent = term ? term.sendData(sequence) : false;
      if (!sent) {
        Toast.show('终端未连接', 'warn');
        return;
      }
      if (navigator.vibrate) {
        navigator.vibrate(10);
      }
    },

    bind() {
      if (!DOM.quickKeys) {
        return;
      }
      this.render();
      this.setVisible(false, { skipMeasure: true, keepTerminalFocus: false });
      if (DOM.quickKeysToggle) {
        syncQuickKeysToggleVisual(DOM.quickKeysToggle, this.visible);
      }
      if (DOM.quickKeysToggle) {
        const preserveDockInputFocus = (inputEl) => {
          if (!(inputEl instanceof HTMLElement)) {
            return;
          }
          State.lastDockInputElement = inputEl;
          preserveDockInputUntilMs = Date.now() + DOCK_INPUT_PRESERVE_MS;
          restoreDockInputFocus(inputEl);
          const focusBack = () => {
            if (!document.contains(inputEl)) {
              return;
            }
            if (document.activeElement === inputEl) {
              return;
            }
            restoreDockInputFocus(inputEl);
          };
          window.requestAnimationFrame(focusBack);
          window.setTimeout(focusBack, 120);
          window.setTimeout(focusBack, 260);
        };
        const getFocusedSearchInput = () => {
          if (!DOM.filesSearchInput) {
            return null;
          }
          return document.activeElement === DOM.filesSearchInput ? DOM.filesSearchInput : null;
        };
        const interceptWhenSearchFocused = (event) => {
          const focusedSearchInput = getFocusedSearchInput();
          if (!focusedSearchInput) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
          }
          preserveDockInputFocus(focusedSearchInput);
          return true;
        };

        DOM.quickKeysToggle.addEventListener('pointerdown', interceptWhenSearchFocused, { capture: true });
        DOM.quickKeysToggle.addEventListener('mousedown', interceptWhenSearchFocused, { capture: true });
        DOM.quickKeysToggle.addEventListener('touchstart', interceptWhenSearchFocused, {
          capture: true,
          passive: false
        });
        DOM.quickKeys.addEventListener('pointerdown', interceptWhenSearchFocused, { capture: true });
        DOM.quickKeys.addEventListener('mousedown', interceptWhenSearchFocused, { capture: true });
        DOM.quickKeys.addEventListener('touchstart', interceptWhenSearchFocused, { capture: true, passive: false });

        const onQuickKeysTogglePress = (event) => {
          if (this.togglePointerHandledUntilMs > Date.now()) {
            return;
          }
          const focusedSearchInput = getFocusedSearchInput();
          if (focusedSearchInput) {
            event.preventDefault();
            event.stopPropagation();
            preserveDockInputFocus(focusedSearchInput);
            return;
          }
          const dockInputEl = resolveActiveDockInputElement();
          const preserveInputFocus = !!dockInputEl;
          if (!preserveInputFocus) {
            blurTerminalKeyboardInputIfFocused();
          }
          event.preventDefault();
          this.togglePointerHandledUntilMs = Date.now() + 420;
          this.toggle({ keepTerminalFocus: false, preserveDockInputFocus: preserveInputFocus });
          SideActions.collapse();
          if (preserveInputFocus) {
            preserveDockInputFocus(dockInputEl);
          }
        };
        DOM.quickKeysToggle.addEventListener('pointerdown', onQuickKeysTogglePress);
        DOM.quickKeysToggle.addEventListener('mousedown', onQuickKeysTogglePress);
        DOM.quickKeysToggle.addEventListener('touchstart', onQuickKeysTogglePress, { passive: false });
        DOM.quickKeysToggle.addEventListener('click', (event) => {
          if (this.togglePointerHandledUntilMs > Date.now()) {
            return;
          }
          const focusedSearchInput = getFocusedSearchInput();
          if (focusedSearchInput) {
            event.preventDefault();
            event.stopPropagation();
            preserveDockInputFocus(focusedSearchInput);
            return;
          }
          const dockInputEl = resolveActiveDockInputElement();
          const preserveInputFocus = !!dockInputEl;
          if (!preserveInputFocus) {
            blurTerminalKeyboardInputIfFocused();
          }
          event.preventDefault();
          this.toggle({ keepTerminalFocus: false, preserveDockInputFocus: preserveInputFocus });
          SideActions.collapse();
          if (preserveInputFocus) {
            preserveDockInputFocus(dockInputEl);
          }
        });
      }

      DOM.quickKeys.addEventListener('pointerdown', (event) => {
        if (DOM.filesSearchInput && document.activeElement === DOM.filesSearchInput) {
          event.preventDefault();
          event.stopPropagation();
          preserveDockInputUntilMs = Date.now() + DOCK_INPUT_PRESERVE_MS;
          restoreDockInputFocus(DOM.filesSearchInput);
          return;
        }
        const button = event.target.closest('.quick-key-btn');
        if (!button) {
          return;
        }
        const key = button.dataset.key;
        if (!key) {
          return;
        }
        const dockInputEl = resolveActiveDockInputElement();
        event.preventDefault();
        this.markPointerHandled(key);
        this.runKeyById(key);
        if (dockInputEl) {
          preserveDockInputFocus(dockInputEl);
        }
      });

      DOM.quickKeys.addEventListener('click', (event) => {
        if (DOM.filesSearchInput && document.activeElement === DOM.filesSearchInput) {
          event.preventDefault();
          event.stopPropagation();
          preserveDockInputUntilMs = Date.now() + DOCK_INPUT_PRESERVE_MS;
          restoreDockInputFocus(DOM.filesSearchInput);
          return;
        }
        const button = event.target.closest('.quick-key-btn');
        if (!button) {
          return;
        }
        const key = button.dataset.key;
        if (!key) {
          return;
        }
        if (this.wasPointerHandledRecently(key)) {
          return;
        }
        const dockInputEl = resolveActiveDockInputElement();
        event.preventDefault();
        this.runKeyById(key);
        if (dockInputEl) {
          preserveDockInputFocus(dockInputEl);
        }
      });
    }
  };

  const Network = {
    bind() {
      window.addEventListener(
        'online',
        () => {
          StatusBar.setText('网络已恢复，正在重连...');
          Toast.show('网络已恢复，正在重连...', 'success');
          const control = getControl();
          if (control && typeof control.reconnectNow === 'function') {
            control.reconnectNow();
          }
          const term = getTerm();
          if (term && typeof term.forceReconnectNow === 'function') {
            term.forceReconnectNow();
          }
        },
        { passive: true }
      );
      window.addEventListener(
        'offline',
        () => {
          StatusBar.setText('网络离线，等待恢复...');
          Toast.show('网络离线，等待恢复...', 'warn');
        },
        { passive: true }
      );
    }
  };

  const Viewport = {
    lastAppliedViewportHeight: 0,
    lastAppliedViewportWidth: 0,

    clearZoomResizeRaf() {
      if (!State.zoomResizeRafId) {
        return;
      }
      window.cancelAnimationFrame(State.zoomResizeRafId);
      State.zoomResizeRafId = 0;
    },

    scheduleZoomResize() {
      if (State.zoomResizeRafId) {
        return;
      }
      State.zoomResizeRafId = window.requestAnimationFrame(() => {
        State.zoomResizeRafId = 0;
        const now = Date.now();
        if (
          State.zoomResizeLastRunAt > 0 &&
          now - State.zoomResizeLastRunAt < ZOOM_RESIZE_MIN_INTERVAL_MS
        ) {
          return;
        }
        State.zoomResizeLastRunAt = now;
        const term = getTerm();
        if (term) {
          term.scheduleResize(true);
        }
      });
    },

    clearZoomSettleTimer() {
      if (!State.zoomSettleTimer) {
        return;
      }
      window.clearTimeout(State.zoomSettleTimer);
      State.zoomSettleTimer = 0;
    },

    scheduleZoomSettleCheck() {
      this.clearZoomSettleTimer();
      State.zoomSettleTimer = window.setTimeout(() => {
        State.zoomSettleTimer = 0;
        if (!window.visualViewport) {
          State.zoomActive = false;
          State.zoomNoticeShown = false;
          State.zoomLastScale = 1;
          return;
        }
        const scale = Number(window.visualViewport.scale) || 1;
        if (Math.abs(scale - 1) > ZOOM_SCALE_EPSILON) {
          return;
        }
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        State.zoomLastScale = 1;
        this.applyInset('zoom-settle');
        const term = getTerm();
        if (term) {
          term.scheduleResize(true);
        }
      }, ZOOM_SETTLE_MS);
    },

    syncKeyboardVisibility(nextKeyboardVisible) {
      const visible = !!nextKeyboardVisible;
      const changed = visible !== State.keyboardVisible;
      State.keyboardVisible = visible;
      Dock.setKeyboardVisibility(visible);
      if (!visible && State.pendingResizeAfterKeyboard) {
        State.pendingResizeAfterKeyboard = false;
        const term = getTerm();
        if (term) {
          term.scheduleResize(true);
        }
      }
      return changed;
    },

    applyInset(reason = 'unknown') {
      if (!window.visualViewport) {
        this.clearZoomSettleTimer();
        this.clearZoomResizeRaf();
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        State.zoomResizeLastRunAt = 0;
        State.zoomLastScale = 1;
        this.lastAppliedViewportHeight = 0;
        this.lastAppliedViewportWidth = 0;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        State.viewportStableHeight = Math.max(0, window.innerHeight || 0);
        keyboardAlignmentScope = '';
        this.syncKeyboardVisibility(false);
        Dock.scheduleMeasure();
        return;
      }

      const viewport = window.visualViewport;
      const scale = Number(viewport.scale) || 1;
      const viewportHeight = Math.max(0, Math.round(Number(viewport.height) || window.innerHeight || 0));
      const viewportWidth = Math.max(0, Math.round(Number(viewport.width) || window.innerWidth || 0));
      const zoomed = Math.abs(scale - 1) > ZOOM_SCALE_EPSILON;
      if (zoomed) {
        const shouldResize = shouldScheduleZoomResize({
          currentScale: scale,
          previousScale: State.zoomLastScale || 1,
          viewportWidth,
          viewportHeight,
          previousViewportWidth: this.lastAppliedViewportWidth,
          previousViewportHeight: this.lastAppliedViewportHeight,
          scaleEpsilon: ZOOM_SCALE_EPSILON
        });
        State.zoomActive = true;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        State.pendingResizeAfterKeyboard = false;
        keyboardAlignmentScope = '';
        this.syncKeyboardVisibility(false);
        if (!State.zoomNoticeShown) {
          State.zoomNoticeShown = true;
          Toast.show('检测到页面缩放，正在自适配终端布局', 'warn');
        }
        this.scheduleZoomSettleCheck();
        if (shouldResize) {
          this.scheduleZoomResize();
        }
        this.lastAppliedViewportHeight = viewportHeight;
        this.lastAppliedViewportWidth = viewportWidth;
        State.zoomLastScale = scale;
        Dock.scheduleMeasure();
        return;
      }

      const wasZoomActive = State.zoomActive;
      this.clearZoomSettleTimer();
      this.clearZoomResizeRaf();
      State.zoomActive = false;
      State.zoomNoticeShown = false;
      State.zoomResizeLastRunAt = 0;
      State.zoomLastScale = 1;
      const activeElement = document.activeElement;
      const inputFocused = isKeyboardInputTarget(activeElement);
      if (!inputFocused || !State.viewportStableHeight) {
        State.viewportStableHeight = viewportHeight;
      }
      const stableHeight = State.viewportStableHeight || viewportHeight;
      const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      const keyboardFromInset = keyboardOffset > KEYBOARD_VISIBLE_THRESHOLD_PX;
      const keyboardFromResize =
        inputFocused && Math.max(0, stableHeight - viewportHeight) > KEYBOARD_VISIBLE_THRESHOLD_PX;
      const nextKeyboardVisible = keyboardFromInset || keyboardFromResize;
      const bottomOffset = keyboardFromInset ? Math.round(keyboardOffset) : 0;
      document.documentElement.style.setProperty('--dock-bottom-offset', `${bottomOffset}px`);
      const keyboardChanged = this.syncKeyboardVisibility(nextKeyboardVisible);
      if (!nextKeyboardVisible) {
        keyboardAlignmentScope = '';
      }
      const viewportHeightChanged = Math.abs(viewportHeight - this.lastAppliedViewportHeight) > 1;
      const viewportWidthChanged = Math.abs(viewportWidth - this.lastAppliedViewportWidth) > 1;
      const shouldResizeTerminal =
        reason !== 'zoom-settle' &&
        (keyboardChanged || viewportHeightChanged || viewportWidthChanged || wasZoomActive);
      if (shouldResizeTerminal) {
        const term = getTerm();
        if (term) {
          term.scheduleResize(keyboardChanged || wasZoomActive);
        }
      }
      const activeScope = resolveKeyboardAlignmentScope(activeElement);
      const shouldAutoAlign = shouldAutoAlignKeyboardViewport({
        keyboardVisible: nextKeyboardVisible,
        keyboardChanged,
        reason,
        activeScope,
        lastAlignedScope: keyboardAlignmentScope
      });
      if (shouldAutoAlign) {
        keyboardAlignmentScope = activeScope;
        window.requestAnimationFrame(() => {
          if (!State.keyboardVisible) {
            return;
          }
          const nextActiveScope = resolveKeyboardAlignmentScope(document.activeElement);
          if (nextActiveScope === 'dock-input') {
            Dock.ensureQuickKeysVisible();
            return;
          }
          Dock.ensureQuickKeysVisible();
          if (nextActiveScope === 'terminal') {
            Dock.ensureTerminalVisible();
          }
        });
      }
      this.lastAppliedViewportHeight = viewportHeight;
      this.lastAppliedViewportWidth = viewportWidth;
      Dock.scheduleMeasure();
    },

    bind() {
      this.applyInset('init');
      const scheduleDelayedInsetSync = (reason) => {
        window.setTimeout(() => {
          this.applyInset(reason);
        }, KEYBOARD_INSET_APPLY_DELAY_MS);
      };
      window.addEventListener('focusin', (event) => {
        if (shouldPreserveDockInputFocus(event.target)) {
          State.lastDockInputElement = event.target;
          preserveDockInputUntilMs = Date.now() + DOCK_INPUT_PRESERVE_MS;
        }
        if (!isKeyboardInputTarget(event.target)) {
          return;
        }
        scheduleDelayedInsetSync('focusin');
      });
      window.addEventListener('focusout', (event) => {
        if (!isKeyboardInputTarget(event.target)) {
          return;
        }
        const nextFocus = event.relatedTarget;
        if (
          event.target === DOM.filesSearchInput &&
          nextFocus instanceof Element &&
          (nextFocus.closest('#quick-keys-toggle') || nextFocus.closest('#quick-keys'))
        ) {
          preserveDockInputUntilMs = Date.now() + DOCK_INPUT_PRESERVE_MS;
          restoreDockInputFocus(DOM.filesSearchInput);
          return;
        }
        if (event.target === DOM.filesSearchInput && preserveDockInputUntilMs > Date.now()) {
          restoreDockInputFocus(DOM.filesSearchInput);
          return;
        }
        if (preserveDockInputUntilMs > Date.now() && isDockFocusTarget(event.target)) {
          return;
        }
        if (State.lastDockInputElement === event.target) {
          State.lastDockInputElement = null;
        }
        scheduleDelayedInsetSync('focusout');
      });
      if (DOM.terminalWrap) {
        DOM.terminalWrap.addEventListener(
          'pointerup',
          () => {
            window.setTimeout(() => {
              if (!isTerminalFocusTarget(document.activeElement)) {
                return;
              }
              this.applyInset('pointerup');
            }, KEYBOARD_INSET_APPLY_DELAY_MS);
          },
          { passive: true }
        );
      }
      if (!window.visualViewport) {
        return;
      }
      window.visualViewport.addEventListener(
        'resize',
        () => {
          this.applyInset('viewport-resize');
        },
        { passive: true }
      );
      window.visualViewport.addEventListener(
        'scroll',
        () => {
          this.applyInset('viewport-scroll');
        },
        { passive: true }
      );
    }
  };

  function clearTokenTimers() {
    if (State.tokenWarningTimer) {
      window.clearTimeout(State.tokenWarningTimer);
      State.tokenWarningTimer = 0;
    }
    if (State.tokenRefreshTimer) {
      window.clearTimeout(State.tokenRefreshTimer);
      State.tokenRefreshTimer = 0;
    }
  }

  function parseIsoMs(value) {
    if (typeof value !== 'string' || !value) {
      return 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function readErrorMessage(error) {
    if (!error || typeof error !== 'object' || !('message' in error)) {
      return '';
    }
    const raw = error.message;
    return typeof raw === 'string' ? raw : String(raw || '');
  }

  function describeAuthExchangeError(error) {
    const status = Number(
      error && typeof error === 'object' && 'status' in error ? error.status : Number.NaN
    );
    const code = String(error && typeof error === 'object' && 'code' in error ? error.code : '').toLowerCase();
    const rawMessage = readErrorMessage(error).toLowerCase();

    if (status === 401) {
      return {
        reason: 'unauthorized',
        status,
        toastMessage: '登录失败：token 无效或已过期'
      };
    }
    if (status === 429) {
      return {
        reason: 'rate_limited',
        status,
        toastMessage: '登录请求过于频繁，请稍后再试'
      };
    }
    if (code === 'network' || rawMessage.includes('failed to fetch') || rawMessage.includes('network')) {
      return {
        reason: 'network',
        status: 0,
        toastMessage: '网络连接失败，请检查网络后重试'
      };
    }
    return {
      reason: 'unknown',
      status: Number.isFinite(status) ? status : 0,
      toastMessage: '登录失败，请稍后重试'
    };
  }

  function applyAccessToken(accessToken, expiresAt = '') {
    State.token = accessToken;
    State.tokenExpiresAt = expiresAt || '';
    persistAccessToken(accessToken, State.tokenExpiresAt);
  }

  function clearAccessTokenState() {
    clearTokenTimers();
    State.token = '';
    State.tokenExpiresAt = '';
    clearPersistedAccessToken();
  }

  function scheduleTokenLifecycle() {
    clearTokenTimers();
    if (!State.token) {
      return;
    }

    const expiresAtMs = parseIsoMs(State.tokenExpiresAt);
    if (!expiresAtMs) {
      return;
    }

    const runRefresh = async () => {
      if (!State.token) {
        return;
      }
      try {
        const refreshed = await Auth.refreshAccessToken();
        applyAccessToken(refreshed.accessToken, refreshed.expiresAt);
        StatusBar.setText('访问令牌已自动刷新');
        scheduleTokenLifecycle();
      } catch (error) {
        clearAccessTokenState();
        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'unknown';
        StatusBar.setControl('offline');
        StatusBar.setText('访问令牌刷新失败，请重新使用 #token 链接登录');
        Toast.show(`令牌刷新失败: ${message}`, 'danger');
      }
    };

    const nowMs = Date.now();
    const warnDelayMs = expiresAtMs - AUTH_TOKEN_WARN_LEAD_MS - nowMs;
    if (warnDelayMs <= 0) {
      StatusBar.setText('访问令牌即将过期，正在自动刷新');
    } else {
      State.tokenWarningTimer = window.setTimeout(() => {
        State.tokenWarningTimer = 0;
        if (!State.token) {
          return;
        }
        StatusBar.setText('访问令牌即将过期，正在自动刷新');
      }, warnDelayMs);
    }

    const refreshDelayMs = expiresAtMs - AUTH_TOKEN_REFRESH_LEAD_MS - nowMs;
    if (refreshDelayMs <= 0) {
      void runRefresh();
      return;
    }

    State.tokenRefreshTimer = window.setTimeout(() => {
      State.tokenRefreshTimer = 0;
      void runRefresh();
    }, refreshDelayMs);
  }

  const Auth = {
    async exchangeBootstrapToken(bootstrapToken) {
      let response = null;
      try {
        response = await fetch(apiUrl('/api/auth/exchange'), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bootstrapToken}`
          }
        });
      } catch {
        const networkError = new Error('network request failed');
        networkError.code = 'network';
        throw networkError;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const reason = payload && typeof payload.error === 'string' ? payload.error : `auth exchange failed (${response.status})`;
        const exchangeError = new Error(reason);
        exchangeError.status = response.status;
        throw exchangeError;
      }
      const payload = await response.json();
      if (!payload || typeof payload.accessToken !== 'string' || !payload.accessToken) {
        throw new Error('invalid exchange response');
      }
      return {
        accessToken: payload.accessToken,
        expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : ''
      };
    },

    async refreshAccessToken() {
      const response = await authedFetch(apiUrl('/api/auth/refresh'), {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(`token refresh failed (${response.status})`);
      }
      const payload = await response.json();
      if (!payload || typeof payload.accessToken !== 'string' || !payload.accessToken) {
        throw new Error('invalid refresh response');
      }
      return {
        accessToken: payload.accessToken,
        expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : ''
      };
    },

    async init() {
      const hashToken = readTokenFromHash();
      if (hashToken) {
        try {
          const issued = await this.exchangeBootstrapToken(hashToken);
          applyAccessToken(issued.accessToken, issued.expiresAt);
          scheduleTokenLifecycle();
          Toast.show('认证成功，已建立访问会话', 'success');
        } catch (error) {
          const detail = describeAuthExchangeError(error);
          clearAccessTokenState();
          Toast.show(detail.toastMessage, 'danger');
        }
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        return !!State.token;
      }

      const persisted = readPersistedAccessToken();
      State.token = persisted.token;
      State.tokenExpiresAt = persisted.expiresAt;
      if (!State.token) {
        return false;
      }
      // Keep session/local storage in sync for crash/orientation recovery.
      persistAccessToken(State.token, State.tokenExpiresAt);

      if (!State.tokenExpiresAt) {
        try {
          const refreshed = await this.refreshAccessToken();
          applyAccessToken(refreshed.accessToken, refreshed.expiresAt);
        } catch {
          // Keep using existing token until server rejects it.
        }
      }
      scheduleTokenLifecycle();
      return true;
    }
  };

  const Runtime = {
    async load() {
      if (!State.token) {
        StatusBar.setCwd('-');
        return;
      }
      try {
        const response = await authedFetch(apiUrl('/api/runtime'));
        if (!response.ok) {
          throw new Error('runtime fetch failed');
        }
        const payload = await response.json();
        if (payload && typeof payload.cwd === 'string' && payload.cwd) {
          State.cwd = payload.cwd;
          StatusBar.setCwd(payload.cwd);
          return;
        }
      } catch {
        // keep existing cwd fallback
      }
      StatusBar.setCwd(State.cwd || '-');
    }
  };

  function bindSessionCopy() {
    if (!DOM.sessionPill) {
      return;
    }
    DOM.sessionPill.addEventListener('click', async () => {
      const sessionId = DOM.sessionPill.dataset.sessionId;
      if (!sessionId) {
        return;
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        Toast.show('当前环境不支持复制', 'warn');
        return;
      }
      try {
        await navigator.clipboard.writeText(sessionId);
        Toast.show('会话 ID 已复制', 'success');
      } catch {
        Toast.show('复制会话 ID 失败', 'danger');
      }
    });
  }

  function onActiveSessionChanged(sessionId) {
    State.currentSessionId = sessionId || '';
    const session = sessionId ? SessionTabs.getById(sessionId) : null;
    if (session && session.cwd) {
      State.cwd = session.cwd;
      StatusBar.setCwd(session.cwd);
    }
    StatusBar.setSession(sessionId || '');
    SessionTabs.renderActiveState();
    setActionButtonsEnabled(!!sessionId && !State.killInFlight);
  }

  function bootstrap() {
    const control = getControl();
    const term = getTerm();
    if (!control || !term) {
      StatusBar.setText('模块初始化失败');
      return Promise.resolve(false);
    }

    Theme.init();
    Theme.bindControls({
      themeSelect: DOM.prefThemeSelect,
      contrastSelect: DOM.prefContrastSelect,
      motionSelect: DOM.prefMotionSelect,
      transparencySelect: DOM.prefTransparencySelect
    });
    tryLockPortraitOrientation();

    StatusBar.setControl('offline');
    StatusBar.setTerminal('offline');
    StatusBar.setSession('');
    StatusBar.setText('初始化中...');
    StatusBar.setCwd('读取中...');
    setActionButtonsEnabled(false);
    window.localStorage.removeItem(LEGACY_QUICK_KEY_STORAGE_KEY);

    SessionTabs.bind();
    Dock.bind();
    Actions.bind();
    SideActions.bind();
    Dock.updateHeight();
    QuickKeys.bind();
    restoreUiStateSnapshot();
    bindUiStatePersistence();
    bindSessionCopy();
    const authReady = Auth.init()
      .finally(() => {
        term.init();
        Network.bind();
        Viewport.bind();
        Actions.initServiceWorker().catch(() => {});
        Runtime.load().finally(() => {
          if (State.token) {
            control.connect();
          } else {
            StatusBar.setControl('offline');
            StatusBar.setText('请使用带 #token 的链接登录');
          }
        });
      });
    window.setTimeout(() => {
      Dock.updateHeight();
      term.scheduleResize(true);
    }, 300);
    return authReady;
  }

  return {
    Toast,
    StatusBar,
    Dock,
    SessionTabs,
    Actions,
    QuickKeys,
    Network,
    Viewport,
    Auth,
    Runtime,
    bindSessionCopy,
    onActiveSessionChanged,
    bootstrap
  };
}
