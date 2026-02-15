import RFB from '/vendor/novnc/lib/rfb.js';
import KeyTable from '/vendor/novnc/lib/input/keysym.js';
import { DOM, State, wsUrl } from './state.js';

const VIEW_MODE_STORAGE_KEY = 'c2p_view_mode_v1';
const DESKTOP_INPUT_STORAGE_KEY = 'c2p_desktop_input_mode_v1';
const DESKTOP_FPS_STORAGE_KEY = 'c2p_desktop_fps_v1';

const VIEW_TERMINAL = 'terminal';
const VIEW_DESKTOP = 'desktop';
const INPUT_TRACKPAD = 'trackpad';
const INPUT_DIRECT = 'direct';
const DEFAULT_FRAME_RATE = 15;
const CREDENTIAL_TYPE_USERNAME = 'username';
const CREDENTIAL_TYPE_PASSWORD = 'password';
const CREDENTIAL_TYPE_TARGET = 'target';
const CREDENTIAL_TYPE_SET = new Set([
  CREDENTIAL_TYPE_USERNAME,
  CREDENTIAL_TYPE_PASSWORD,
  CREDENTIAL_TYPE_TARGET
]);

const MODIFIER_CONFIG = {
  ctrl: {
    keysym: KeyTable.XK_Control_L,
    code: 'ControlLeft',
    button: () => DOM.desktopModCtrlBtn
  },
  alt: {
    keysym: KeyTable.XK_Alt_L,
    code: 'AltLeft',
    button: () => DOM.desktopModAltBtn
  },
  meta: {
    keysym: KeyTable.XK_Super_L,
    code: 'MetaLeft',
    button: () => DOM.desktopModMetaBtn
  }
};

function normalizeViewMode(value) {
  return value === VIEW_DESKTOP ? VIEW_DESKTOP : VIEW_TERMINAL;
}

function normalizeInputMode(value) {
  return value === INPUT_DIRECT ? INPUT_DIRECT : INPUT_TRACKPAD;
}

function normalizeFrameRate(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 60) {
    return DEFAULT_FRAME_RATE;
  }
  return parsed;
}

