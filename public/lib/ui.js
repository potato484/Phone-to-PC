import {
  DOM,
  KEYBOARD_VISIBLE_THRESHOLD_PX,
  KILL_REQUEST_TIMEOUT_MS,
  QUICK_KEY_SEQUENCES,
  State,
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
  shortenSessionId,
  urlBase64ToUint8Array
} from './state.js';

const QUICK_KEY_ROWS = [
  [
    { id: 'ctrl-c', label: '^C' },
    { id: 'tab', label: 'Tab' },
    { id: 'shift-tab', label: '⇤' },
    { id: 'esc', label: 'Esc' }
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
const SERVICE_WORKER_URL = '/sw.js?v=13';
const LEGACY_QUICK_KEY_STORAGE_KEY = 'c2p_quick_keys_v1';
const SESSION_TAB_LONG_PRESS_MS = 520;

export function createUi({ getControl, getTerm, getTelemetry }) {
  let sessionCache = [];

  const Toast = {
    show(message, type = 'info') {
      if (!DOM.toastRoot || !message) {
        return;
      }
      const toast = document.createElement('div');
      toast.className = `toast is-${type}`;
      toast.textContent = message;
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
      if (wasKillInFlight) {
        SessionTabs.renderActiveState();
      }
    },

    spawn() {
      const term = getTerm();
      const control = getControl();
      if (!term || !State.terminal) {
        Toast.show('终端尚未就绪', 'warn');
        return;
      }
      this.resetKillRequest();
      State.killRequested = false;
      const ok = control
        ? control.send({
            type: 'spawn',
            cli: 'shell',
            cwd: State.cwd || undefined,
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
      State.killRequested = targetSessionId === State.currentSessionId;
      State.killInFlight = true;
      setActionButtonsEnabled(false);
      SessionTabs.renderActiveState();
      StatusBar.setText('关闭请求已发送，等待会话退出...');
      Toast.show('关闭请求已发送', 'warn');
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
        setActionButtonsEnabled(!!State.currentSessionId);
        SessionTabs.renderActiveState();
        StatusBar.setText('关闭超时，可重试');
        Toast.show('关闭超时，可再次尝试', 'warn');
      }, KILL_REQUEST_TIMEOUT_MS);
      return true;
    },

    async initServiceWorker() {
      if (!('serviceWorker' in navigator)) {
        return;
      }
      try {
        State.serviceWorkerRegistration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      } catch {
        StatusBar.setText('Service Worker 注册失败');
      }
    },

    async requestPush(options = {}) {
      const {
        silentPermissionDenied = false,
        silentFailure = false,
        showSuccessToast = true
      } = options;
      if (State.pushRegistered) {
        if (!silentFailure && showSuccessToast) {
          Toast.show('通知已启用', 'info');
        }
        return;
      }
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        if (!silentFailure) {
          Toast.show('当前浏览器不支持推送通知', 'warn');
        }
        return;
      }
      const keyResp = await authedFetch(apiUrl('/api/vapid-public-key'));
      if (!keyResp.ok) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('vapid key fetch failed');
      }
      const keyData = await keyResp.json();
      if (!keyData.publicKey) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('missing public key');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (!silentPermissionDenied && !silentFailure) {
          Toast.show('通知权限未授予', 'warn');
        }
        return;
      }

      let registration = State.serviceWorkerRegistration;
      if (!registration) {
        registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
        State.serviceWorkerRegistration = registration;
      }

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        }));

      const saveResp = await authedFetch(apiUrl('/api/push/subscribe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(subscription)
      });

      if (!saveResp.ok) {
        if (!silentFailure) {
          Toast.show('通知订阅失败', 'danger');
        }
        throw new Error('subscribe save failed');
      }
      State.pushRegistered = true;
      if (showSuccessToast && !silentFailure) {
        Toast.show('通知订阅完成', 'success');
      }
    }
  };

  const QuickKeys = {
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
          const sequence = QUICK_KEY_SEQUENCES[entry.id];
          if (!sequence) {
            return;
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'quick-key-btn';
          button.dataset.sequence = sequence;
          button.dataset.key = entry.id;
          button.textContent = entry.label;
          rowEl.appendChild(button);
        });
        DOM.quickKeys.appendChild(rowEl);
      });
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

      DOM.quickKeys.addEventListener('click', (event) => {
        const button = event.target.closest('.quick-key-btn');
        if (!button) {
          return;
        }
        const sequence = button.dataset.sequence;
        if (!sequence) {
          return;
        }
        this.runSequence(sequence);
      });
    }
  };

  const TelemetryControls = {
    sync() {
      if (!DOM.telemetryOptIn) {
        return;
      }
      const telemetry = typeof getTelemetry === 'function' ? getTelemetry() : null;
      if (!telemetry || typeof telemetry.isEnabled !== 'function') {
        DOM.telemetryOptIn.checked = false;
        DOM.telemetryOptIn.disabled = true;
        return;
      }
      DOM.telemetryOptIn.disabled = false;
      DOM.telemetryOptIn.checked = telemetry.isEnabled();
    },

    bind() {
      this.sync();
      if (!DOM.telemetryOptIn) {
        return;
      }
      DOM.telemetryOptIn.addEventListener('change', () => {
        const telemetry = typeof getTelemetry === 'function' ? getTelemetry() : null;
        if (!telemetry || typeof telemetry.setEnabled !== 'function') {
          DOM.telemetryOptIn.checked = false;
          return;
        }
        telemetry.setEnabled(DOM.telemetryOptIn.checked);
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

    applyInset() {
      if (!window.visualViewport) {
        this.clearZoomSettleTimer();
        State.zoomActive = false;
        State.zoomNoticeShown = false;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        if (State.keyboardVisible) {
          State.keyboardVisible = false;
          if (State.pendingResizeAfterKeyboard) {
            State.pendingResizeAfterKeyboard = false;
            const term = getTerm();
            if (term) {
              term.scheduleResize(true);
            }
          }
        }
        Dock.scheduleMeasure();
        return;
      }

      const viewport = window.visualViewport;
      const scale = Number(viewport.scale) || 1;
      const zoomed = Math.abs(scale - 1) > ZOOM_SCALE_EPSILON;
      if (zoomed) {
        State.zoomActive = true;
        document.documentElement.style.setProperty('--dock-bottom-offset', '0px');
        if (State.keyboardVisible) {
          State.keyboardVisible = false;
          State.pendingResizeAfterKeyboard = false;
        }
        if (!State.zoomNoticeShown) {
          State.zoomNoticeShown = true;
          Toast.show('检测到页面缩放，已暂停终端重排', 'warn');
        }
        this.scheduleZoomSettleCheck();
        return;
      }

      this.clearZoomSettleTimer();
      State.zoomActive = false;
      const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--dock-bottom-offset', `${Math.round(keyboardOffset)}px`);

      const nextKeyboardVisible = keyboardOffset > KEYBOARD_VISIBLE_THRESHOLD_PX;
      if (nextKeyboardVisible !== State.keyboardVisible) {
        State.keyboardVisible = nextKeyboardVisible;
        if (!nextKeyboardVisible && State.pendingResizeAfterKeyboard) {
          State.pendingResizeAfterKeyboard = false;
          const term = getTerm();
          if (term) {
            term.scheduleResize(true);
          }
        }
      }
      if (!nextKeyboardVisible) {
        const term = getTerm();
        if (term) {
          term.scheduleResize();
        }
      }
      Dock.scheduleMeasure();
    },

    bind() {
      this.applyInset();
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

  const Auth = {
    async exchangeBootstrapToken(bootstrapToken) {
      const response = await fetch(apiUrl('/api/auth/exchange'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bootstrapToken}`
        }
      });
      if (!response.ok) {
        throw new Error(`auth exchange failed (${response.status})`);
      }
      const payload = await response.json();
      if (!payload || typeof payload.accessToken !== 'string' || !payload.accessToken) {
        throw new Error('invalid exchange response');
      }
      return payload.accessToken;
    },

    async init() {
      const hashToken = readTokenFromHash();
      if (hashToken) {
        try {
          const accessToken = await this.exchangeBootstrapToken(hashToken);
          window.sessionStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
          State.token = accessToken;
          Toast.show('认证成功，已建立访问会话', 'success');
        } catch (error) {
          window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          State.token = '';
          const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'unknown';
          Toast.show(`认证失败: ${message}`, 'danger');
        }
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        return;
      }
      State.token = window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
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
      return;
    }

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
    TelemetryControls.bind();
    bindSessionCopy();
    Actions.bind();
    Auth.init().finally(() => {
      term.init();
      window.requestAnimationFrame(() => {
        term.focusActivePane();
      });
      Network.bind();
      Viewport.bind();
      Actions.initServiceWorker().catch(() => {});
      Runtime.load().finally(() => {
        control.connect();
      });
    });
    window.setTimeout(() => {
      Dock.updateHeight();
      term.scheduleResize(true);
    }, 300);
  }

  return {
    Toast,
    StatusBar,
    Dock,
    SessionTabs,
    Actions,
    QuickKeys,
    TelemetryControls,
    Network,
    Viewport,
    Auth,
    Runtime,
    bindSessionCopy,
    onActiveSessionChanged,
    bootstrap
  };
}
