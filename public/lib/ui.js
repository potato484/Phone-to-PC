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
  normalizeSessionEntry,
  pruneSessionOffsets,
  readTokenFromHash,
  setActionButtonsEnabled,
  setSignalState,
  shortenSessionId,
  urlBase64ToUint8Array
} from './state.js';

export function createUi({ getControl, getTerm }) {
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
    bind() {
      if (!DOM.sessionTabs) {
        return;
      }
      DOM.sessionTabs.addEventListener('click', (event) => {
        const addButton = event.target.closest('.session-tab-add');
        if (addButton) {
          Actions.spawn();
          return;
        }
        const tab = event.target.closest('.session-tab[data-session-id]');
        if (!tab) {
          return;
        }
        const sessionId = tab.dataset.sessionId;
        if (!sessionId || sessionId === State.currentSessionId) {
          return;
        }
        const term = getTerm();
        if (!term) {
          return;
        }
        State.currentSessionId = sessionId;
        State.killRequested = false;
        StatusBar.setSession(sessionId);
        if (tab.dataset.cwd) {
          State.cwd = tab.dataset.cwd;
          StatusBar.setCwd(tab.dataset.cwd);
        }
        Actions.resetKillRequest();
        setActionButtonsEnabled(true);
        Actions.resetKillConfirm();
        this.renderActiveState();
        void term.connect(sessionId);
        term.scheduleResize();
        StatusBar.setText(`已切换到会话 ${shortenSessionId(sessionId)}`);
      });
    },

    renderActiveState() {
      if (!DOM.sessionTabs) {
        return;
      }
      DOM.sessionTabs.querySelectorAll('.session-tab[data-session-id]').forEach((button) => {
        const active = button.dataset.sessionId === State.currentSessionId;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    },

    update(list) {
      if (!DOM.sessionTabs) {
        return [];
      }
      const sessions = Array.isArray(list) ? list.map((item) => normalizeSessionEntry(item)).filter(Boolean) : [];
      pruneSessionOffsets(sessions.map((session) => session.id));
      DOM.sessionTabs.textContent = '';

      const fragment = document.createDocumentFragment();
      sessions.forEach((session) => {
        const button = document.createElement('button');
        const active = session.id === State.currentSessionId;
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
        fragment.appendChild(button);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'session-tab session-tab-add';
      add.setAttribute('aria-label', '添加新终端');
      add.title = '添加新终端';
      add.textContent = '+';
      fragment.appendChild(add);

      DOM.sessionTabs.appendChild(fragment);
      DOM.sessionTabs.hidden = false;
      return sessions;
    }
  };

  const Actions = {
    bind() {
      if (DOM.detachBtn) {
        DOM.detachBtn.addEventListener('click', () => this.detach());
      }
      if (DOM.killBtn) {
        DOM.killBtn.addEventListener('click', () => this.kill());
      }
    },

    resetKillRequest() {
      if (State.killRequestTimer) {
        window.clearTimeout(State.killRequestTimer);
        State.killRequestTimer = 0;
      }
      State.killInFlight = false;
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
      this.resetKillConfirm();
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

    detach() {
      const term = getTerm();
      if (!State.currentSessionId || !term) {
        return;
      }
      const detachedSession = State.currentSessionId;
      State.currentSessionId = '';
      State.killRequested = false;
      this.resetKillRequest();
      this.resetKillConfirm();
      StatusBar.setSession('');
      setActionButtonsEnabled(false);
      SessionTabs.renderActiveState();
      term.disconnect();
      if (State.terminal) {
        State.terminal.write('\x1bc');
      }
      StatusBar.setText(`已关闭会话 ${shortenSessionId(detachedSession)} 的终端连接`);
      Toast.show('终端已关闭，可点击会话标签重新附加', 'info');
    },

    resetKillConfirm() {
      if (State.killConfirmTimer) {
        window.clearTimeout(State.killConfirmTimer);
        State.killConfirmTimer = 0;
      }
      State.killConfirmArmed = false;
      if (DOM.killBtn) {
        DOM.killBtn.textContent = '终止会话';
        DOM.killBtn.classList.remove('is-confirm');
      }
    },

    kill() {
      const control = getControl();
      if (!State.currentSessionId || !control) {
        return;
      }
      if (State.killInFlight) {
        return;
      }
      if (!State.killConfirmArmed) {
        State.killConfirmArmed = true;
        if (DOM.killBtn) {
          DOM.killBtn.textContent = '确认终止';
          DOM.killBtn.classList.add('is-confirm');
        }
        StatusBar.setText('再次点击以确认终止');
        State.killConfirmTimer = window.setTimeout(() => {
          this.resetKillConfirm();
        }, 3000);
        return;
      }

      const ok = control.send({
        type: 'kill',
        sessionId: State.currentSessionId
      });
      this.resetKillConfirm();
      if (!ok) {
        Toast.show('终止请求发送失败', 'danger');
        return;
      }
      State.killRequested = true;
      State.killInFlight = true;
      setActionButtonsEnabled(false);
      StatusBar.setText('终止请求已发送，等待会话退出...');
      Toast.show('终止请求已发送', 'warn');
      State.killRequestTimer = window.setTimeout(() => {
        State.killRequestTimer = 0;
        if (!State.killInFlight || !State.currentSessionId) {
          return;
        }
        State.killInFlight = false;
        State.killRequested = false;
        setActionButtonsEnabled(true);
        StatusBar.setText('终止超时，可重试');
        Toast.show('终止超时，可再次尝试', 'warn');
      }, KILL_REQUEST_TIMEOUT_MS);
    },

    async initServiceWorker() {
      if (!('serviceWorker' in navigator)) {
        return;
      }
      try {
        State.serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
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
      const keyResp = await fetch(apiUrl('/api/vapid-public-key'));
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
        registration = await navigator.serviceWorker.register('/sw.js');
        State.serviceWorkerRegistration = registration;
      }

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        }));

      const saveResp = await fetch(apiUrl('/api/push/subscribe'), {
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
    bind() {
      if (!DOM.quickKeys) {
        return;
      }
      DOM.quickKeys.addEventListener('click', (event) => {
        const button = event.target.closest('[data-key]');
        if (!button) {
          return;
        }
        const sequence = QUICK_KEY_SEQUENCES[button.dataset.key];
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
      });
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
    init() {
      const hashToken = readTokenFromHash();
      if (hashToken) {
        localStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
        State.token = hashToken;
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        return;
      }
      State.token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }
  };

  const Runtime = {
    async load() {
      if (!State.token) {
        StatusBar.setCwd('-');
        return;
      }
      try {
        const response = await fetch(apiUrl('/api/runtime'));
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

    SessionTabs.bind();
    Dock.bind();
    Dock.updateHeight();
    QuickKeys.bind();
    bindSessionCopy();
    Actions.bind();
    Auth.init();
    term.init();
    Viewport.bind();
    Actions.initServiceWorker().catch(() => {});
    Runtime.load().finally(() => {
      control.connect();
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
    Viewport,
    Auth,
    Runtime,
    bindSessionCopy,
    bootstrap
  };
}
