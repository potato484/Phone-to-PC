import {
  DOM,
  KEYBOARD_VISIBLE_THRESHOLD_PX,
  KILL_REQUEST_TIMEOUT_MS,
  QUICK_KEY_SEQUENCES,
  State,
  TOKEN_EXPIRES_AT_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
  ZOOM_SCALE_EPSILON,
  ZOOM_SETTLE_MS,
  apiUrl,
  authedFetch,
  normalizeSessionEntry,
  pruneSessionOffsets,
  readTokenFromHash,
  setActionButtonsEnabled,
  setSignalState,
  shortenSessionId
} from './state.js';
import { createThemeManager } from './theme.js';

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
const SERVICE_WORKER_URL = '/sw.js?v=28';
const LEGACY_QUICK_KEY_STORAGE_KEY = 'c2p_quick_keys_v1';
const SESSION_TAB_LONG_PRESS_MS = 520;
const AUTH_TOKEN_WARN_LEAD_MS = 5 * 60 * 1000;
const AUTH_TOKEN_REFRESH_LEAD_MS = 2 * 60 * 1000;
const QUICK_KEYS_TOGGLE_TEXT_SHOW = '显示快捷键';
const QUICK_KEYS_TOGGLE_TEXT_HIDE = '隐藏快捷键';
const TERMINAL_CONTEXT_LINES = 8;
const TERMINAL_VISUAL_BUFFER_PX = 96;
const TERMINAL_VISUAL_BUFFER_WITH_KEYBOARD_PX = 132;
const TERMINAL_VIEWPORT_BUFFER_RATIO = 0.18;
const KEYBOARD_INSET_APPLY_DELAY_MS = 120;
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