function readStorage(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function resolvePreset(frameRate) {
  if (frameRate <= 10) {
    return { quality: 4, compression: 8 };
  }
  if (frameRate <= 15) {
    return { quality: 6, compression: 6 };
  }
  if (frameRate <= 24) {
    return { quality: 7, compression: 4 };
  }
  return { quality: 8, compression: 2 };
}

export function createDesktop({ getTerm, statusBar, toast }) {
  let rfb = null;
  let viewMode = normalizeViewMode(readStorage(VIEW_MODE_STORAGE_KEY, VIEW_TERMINAL));
  let inputMode = normalizeInputMode(readStorage(DESKTOP_INPUT_STORAGE_KEY, INPUT_TRACKPAD));
  let frameRate = normalizeFrameRate(readStorage(DESKTOP_FPS_STORAGE_KEY, DEFAULT_FRAME_RATE));
  let credentialDialogCleanup = null;
  let credentialsPromptOpen = false;
  let lastCredentialUsername = '';
  let lastCredentialTarget = '';
  const modifiers = {
    ctrl: false,
    alt: false,
    meta: false
  };

  function updateDesktopStatus(text) {
    if (DOM.desktopStatusText) {
      DOM.desktopStatusText.textContent = text;
    }
  }

  function updatePlaceholder(text) {
    if (!DOM.desktopPlaceholder) {
      return;
    }
    DOM.desktopPlaceholder.hidden = false;
    DOM.desktopPlaceholder.textContent = text;
  }

  function hidePlaceholder() {
    if (DOM.desktopPlaceholder) {
      DOM.desktopPlaceholder.hidden = true;
    }
  }

  function normalizeCredentialTypes(types) {
    if (!Array.isArray(types)) {
      return [CREDENTIAL_TYPE_PASSWORD];
    }
    const normalized = [];
    const seen = new Set();
    for (const entry of types) {
      if (typeof entry !== 'string') {
        continue;
      }
      const value = entry.trim().toLowerCase();
      if (!CREDENTIAL_TYPE_SET.has(value) || seen.has(value)) {
        continue;
      }
      seen.add(value);
      normalized.push(value);
    }
    if (normalized.length === 0) {
      normalized.push(CREDENTIAL_TYPE_PASSWORD);
    }
    return normalized;
  }

  function hideCredentialDialog() {
    if (credentialDialogCleanup) {
      credentialDialogCleanup();
      credentialDialogCleanup = null;
    }
    credentialsPromptOpen = false;
  }

  function requestCredentialsWithPrompt(requiredTypes) {
    const credentials = {};
    if (requiredTypes.includes(CREDENTIAL_TYPE_USERNAME)) {
      const username = window.prompt('请输入 VNC 用户名', lastCredentialUsername || '');
      if (username === null) {
        return null;
      }
      credentials.username = username;
    }
    if (requiredTypes.includes(CREDENTIAL_TYPE_PASSWORD)) {
      const password = window.prompt('请输入 VNC 密码');
      if (password === null) {
        return null;
      }
      credentials.password = password;
    }
    if (requiredTypes.includes(CREDENTIAL_TYPE_TARGET)) {
      const target = window.prompt('请输入 VNC target', lastCredentialTarget || '');
      if (target === null) {
        return null;
      }
      credentials.target = target;
    }
    return credentials;
  }

  function requestCredentials(requiredTypes) {
    const normalizedTypes = normalizeCredentialTypes(requiredTypes);
    const modal = DOM.desktopCredentialsModal;
    const form = DOM.desktopCredentialsForm;
    const hint = DOM.desktopCredentialsHint;
    const usernameRow = DOM.desktopCredentialsUsernameRow;
    const passwordRow = DOM.desktopCredentialsPasswordRow;
    const targetRow = DOM.desktopCredentialsTargetRow;
    const usernameInput = DOM.desktopCredentialsUsername;
    const passwordInput = DOM.desktopCredentialsPassword;
    const targetInput = DOM.desktopCredentialsTarget;
    const cancelBtn = DOM.desktopCredentialsCancelBtn;

    if (
      !modal ||
      !form ||
      !hint ||
      !usernameRow ||
      !passwordRow ||
      !targetRow ||
      !usernameInput ||
      !passwordInput ||
      !targetInput
    ) {
      const fallback = requestCredentialsWithPrompt(normalizedTypes);
      if (!fallback) {
        return Promise.reject(new Error('credentials cancelled'));
      }
      return Promise.resolve(fallback);
    }

    hideCredentialDialog();
    credentialsPromptOpen = true;

    const needUsername = normalizedTypes.includes(CREDENTIAL_TYPE_USERNAME);
    const needPassword = normalizedTypes.includes(CREDENTIAL_TYPE_PASSWORD);
    const needTarget = normalizedTypes.includes(CREDENTIAL_TYPE_TARGET);
    const labelText = normalizedTypes
      .map((type) => {
        if (type === CREDENTIAL_TYPE_USERNAME) {
          return '用户名';
        }
        if (type === CREDENTIAL_TYPE_PASSWORD) {
          return '密码';
        }
        if (type === CREDENTIAL_TYPE_TARGET) {
          return 'target';
        }
        return type;
      })
      .join(' / ');
    hint.textContent = `VNC 要求提供：${labelText}`;

    usernameRow.hidden = !needUsername;
    passwordRow.hidden = !needPassword;
    targetRow.hidden = !needTarget;

    usernameInput.value = needUsername ? lastCredentialUsername : '';
    passwordInput.value = '';
    targetInput.value = needTarget ? lastCredentialTarget : '';

    return new Promise((resolve, reject) => {
      const close = () => {
        form.removeEventListener('submit', onSubmit);
        if (cancelBtn) {
          cancelBtn.removeEventListener('click', onCancel);
        }
        modal.removeEventListener('click', onOverlayClick);
        document.removeEventListener('keydown', onKeydown);
        modal.hidden = true;
        credentialsPromptOpen = false;
        if (credentialDialogCleanup === close) {
          credentialDialogCleanup = null;
        }
      };

      const onCancel = (event) => {
        if (event) {
          event.preventDefault();
        }
        close();
        reject(new Error('credentials cancelled'));
      };

      const onSubmit = (event) => {
        event.preventDefault();
        const credentials = {};

        if (needUsername) {
          const value = usernameInput.value.trim();
          if (!value) {
            usernameInput.focus();
            toast.show('请输入用户名', 'warn');
            return;
          }
          credentials.username = value;
          lastCredentialUsername = value;
        }

        if (needPassword) {
          const value = passwordInput.value;
          if (!value) {
            passwordInput.focus();
            toast.show('请输入密码', 'warn');
            return;
          }
          credentials.password = value;
        }

        if (needTarget) {
          const value = targetInput.value.trim();
          if (!value) {
            targetInput.focus();
            toast.show('请输入 target', 'warn');
            return;
          }
          credentials.target = value;
          lastCredentialTarget = value;
        }

        close();
        resolve(credentials);
      };

      const onOverlayClick = (event) => {
        if (event.target === modal) {
          onCancel(event);
        }
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          onCancel(event);
        }
      };

      credentialDialogCleanup = close;
      form.addEventListener('submit', onSubmit);
      if (cancelBtn) {
        cancelBtn.addEventListener('click', onCancel);
      }
      modal.addEventListener('click', onOverlayClick);
      document.addEventListener('keydown', onKeydown);

      modal.hidden = false;
      window.requestAnimationFrame(() => {
        if (needPassword) {
          passwordInput.focus();
          return;
        }
        if (needUsername) {
          usernameInput.focus();
          return;
        }
        if (needTarget) {
          targetInput.focus();
        }
      });
    });
  }

  function updateViewButtons() {
    if (DOM.viewTerminalBtn) {
      DOM.viewTerminalBtn.classList.toggle('is-active', viewMode === VIEW_TERMINAL);
      DOM.viewTerminalBtn.setAttribute('aria-selected', viewMode === VIEW_TERMINAL ? 'true' : 'false');
    }
    if (DOM.viewDesktopBtn) {
      DOM.viewDesktopBtn.classList.toggle('is-active', viewMode === VIEW_DESKTOP);
      DOM.viewDesktopBtn.setAttribute('aria-selected', viewMode === VIEW_DESKTOP ? 'true' : 'false');
    }
  }

  function setModifierButtonState(name, active) {
    const config = MODIFIER_CONFIG[name];
    const button = config ? config.button() : null;
    if (!button) {
      return;
    }
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function setDesktopConnected(connected) {
    State.desktopConnected = !!connected;
    if (DOM.desktopConnectBtn) {
      DOM.desktopConnectBtn.textContent = connected ? '断开桌面' : '连接桌面';
      DOM.desktopConnectBtn.classList.toggle('is-online', connected);
    }
    if (DOM.desktopSurface) {
      DOM.desktopSurface.dataset.connection = connected ? 'online' : 'offline';
    }
  }

  function applyInputMode() {
    if (DOM.desktopInputTrackpadBtn) {
      const active = inputMode === INPUT_TRACKPAD;
      DOM.desktopInputTrackpadBtn.classList.toggle('is-active', active);
      DOM.desktopInputTrackpadBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (DOM.desktopInputDirectBtn) {
      const active = inputMode === INPUT_DIRECT;
      DOM.desktopInputDirectBtn.classList.toggle('is-active', active);
      DOM.desktopInputDirectBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    if (!rfb) {
      return;
    }
    try {
      rfb.dragViewport = inputMode === INPUT_TRACKPAD;
      rfb.showDotCursor = inputMode === INPUT_TRACKPAD;
    } catch {
      // ignore rfb property incompatibility
    }
  }

  function applyFrameRateSettings() {
    if (DOM.desktopFpsSelect) {
      DOM.desktopFpsSelect.value = String(frameRate);
    }
    if (!rfb) {
      return;
    }

    const preset = resolvePreset(frameRate);
    try {
      rfb.frameRate = frameRate;
    } catch {
      // ignore frame rate incompatibility
    }
    try {
      rfb.qualityLevel = preset.quality;
      rfb.compressionLevel = preset.compression;
    } catch {
      // ignore quality/compression incompatibility
    }
  }

  function setModifier(name, active, sendRemote = true) {
    if (!Object.prototype.hasOwnProperty.call(modifiers, name)) {
      return;
    }
    const next = !!active;
    if (modifiers[name] === next) {
      return;
    }
    modifiers[name] = next;
    setModifierButtonState(name, next);
    const config = MODIFIER_CONFIG[name];
    if (!config || !sendRemote || !rfb) {
      return;
    }
    try {
      rfb.sendKey(config.keysym, config.code, next);
    } catch {
      // ignore send failure for stale remote session
    }
  }

  function clearModifiers(sendRemote = true) {
    setModifier('ctrl', false, sendRemote);
    setModifier('alt', false, sendRemote);
    setModifier('meta', false, sendRemote);
  }

  function disconnectDesktop(options = {}) {
    const { silent = false } = options;
    hideCredentialDialog();
    const activeRfb = rfb;
    rfb = null;
    State.desktopRfb = null;
    clearModifiers(true);
    if (activeRfb) {
      try {
        activeRfb.disconnect();
      } catch {
        // ignore disconnect failures on dead sockets
      }
    }
    setDesktopConnected(false);
    updatePlaceholder('桌面未连接');
    updateDesktopStatus('未连接');
    if (!silent && viewMode === VIEW_DESKTOP) {
      statusBar.setText('桌面已断开');
      toast.show('桌面连接已断开', 'info');
    }
  }

  function connectDesktop() {
    if (!State.token) {
      toast.show('缺少 token，无法连接桌面', 'warn');
      return;
    }
    if (!DOM.desktopCanvas) {
      toast.show('桌面容器不可用', 'danger');
      return;
    }

    if (rfb) {
      disconnectDesktop({ silent: true });
    }
    hideCredentialDialog();

    updateDesktopStatus('连接中...');
    updatePlaceholder('正在连接桌面...');
    if (DOM.desktopSurface) {
      DOM.desktopSurface.dataset.connection = 'connecting';
    }
    statusBar.setText('正在连接桌面...');

    const url = wsUrl('/ws/desktop', {
      fps: frameRate,
      mode: inputMode
    });

    let nextRfb = null;
    try {
      nextRfb = new RFB(DOM.desktopCanvas, url, {
        shared: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to create desktop client';
      updateDesktopStatus('连接失败');
      updatePlaceholder('桌面连接失败');
      statusBar.setText('桌面连接失败');
      toast.show(`桌面初始化失败: ${message}`, 'danger');
      return;
    }

    rfb = nextRfb;
    State.desktopRfb = nextRfb;
    setDesktopConnected(false);

    try {
      nextRfb.scaleViewport = true;
      nextRfb.resizeSession = false;
      nextRfb.focusOnClick = true;
      nextRfb.clipViewport = false;
    } catch {
      // ignore incompatible runtime options
    }
    applyInputMode();
    applyFrameRateSettings();

    nextRfb.addEventListener('connect', () => {
      if (rfb !== nextRfb) {
        return;
      }
      hideCredentialDialog();
      setDesktopConnected(true);
      hidePlaceholder();
      updateDesktopStatus('已连接');
      if (viewMode === VIEW_DESKTOP) {
        statusBar.setText('桌面已连接');
        toast.show('桌面连接成功', 'success');
      }
    });

    nextRfb.addEventListener('disconnect', (event) => {
      if (rfb !== nextRfb) {
        return;
      }
      hideCredentialDialog();
      const clean = !!(event && event.detail && event.detail.clean);
      rfb = null;
      State.desktopRfb = null;
      clearModifiers(false);
      setDesktopConnected(false);
      updateDesktopStatus(clean ? '已断开' : '连接中断');
      updatePlaceholder(clean ? '桌面已断开' : '桌面连接中断');
      if (viewMode === VIEW_DESKTOP) {
        statusBar.setText(clean ? '桌面已断开' : '桌面连接中断');
        if (!clean) {
          toast.show('桌面连接中断，可重试', 'warn');
        }
      }
    });

    nextRfb.addEventListener('securityfailure', (event) => {
      if (rfb !== nextRfb) {
        return;
      }
      const reason =
        event && event.detail && typeof event.detail.reason === 'string' ? event.detail.reason.trim() : '';
      statusBar.setText('桌面安全协商失败');
      updateDesktopStatus('安全协商失败');
      toast.show(reason ? `桌面安全协商失败：${reason}` : '桌面安全协商失败', 'danger');
    });

    nextRfb.addEventListener('credentialsrequired', async (event) => {
      if (rfb !== nextRfb) {
        return;
      }
      if (credentialsPromptOpen) {
        return;
      }
      statusBar.setText('桌面需要认证凭据');
      updateDesktopStatus('需要认证');
      const requiredTypes =
        event && event.detail && Array.isArray(event.detail.types) ? event.detail.types : [CREDENTIAL_TYPE_PASSWORD];
      try {
        const credentials = await requestCredentials(requiredTypes);
        if (rfb !== nextRfb) {
          return;
        }
        nextRfb.sendCredentials(credentials);
        updateDesktopStatus('认证中...');
        statusBar.setText('已提交桌面认证信息');
      } catch {
        if (rfb !== nextRfb) {
          return;
        }
        updateDesktopStatus('认证已取消');
        statusBar.setText('已取消桌面认证');
        toast.show('已取消桌面认证', 'warn');
        disconnectDesktop({ silent: true });
      }
    });
  }

  function sendCtrlAltDel() {
    if (!rfb) {
      toast.show('桌面未连接', 'warn');
      return;
    }
    try {
      if (typeof rfb.sendCtrlAltDel === 'function') {
        rfb.sendCtrlAltDel();
      } else {
        rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true);
        rfb.sendKey(KeyTable.XK_Alt_L, 'AltLeft', true);
        rfb.sendKey(KeyTable.XK_Delete, 'Delete', true);
        rfb.sendKey(KeyTable.XK_Delete, 'Delete', false);
        rfb.sendKey(KeyTable.XK_Alt_L, 'AltLeft', false);
        rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
      }
      toast.show('已发送 Ctrl+Alt+Del', 'info');
    } catch {
      toast.show('发送 Ctrl+Alt+Del 失败', 'danger');
    }
  }

  function setView(nextMode, options = {}) {
    const { autoConnect = true } = options;
    viewMode = normalizeViewMode(nextMode);
    State.currentViewMode = viewMode;
    writeStorage(VIEW_MODE_STORAGE_KEY, viewMode);

    if (DOM.terminalWrap) {
      DOM.terminalWrap.hidden = viewMode !== VIEW_TERMINAL;
    }
    if (DOM.desktopWrap) {
      DOM.desktopWrap.hidden = viewMode !== VIEW_DESKTOP;
    }
    updateViewButtons();

    if (viewMode === VIEW_DESKTOP) {
      if (autoConnect && !State.desktopConnected) {
        connectDesktop();
      }
      return;
    }

    const term = getTerm();
    if (term && typeof term.scheduleResize === 'function') {
      term.scheduleResize(true);
    }
  }

  function bind() {
    if (DOM.viewTerminalBtn) {
      DOM.viewTerminalBtn.addEventListener('click', () => {
        setView(VIEW_TERMINAL);
      });
    }
    if (DOM.viewDesktopBtn) {
      DOM.viewDesktopBtn.addEventListener('click', () => {
        setView(VIEW_DESKTOP);
      });
    }
    if (DOM.desktopConnectBtn) {
      DOM.desktopConnectBtn.addEventListener('click', () => {
        if (State.desktopConnected || rfb) {
          disconnectDesktop();
          return;
        }
        connectDesktop();
      });
    }
    if (DOM.desktopInputTrackpadBtn) {
      DOM.desktopInputTrackpadBtn.addEventListener('click', () => {
        inputMode = INPUT_TRACKPAD;
        writeStorage(DESKTOP_INPUT_STORAGE_KEY, inputMode);
        applyInputMode();
      });
    }
    if (DOM.desktopInputDirectBtn) {
      DOM.desktopInputDirectBtn.addEventListener('click', () => {
        inputMode = INPUT_DIRECT;
        writeStorage(DESKTOP_INPUT_STORAGE_KEY, inputMode);
        applyInputMode();
      });
    }
    if (DOM.desktopFpsSelect) {
      DOM.desktopFpsSelect.addEventListener('change', () => {
        frameRate = normalizeFrameRate(DOM.desktopFpsSelect.value);
        writeStorage(DESKTOP_FPS_STORAGE_KEY, String(frameRate));
        applyFrameRateSettings();
      });
    }

    Object.keys(MODIFIER_CONFIG).forEach((name) => {
      const config = MODIFIER_CONFIG[name];
      const button = config.button();
      if (!button) {
        return;
      }
      button.addEventListener('click', () => {
        setModifier(name, !modifiers[name], true);
      });
    });

    if (DOM.desktopCadBtn) {
      DOM.desktopCadBtn.addEventListener('click', () => {
        sendCtrlAltDel();
      });
    }

    window.addEventListener(
      'blur',
      () => {
        clearModifiers(true);
      },
      { passive: true }
    );
  }

  return {
    init() {
      applyInputMode();
      applyFrameRateSettings();
      setDesktopConnected(false);
      updateDesktopStatus('未连接');
      updatePlaceholder('切换到桌面模式后自动连接');
      setView(viewMode, { autoConnect: false });
      bind();
      if (viewMode === VIEW_DESKTOP) {
        connectDesktop();
      }
    },
    connect: connectDesktop,
    disconnect: disconnectDesktop,
    setView
  };
}
