(function () {
  const cliSelect = document.getElementById('cli-select');
  const promptInput = document.getElementById('prompt-input');
  const startBtn = document.getElementById('start-btn');
  const killBtn = document.getElementById('kill-btn');
  const statusEl = document.getElementById('status');
  const terminalRoot = document.getElementById('terminal');

  const TOKEN_STORAGE_KEY = 'c2p_token';
  const TerminalCtor = window.Terminal;
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
  const AttachAddonCtor = window.AttachAddon && window.AttachAddon.AttachAddon;

  let token = '';
  let terminal = null;
  let fitAddon = null;
  let attachAddon = null;
  let controlSocket = null;
  let terminalSocket = null;
  let terminalInputDisposable = null;
  let currentSessionId = '';
  let reconnectDelayMs = 1000;
  let reconnectTimer = null;
  let pushRegistered = false;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function readTokenFromHash() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash) {
      return '';
    }
    const params = new URLSearchParams(hash.includes('=') ? hash : `token=${hash}`);
    return params.get('token') || '';
  }

  function initToken() {
    const hashToken = readTokenFromHash();
    if (hashToken) {
      localStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
      token = hashToken;
      return;
    }

    token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  }

  function apiUrl(path) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('token', token);
    return url.toString();
  }

  function wsUrl(path, extraParams) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(path, `${protocol}//${window.location.host}`);
    url.searchParams.set('token', token);
    if (extraParams) {
      Object.keys(extraParams).forEach((key) => {
        const value = extraParams[key];
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.toString();
  }

  function initTerminal() {
    if (!TerminalCtor || !FitAddonCtor) {
      setStatus('xterm.js CDN failed to load.');
      return;
    }

    terminal = new TerminalCtor({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'IBM Plex Mono, Menlo, Consolas, monospace',
      theme: {
        background: '#090b14',
        foreground: '#f0f2f8'
      }
    });

    fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRoot);
    fitAddon.fit();

    const resizeObserver = new ResizeObserver(() => {
      if (!fitAddon || !terminal) {
        return;
      }
      fitAddon.fit();
      sendResize();
    });
    resizeObserver.observe(terminalRoot);

    window.addEventListener('resize', () => {
      if (!fitAddon || !terminal) {
        return;
      }
      fitAddon.fit();
      sendResize();
    });
  }

  function sendControl(payload) {
    if (!controlSocket || controlSocket.readyState !== WebSocket.OPEN) {
      return false;
    }
    controlSocket.send(JSON.stringify(payload));
    return true;
  }

  function sendResize() {
    if (!currentSessionId || !terminal) {
      return;
    }
    sendControl({
      type: 'resize',
      sessionId: currentSessionId,
      cols: terminal.cols,
      rows: terminal.rows
    });
  }

  function closeTerminalSocket() {
    if (attachAddon && typeof attachAddon.dispose === 'function') {
      attachAddon.dispose();
      attachAddon = null;
    }
    if (terminalInputDisposable) {
      terminalInputDisposable.dispose();
      terminalInputDisposable = null;
    }
    if (terminalSocket) {
      terminalSocket.onclose = null;
      terminalSocket.close();
      terminalSocket = null;
    }
  }

  function connectTerminal(sessionId) {
    if (!terminal) {
      return;
    }

    closeTerminalSocket();
    terminal.write('\x1bc');

    terminalSocket = new WebSocket(wsUrl('/ws/terminal', { session: sessionId }));
    terminalSocket.binaryType = 'arraybuffer';

    terminalSocket.onopen = () => {
      setStatus(`Session ${sessionId} attached`);
      if (AttachAddonCtor) {
        attachAddon = new AttachAddonCtor(terminalSocket, { bidirectional: true });
        terminal.loadAddon(attachAddon);
        return;
      }

      terminalInputDisposable = terminal.onData((data) => {
        if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
          terminalSocket.send(data);
        }
      });
    };

    terminalSocket.onmessage = (event) => {
      if (attachAddon) {
        return;
      }
      if (typeof event.data === 'string') {
        terminal.write(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new TextDecoder().decode(event.data));
      }
    };

    terminalSocket.onclose = () => {
      if (currentSessionId === sessionId) {
        setStatus(`Session ${sessionId} detached`);
      }
    };
  }

  function handleControlMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      setStatus('Control payload parse failed');
      return;
    }

    if (payload.type === 'spawned' && payload.sessionId) {
      currentSessionId = payload.sessionId;
      killBtn.disabled = false;
      connectTerminal(currentSessionId);
      sendResize();
      return;
    }

    if (payload.type === 'exited' && payload.sessionId) {
      if (payload.sessionId === currentSessionId) {
        setStatus(`Session exited (${payload.exitCode})`);
        killBtn.disabled = true;
      }
      return;
    }

    if (payload.type === 'sessions' && Array.isArray(payload.list)) {
      if (currentSessionId) {
        const stillAlive = payload.list.some((item) => item && item.id === currentSessionId);
        if (!stillAlive) {
          currentSessionId = '';
          killBtn.disabled = true;
        }
      }
      return;
    }

    if (payload.type === 'error') {
      setStatus(payload.message || 'Control error');
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      connectControl();
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 20000);
    }, reconnectDelayMs);
  }

  function connectControl() {
    if (!token) {
      setStatus('Missing token, open URL with #token=...');
      return;
    }

    if (controlSocket && controlSocket.readyState === WebSocket.OPEN) {
      return;
    }

    controlSocket = new WebSocket(wsUrl('/ws/control'));

    controlSocket.onopen = () => {
      reconnectDelayMs = 1000;
      setStatus('Control connected');
      if (!pushRegistered) {
        registerPush().catch(() => {
          setStatus('Push registration skipped');
        });
      }
    };

    controlSocket.onmessage = handleControlMessage;

    controlSocket.onclose = () => {
      setStatus('Control disconnected, retrying...');
      scheduleReconnect();
    };

    controlSocket.onerror = () => {
      controlSocket.close();
    };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(normalized);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      output[i] = raw.charCodeAt(i);
    }
    return output;
  }

  async function registerPush() {
    if (pushRegistered) {
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    const keyResp = await fetch(apiUrl('/api/vapid-public-key'));
    if (!keyResp.ok) {
      return;
    }
    const keyData = await keyResp.json();
    if (!keyData.publicKey) {
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return;
    }

    const registration = await navigator.serviceWorker.register('/sw.js');
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

    if (saveResp.ok) {
      pushRegistered = true;
      setStatus('Push subscription ready');
    }
  }

  function bindEvents() {
    startBtn.addEventListener('click', () => {
      if (!terminal) {
        return;
      }
      const cli = cliSelect.value;
      const prompt = promptInput.value.trim();
      const ok = sendControl({
        type: 'spawn',
        cli,
        cols: terminal.cols,
        rows: terminal.rows,
        prompt: prompt || undefined
      });

      if (!ok) {
        setStatus('Control channel not ready');
      }
    });

    killBtn.addEventListener('click', () => {
      if (!currentSessionId) {
        return;
      }
      sendControl({
        type: 'kill',
        sessionId: currentSessionId
      });
      killBtn.disabled = true;
    });
  }

  initToken();
  initTerminal();
  bindEvents();
  connectControl();
})();