export function createUi({ getControl, getTerm }) {
  let sessionCache = [];
  const Theme = createThemeManager();

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
        return;
      }
      DOM.sessionPill.hidden = false;
      DOM.sessionPill.dataset.sessionId = sessionId;
      DOM.sessionPill.textContent = `会话 ${shortenSessionId(sessionId)}`;
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
      if (!DOM.dock || !DOM.quickKeys || !DOM.dock.classList.contains('is-quick-keys-visible')) {
        document.documentElement.style.setProperty('--terminal-scroll-reserve', '0px');
        return 0;
      }
      const quickKeysRect = DOM.quickKeys.getBoundingClientRect();
      const viewportHeight = Math.max(0, window.visualViewport ? window.visualViewport.height : window.innerHeight);
      const viewportBuffer = Math.max(
        TERMINAL_VISUAL_BUFFER_PX,
        Math.round(viewportHeight * TERMINAL_VIEWPORT_BUFFER_RATIO)
      );
      const extraBuffer = State.keyboardVisible
        ? Math.max(viewportBuffer, TERMINAL_VISUAL_BUFFER_WITH_KEYBOARD_PX)
        : viewportBuffer;
      const reserve = Math.max(0, Math.ceil(quickKeysRect.height + extraBuffer));
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
      DOM.dock.classList.toggle('is-keyboard-visible', nextVisible);
      if (nextVisible && DOM.dock.classList.contains('is-expanded')) {
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
        DOM.terminalWrap.scrollIntoView({
          block: 'nearest',
          inline: 'nearest'
        });
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
      this.scheduleMeasure();
    },

    collapse() {
      if (!DOM.dock || !DOM.dockHandle) {
        return;
      }
      DOM.dock.classList.remove('is-expanded');
      DOM.dockHandle.setAttribute('aria-expanded', 'false');
      this.scheduleMeasure();
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
      this.scheduleMeasure();
    }
  };

  const SessionTabs = {
    getById(sessionId) {
      return sessionCache.find((entry) => entry.id === sessionId) || null;
    },

    activateSession(sessionId, options = {}) {
      const { showStatusText = true } = options;
      if (!sessionId) {
        return;
      }
      const term = getTerm();
      if (!term) {
        return;
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

      const SWIPE_DELETE_WIDTH_PX = 84;
      const SWIPE_LOCK_THRESHOLD_PX = 8;
      const SWIPE_OPEN_THRESHOLD_PX = 34;
      const SWIPE_VERTICAL_TOLERANCE_PX = 24;

      let longPressTimer = 0;
      let longPressSessionId = '';
      let suppressClick = false;
      let pointerStartX = 0;
      let pointerStartY = 0;
      let swipePointerId = null;
      let swipeTarget = null;
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swipeStartOffset = 0;
      let swipeOffset = 0;
      let swipeGesture = '';

      const clearLongPress = () => {
        if (longPressTimer) {
          window.clearTimeout(longPressTimer);
          longPressTimer = 0;
        }
      };
      const closeSwipeActions = (exceptSessionId = '') => {
        DOM.sessionTabs.querySelectorAll('.session-tab-item.is-swipe-open').forEach((item) => {
          const sessionId = item.dataset.sessionId || '';
          if (exceptSessionId && sessionId === exceptSessionId) {
            return;
          }
          item.classList.remove('is-swipe-open', 'is-delete-pending', 'is-swiping');
          item.style.removeProperty('--swipe-offset');
        });
      };
      const beginSwipeTracking = (item, event) => {
        swipePointerId = event.pointerId;
        swipeTarget = item;
        swipeStartX = event.clientX;
        swipeStartY = event.clientY;
        swipeStartOffset = item.classList.contains('is-swipe-open') ? -SWIPE_DELETE_WIDTH_PX : 0;
        swipeOffset = swipeStartOffset;
        swipeGesture = 'pending';
        if (!item.classList.contains('is-swipe-open')) {
          closeSwipeActions(item.dataset.sessionId || '');
        }
      };
      const endSwipeTracking = ({ suppress = false } = {}) => {
        if (!swipeTarget) {
          swipePointerId = null;
          swipeGesture = '';
          swipeOffset = 0;
          swipeStartOffset = 0;
          return;
        }
        const target = swipeTarget;
        const pointerId = swipePointerId;
        target.classList.remove('is-swiping');
        target.style.removeProperty('--swipe-offset');
        if (swipeGesture === 'horizontal') {
          target.classList.toggle('is-swipe-open', swipeOffset <= -SWIPE_OPEN_THRESHOLD_PX);
          if (!target.classList.contains('is-swipe-open')) {
            target.classList.remove('is-delete-pending');
          }
          if (suppress) {
            suppressClick = true;
          }
        }
        if (Number.isInteger(pointerId) && target.hasPointerCapture && target.hasPointerCapture(pointerId)) {
          try {
            target.releasePointerCapture(pointerId);
          } catch {
            // ignore release failure
          }
        }
        swipePointerId = null;
        swipeTarget = null;
        swipeGesture = '';
        swipeOffset = 0;
        swipeStartOffset = 0;
      };

      DOM.sessionTabs.addEventListener('click', (event) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        const deleteButton = event.target.closest('.session-tab-delete[data-session-id]');
        if (deleteButton) {
          const sessionId = deleteButton.dataset.sessionId || '';
          if (!sessionId || sessionId !== State.currentSessionId || State.killInFlight) {
            return;
          }
          const sent = Actions.requestKill(sessionId);
          if (sent) {
            const item = deleteButton.closest('.session-tab-item[data-session-id]');
            if (item) {
              item.classList.add('is-swipe-open', 'is-delete-pending');
              item.style.removeProperty('--swipe-offset');
            }
          }
          return;
        }
        const addButton = event.target.closest('.session-tab-add');
        if (addButton) {
          closeSwipeActions();
          Actions.spawn();
          return;
        }
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab) {
          closeSwipeActions();
          return;
        }
        const tabItem = tab.closest('.session-tab-item[data-session-id]');
        if (tabItem && tabItem.classList.contains('is-swipe-open')) {
          tabItem.classList.remove('is-swipe-open', 'is-delete-pending');
          tabItem.style.removeProperty('--swipe-offset');
          return;
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId) {
          return;
        }
        if (sessionId === State.currentSessionId) {
          setActionButtonsEnabled(true);
          return;
        }
        closeSwipeActions();
        this.activateSession(sessionId);
      });

      DOM.sessionTabs.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') {
          return;
        }
        const tabItem = event.target.closest('.session-tab-item[data-session-id]');
        if (!tabItem) {
          closeSwipeActions();
          return;
        }
        beginSwipeTracking(tabItem, event);
        if (tabItem.setPointerCapture) {
          try {
            tabItem.setPointerCapture(event.pointerId);
          } catch {
            // ignore capture failure
          }
        }
      });

      DOM.sessionTabs.addEventListener('pointermove', (event) => {
        if (!swipeTarget || swipePointerId !== event.pointerId || event.pointerType === 'mouse') {
          return;
        }
        const deltaX = event.clientX - swipeStartX;
        const deltaY = event.clientY - swipeStartY;

        if (swipeGesture === 'pending') {
          if (Math.abs(deltaX) < SWIPE_LOCK_THRESHOLD_PX && Math.abs(deltaY) < SWIPE_LOCK_THRESHOLD_PX) {
            return;
          }
          const sessionId = swipeTarget.dataset.sessionId || '';
          const canSwipeDelete =
            sessionId &&
            sessionId === State.currentSessionId &&
            swipeTarget.classList.contains('is-active') &&
            !State.killInFlight;
          if (Math.abs(deltaY) > Math.abs(deltaX) || Math.abs(deltaY) > SWIPE_VERTICAL_TOLERANCE_PX) {
            swipeGesture = 'vertical';
            return;
          }
          if (!canSwipeDelete || (deltaX >= 0 && swipeStartOffset === 0)) {
            swipeGesture = 'blocked';
            return;
          }
          swipeGesture = 'horizontal';
          swipeTarget.classList.add('is-swiping');
        }
        if (swipeGesture !== 'horizontal') {
          return;
        }

        event.preventDefault();
        const nextOffset = Math.max(-SWIPE_DELETE_WIDTH_PX, Math.min(0, swipeStartOffset + deltaX));
        swipeOffset = nextOffset;
        swipeTarget.style.setProperty('--swipe-offset', `${nextOffset}px`);
      });

      const completeSwipeFromPointerEvent = (event, options = {}) => {
        if (!swipeTarget || swipePointerId !== event.pointerId) {
          return;
        }
        endSwipeTracking(options);
      };

      DOM.sessionTabs.addEventListener('pointerup', (event) => {
        completeSwipeFromPointerEvent(event, { suppress: swipeGesture === 'horizontal' });
      });
      DOM.sessionTabs.addEventListener('pointercancel', (event) => {
        completeSwipeFromPointerEvent(event, { suppress: swipeGesture === 'horizontal' });
      });
      DOM.sessionTabs.addEventListener('lostpointercapture', (event) => {
        completeSwipeFromPointerEvent(event, { suppress: swipeGesture === 'horizontal' });
      });

      const allowLongPressOpen =
        typeof window.matchMedia === 'function'
          ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
          : false;
      if (!allowLongPressOpen) {
        return;
      }

      DOM.sessionTabs.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'mouse') {
          return;
        }
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab || tab.classList.contains('session-tab-add')) {
          return;
        }
        if (tab.closest('.session-tab-item.is-swipe-open')) {
          return;
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId) {
          return;
        }
        clearLongPress();
        pointerStartX = event.clientX;
        pointerStartY = event.clientY;
        longPressSessionId = sessionId;
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0;
          if (!longPressSessionId) {
            return;
          }
          suppressClick = true;
          this.openSessionInNewPane(longPressSessionId);
          longPressSessionId = '';
        }, SESSION_TAB_LONG_PRESS_MS);
      });

      DOM.sessionTabs.addEventListener('pointerup', () => {
        clearLongPress();
        longPressSessionId = '';
      });
      DOM.sessionTabs.addEventListener('pointercancel', () => {
        clearLongPress();
        longPressSessionId = '';
      });
      DOM.sessionTabs.addEventListener(
        'pointermove',
        (event) => {
          if (!longPressTimer) {
            return;
          }
          const deltaX = Math.abs(event.clientX - pointerStartX);
          const deltaY = Math.abs(event.clientY - pointerStartY);
          if (deltaX > 6 || deltaY > 6) {
            clearLongPress();
            longPressSessionId = '';
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
        const deleteButton = item.querySelector('.session-tab-delete[data-session-id]');
        const active = sessionId === State.currentSessionId;
        const pending = !!pendingSessionId && sessionId === pendingSessionId;

        item.classList.toggle('is-active', active);
        item.classList.toggle('is-delete-pending', pending);
        if (!active) {
          item.classList.remove('is-swipe-open');
          item.style.removeProperty('--swipe-offset');
        }

        if (tab) {
          tab.classList.toggle('is-active', active);
          tab.setAttribute('aria-selected', active ? 'true' : 'false');
        }
        if (deleteButton) {
          deleteButton.disabled = pending || !active;
          deleteButton.setAttribute('aria-hidden', active ? 'false' : 'true');
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
      sessions.forEach((session) => {
        const active = session.id === State.currentSessionId;
        const pending = active && State.killInFlight;

        const item = document.createElement('div');
        item.className = active ? 'session-tab-item is-active' : 'session-tab-item';
        item.dataset.sessionId = session.id;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = active ? 'session-tab is-active' : 'session-tab';
        button.dataset.sessionId = session.id;
        if (session.cwd) {
          button.dataset.cwd = session.cwd;
          button.title = session.cwd;
        }
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        const cliLabel = session.cli || 'session';
        button.textContent = `${cliLabel} ${shortenSessionId(session.id)}`;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'session-tab-delete';
        deleteButton.dataset.sessionId = session.id;
        deleteButton.textContent = '删除';
        deleteButton.title = '删除会话';
        deleteButton.disabled = pending || !active;

        item.appendChild(button);
        item.appendChild(deleteButton);
        if (pending) {
          item.classList.add('is-delete-pending');
        }
        fragment.appendChild(item);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'session-tab session-tab-add';
      add.setAttribute('aria-label', '添加新终端');
      add.title = '添加新终端';
      add.textContent = '新建终端';
      fragment.appendChild(add);

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
      try {
        await navigator.serviceWorker.register(SERVICE_WORKER_URL);
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
      const { skipMeasure = false, keepTerminalFocus = true } = options;
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
        DOM.quickKeysToggle.textContent = nextVisible ? QUICK_KEYS_TOGGLE_TEXT_HIDE : QUICK_KEYS_TOGGLE_TEXT_SHOW;
      }
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
        if (nextVisible) {
          const scrollDelta = Math.max(0, nextDockHeight - previousDockHeight, reserve);
          if (scrollDelta > 0) {
            window.scrollBy({
              top: scrollDelta,
              left: 0,
              behavior: 'auto'
            });
          }
        }
        Dock.ensureTerminalVisible();
        if (nextVisible) {
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
        DOM.quickKeysToggle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          this.togglePointerHandledUntilMs = Date.now() + 420;
          this.toggle({ keepTerminalFocus: true });
        });
        DOM.quickKeysToggle.addEventListener('click', () => {
          if (this.togglePointerHandledUntilMs > Date.now()) {
            return;
          }
          this.toggle({ keepTerminalFocus: true });
        });
      }

      DOM.quickKeys.addEventListener('pointerdown', (event) => {
        const button = event.target.closest('.quick-key-btn');
        if (!button) {
          return;
        }
        const key = button.dataset.key;
        if (!key) {
          return;
        }
        event.preventDefault();
        this.markPointerHandled(key);
        this.runKeyById(key);
      });

      DOM.quickKeys.addEventListener('click', (event) => {
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
        this.runKeyById(key);
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
          return;
        }
        const scale = Number(window.visualViewport.scale) || 1;
        if (Math.abs(scale - 1) > ZOOM_SCALE_EPSILON) {
          return;
        }
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        this.applyInset();
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

    applyInset() {
      if (!window.visualViewport) {
        this.clearZoomSettleTimer();
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        State.viewportStableHeight = Math.max(0, window.innerHeight || 0);
        this.syncKeyboardVisibility(false);
        Dock.scheduleMeasure();
        return;
      }

      const viewport = window.visualViewport;
      const scale = Number(viewport.scale) || 1;
      const zoomed = Math.abs(scale - 1) > ZOOM_SCALE_EPSILON;
      if (zoomed) {
        State.zoomActive = true;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        State.pendingResizeAfterKeyboard = false;
        this.syncKeyboardVisibility(false);
        if (!State.zoomNoticeShown) {
          State.zoomNoticeShown = true;
          Toast.show('检测到页面缩放，已暂停终端重排', 'warn');
        }
        this.scheduleZoomSettleCheck();
        return;
      }

      this.clearZoomSettleTimer();
      State.zoomActive = false;
      const viewportHeight = Math.max(0, Math.round(Number(viewport.height) || window.innerHeight || 0));
      const inputFocused = isKeyboardInputTarget(document.activeElement);
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
      this.syncKeyboardVisibility(nextKeyboardVisible);
      if (!nextKeyboardVisible) {
        const term = getTerm();
        if (term) {
          term.scheduleResize();
        }
      } else {
        window.requestAnimationFrame(() => {
          Dock.ensureQuickKeysVisible();
        });
      }
      Dock.scheduleMeasure();
    },

    bind() {
      this.applyInset();
      const scheduleDelayedInsetSync = () => {
        window.setTimeout(() => {
          this.applyInset();
        }, KEYBOARD_INSET_APPLY_DELAY_MS);
      };
      window.addEventListener('focusin', (event) => {
        if (!isKeyboardInputTarget(event.target)) {
          return;
        }
        scheduleDelayedInsetSync();
      });
      window.addEventListener('focusout', (event) => {
        if (!isKeyboardInputTarget(event.target)) {
          return;
        }
        scheduleDelayedInsetSync();
      });
      if (DOM.terminalWrap) {
        DOM.terminalWrap.addEventListener(
          'pointerup',
          () => {
            window.setTimeout(() => {
              if (!isTerminalFocusTarget(document.activeElement)) {
                return;
              }
              this.applyInset();
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
          this.applyInset();
        },
        { passive: true }
      );
      window.visualViewport.addEventListener(
        'scroll',
        () => {
          this.applyInset();
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
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
    if (State.tokenExpiresAt) {
      window.sessionStorage.setItem(TOKEN_EXPIRES_AT_STORAGE_KEY, State.tokenExpiresAt);
    } else {
      window.sessionStorage.removeItem(TOKEN_EXPIRES_AT_STORAGE_KEY);
    }
  }

  function clearAccessTokenState() {
    clearTokenTimers();
    State.token = '';
    State.tokenExpiresAt = '';
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(TOKEN_EXPIRES_AT_STORAGE_KEY);
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

      State.token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
      State.tokenExpiresAt = window.sessionStorage.getItem(TOKEN_EXPIRES_AT_STORAGE_KEY) || '';
      if (!State.token) {
        return false;
      }

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

    StatusBar.setControl('offline');
    StatusBar.setTerminal('offline');
    StatusBar.setSession('');
    StatusBar.setText('初始化中...');
    StatusBar.setCwd('读取中...');
    setActionButtonsEnabled(false);
    window.localStorage.removeItem(LEGACY_QUICK_KEY_STORAGE_KEY);

    SessionTabs.bind();
    Dock.bind();
    Dock.updateHeight();
    QuickKeys.bind();
    bindSessionCopy();
    Actions.bind();
    const authReady = Auth.init()
      .finally(() => {
        term.init();
        window.requestAnimationFrame(() => {
          term.focusActivePane();
        });
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
