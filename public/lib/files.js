import { DOM, State, apiUrl, authedFetch, buildAuthHeaders } from './state.js';

const FILES_LONG_PRESS_MS = 520;
const FILES_AUTH_RETRY_DELAY_MS = 900;
const FILES_TEXT_ZOOM_MIN = 0.5;
const FILES_TEXT_ZOOM_MAX = 5;
const FILES_LAST_PATH_STORAGE_KEY = 'c2p_files_last_path';
const FILES_EDITOR_SESSION_STORAGE_KEY = 'c2p_files_editor_session_v1';
const FILES_VIEWPORT_CLOSE_GUARD_MS = 1200;

function decodeBase64Url(base64Url) {
  if (typeof base64Url !== 'string' || !base64Url) {
    return '';
  }
  const normalized = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = `${normalized}${'='.repeat(padLength)}`;
  if (typeof atob !== 'function') {
    return '';
  }
  try {
    return atob(padded);
  } catch {
    return '';
  }
}

function readAccessTokenScope(token) {
  if (typeof token !== 'string' || !token) {
    return '';
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return '';
  }
  const payloadJson = decodeBase64Url(parts[1]);
  if (!payloadJson) {
    return '';
  }
  try {
    const parsed = JSON.parse(payloadJson);
    const scope = parsed && typeof parsed === 'object' ? parsed.scope : '';
    return scope === 'admin' || scope === 'readonly' ? scope : '';
  } catch {
    return '';
  }
}

function joinPath(basePath, name) {
  const base = typeof basePath === 'string' ? basePath.trim() : '.';
  const normalizedBase = !base || base === '.' ? '' : base.replace(/\/+$/g, '');
  const normalizedName = String(name || '').replace(/^\/+/g, '');
  if (!normalizedName) {
    return normalizedBase || '.';
  }
  if (!normalizedBase) {
    return normalizedName;
  }
  return `${normalizedBase}/${normalizedName}`;
}

function splitPath(targetPath) {
  const normalized = String(targetPath || '').replace(/\/+$/g, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return {
      dir: '.',
      base: normalized
    };
  }
  return {
    dir: normalized.slice(0, lastSlash) || '.',
    base: normalized.slice(lastSlash + 1)
  };
}

function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  const fixed = next >= 100 || index === 0 ? 0 : 1;
  return `${next.toFixed(fixed)} ${units[index]}`;
}

function clampMenuPosition(x, y, width, height) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY)
  };
}

function readPersistedFilesPath() {
  try {
    const raw = window.localStorage.getItem(FILES_LAST_PATH_STORAGE_KEY) || '';
    const trimmed = raw.trim();
    return trimmed || '.';
  } catch {
    return '.';
  }
}

function persistFilesPath(pathValue) {
  const nextPath = typeof pathValue === 'string' ? pathValue.trim() : '';
  try {
    window.localStorage.setItem(FILES_LAST_PATH_STORAGE_KEY, nextPath || '.');
  } catch {
    // Ignore storage write failures.
  }
}

function readPersistedEditorSession() {
  try {
    const raw = window.localStorage.getItem(FILES_EDITOR_SESSION_STORAGE_KEY) || '';
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const pathValue = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    const modeRaw = typeof parsed.mode === 'string' ? parsed.mode.trim() : '';
    const mode = modeRaw === 'md-edit' || modeRaw === 'md-preview' ? modeRaw : '';
    if (!pathValue) {
      return null;
    }
    return {
      path: pathValue,
      mode
    };
  } catch {
    return null;
  }
}

function persistEditorSession(session) {
  const pathValue = session && typeof session.path === 'string' ? session.path.trim() : '';
  if (!pathValue) {
    return;
  }
  const modeRaw = session && typeof session.mode === 'string' ? session.mode.trim() : '';
  const mode = modeRaw === 'md-edit' || modeRaw === 'md-preview' ? modeRaw : '';
  try {
    window.localStorage.setItem(
      FILES_EDITOR_SESSION_STORAGE_KEY,
      JSON.stringify({
        path: pathValue,
        mode
      })
    );
  } catch {
    // Ignore storage write failures.
  }
}

function clearPersistedEditorSession() {
  try {
    window.localStorage.removeItem(FILES_EDITOR_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage write failures.
  }
}

export function createFiles({ toast, openTerminalAtPath }) {
  let currentPath = '.';
  let parentPath = null;
  let entries = [];
  let listNotice = null;
  let showHiddenEntries = true;
  let contextTarget = null;
  let contextMenuEl = null;
  let contextBackdropEl = null;
  let longPressTimer = 0;
  let dragDepth = 0;
  let suppressClick = false;
  let loading = false;
  let authRetryTimer = 0;
  let writeBlocked = false;
  let searchQuery = '';
  let editorDirty = false;
  let editorOriginalContent = '';
  let imgBlobUrl = '';
  let mdRenderer = null;
  let editorPinchState = null;
  let editorPinchBound = false;
  let editorTextZoom = 1;
  let editorViewportGuardBound = false;
  let lastViewportChangeAt = 0;
  let folderPickerDialogEl = null;
  let folderPickerTitleEl = null;
  let folderPickerPathEl = null;
  let folderPickerListEl = null;
  let folderPickerRootBtn = null;
  let folderPickerUpBtn = null;
  let folderPickerConfirmBtn = null;
  let folderPickerCancelBtn = null;
  let folderPickerResolver = null;
  let folderPickerActionText = '';
  let folderPickerCurrentDir = '.';
  let folderPickerParentDir = null;
  let folderPickerEntries = [];
  let folderPickerLoading = false;
  let folderPickerError = '';
  let folderPickerRequestId = 0;

  function isAuthFailureError(error) {
    const message = readErrorMessage(error).toLowerCase();
    return (
      message.includes('401') ||
      message.includes('403') ||
      message.includes('missing bearer token') ||
      message.includes('unauthorized')
    );
  }

  function isInsufficientScopeError(error) {
    const message = readErrorMessage(error).toLowerCase();
    return message.includes('insufficient_scope');
  }

  function readErrorMessage(error) {
    if (!error || typeof error !== 'object' || !('message' in error)) {
      return '';
    }
    const raw = error.message;
    return typeof raw === 'string' ? raw : String(raw || '');
  }

  function classifyFsError(error) {
    const message = readErrorMessage(error);
    const normalized = message.toLowerCase();

    if (
      normalized.includes('missing bearer token') ||
      normalized.includes('unauthorized') ||
      normalized.includes('401')
    ) {
      return {
        kind: 'auth',
        listTitle: '登录状态已失效',
        listHint: '请重新登录后再访问目录。',
        listToast: '登录状态已失效，请重新登录',
        listToastType: 'warn'
      };
    }

    if (
      normalized.includes('insufficient_scope') ||
      normalized.includes('permission denied') ||
      normalized.includes('forbidden') ||
      normalized.includes('403')
    ) {
      return {
        kind: 'permission',
        listTitle: '权限不足，无法读取目录',
        listHint: '请切换管理员令牌，或进入有读取权限的目录。',
        listToast: '权限不足：无法读取该目录',
        listToastType: 'warn'
      };
    }

    if (
      normalized.includes('too large') ||
      normalized.includes('limit=') ||
      normalized.includes('413') ||
      normalized.includes('insufficient disk space')
    ) {
      return {
        kind: 'size',
        listTitle: '当前操作超出大小限制',
        listHint: '请缩小文件规模后重试，或改用下载到本地处理。',
        listToast: '操作超出大小限制，请缩小后重试',
        listToastType: 'warn'
      };
    }

    return {
      kind: 'generic',
      listTitle: '读取目录失败',
      listHint: '请稍后重试，或检查网络与目录路径。',
      listToast: `读取目录失败: ${message || 'unknown'}`,
      listToastType: 'danger'
    };
  }

  function isReadonlyToken() {
    return readAccessTokenScope(State.token) === 'readonly';
  }

  function syncWriteAccessUi() {
    const readonly = isReadonlyToken();
    writeBlocked = readonly;

    if (DOM.filesScopePill) {
      DOM.filesScopePill.hidden = !readonly;
      DOM.filesScopePill.textContent = readonly ? '只读' : '';
      DOM.filesScopePill.title = readonly ? '只读令牌：写操作将被禁用' : '';
    }

    if (DOM.filesNewfileBtn) {
      DOM.filesNewfileBtn.disabled = readonly;
    }
    if (DOM.filesMkdirBtn) {
      DOM.filesMkdirBtn.disabled = readonly;
    }
    if (DOM.filesUploadBtn) {
      DOM.filesUploadBtn.disabled = readonly;
    }
    if (DOM.filesEditorSaveBtn) {
      DOM.filesEditorSaveBtn.disabled = readonly;
    }
  }

  function scheduleAuthRetry(pathToRetry) {
    if (authRetryTimer) {
      return;
    }
    authRetryTimer = window.setTimeout(() => {
      authRetryTimer = 0;
      void refresh(pathToRetry, { silentAuthRetry: true });
    }, FILES_AUTH_RETRY_DELAY_MS);
  }

  function buildApiUrl(pathname, extraParams = {}) {
    const url = new URL(apiUrl(pathname));
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  async function fetchJson(pathname, options = {}) {
    const response = await authedFetch(buildApiUrl(pathname, options.query), {
      method: options.method || 'GET',
      headers: options.headers ? buildAuthHeaders(options.headers) : undefined,
      body: options.body
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function ensureFolderPickerDialog() {
    if (folderPickerDialogEl) {
      return folderPickerDialogEl;
    }
    folderPickerDialogEl = document.createElement('dialog');
    folderPickerDialogEl.className = 'file-dialog files-folder-picker-dialog';
    folderPickerDialogEl.innerHTML = `
      <div class="file-dialog-header">
        <span class="file-dialog-title" data-role="title"></span>
      </div>
      <div class="file-dialog-body files-folder-picker-body">
        <div class="files-folder-picker-toolbar">
          <button type="button" class="btn btn-sm" data-folder-action="root">根目录</button>
          <button type="button" class="btn btn-sm" data-folder-action="up">上级</button>
          <code class="files-folder-picker-path" data-role="path">.</code>
        </div>
        <div class="files-folder-picker-list" data-role="list"></div>
        <div class="files-folder-picker-footer">
          <button type="button" class="btn btn-sm" data-folder-action="confirm"></button>
          <button type="button" class="btn btn-sm" data-folder-action="cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(folderPickerDialogEl);

    folderPickerTitleEl = folderPickerDialogEl.querySelector('[data-role="title"]');
    folderPickerPathEl = folderPickerDialogEl.querySelector('[data-role="path"]');
    folderPickerListEl = folderPickerDialogEl.querySelector('[data-role="list"]');
    folderPickerRootBtn = folderPickerDialogEl.querySelector('[data-folder-action="root"]');
    folderPickerUpBtn = folderPickerDialogEl.querySelector('[data-folder-action="up"]');
    folderPickerConfirmBtn = folderPickerDialogEl.querySelector('[data-folder-action="confirm"]');
    folderPickerCancelBtn = folderPickerDialogEl.querySelector('[data-folder-action="cancel"]');

    const resolveFolderActionButton = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (!(node instanceof Element)) {
          continue;
        }
        const buttonFromPath = node.closest('[data-folder-action]');
        if (buttonFromPath && folderPickerDialogEl && folderPickerDialogEl.contains(buttonFromPath)) {
          return buttonFromPath;
        }
      }
      const target = event.target;
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      if (!element) {
        return;
      }
      const button = element.closest('[data-folder-action]');
      if (!button || (folderPickerDialogEl && !folderPickerDialogEl.contains(button))) {
        return;
      }
      return button;
    };

    folderPickerDialogEl.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeFolderPicker(null);
    });
    folderPickerDialogEl.addEventListener('click', (event) => {
      if (event.target === folderPickerDialogEl) {
        closeFolderPicker(null);
        return;
      }
      const button = resolveFolderActionButton(event);
      if (!button) {
        return;
      }
      const action = button.dataset.folderAction;
      if (action === 'cancel') {
        closeFolderPicker(null);
        return;
      }
      if (action === 'root') {
        void loadFolderPickerDirectory('.');
        return;
      }
      if (action === 'up') {
        if (folderPickerParentDir) {
          void loadFolderPickerDirectory(folderPickerParentDir);
        }
        return;
      }
      if (action === 'confirm') {
        closeFolderPicker(folderPickerCurrentDir || '.');
        return;
      }
      if (action === 'open-dir') {
        const nextPath = typeof button.dataset.path === 'string' ? button.dataset.path : '';
        if (nextPath) {
          void loadFolderPickerDirectory(nextPath);
        }
      }
    });
    folderPickerDialogEl.addEventListener('close', () => {
      if (folderPickerResolver) {
        const resolve = folderPickerResolver;
        folderPickerResolver = null;
        resolve(null);
      }
    });

    return folderPickerDialogEl;
  }

  function closeFolderPicker(selectedDir) {
    const resolve = folderPickerResolver;
    folderPickerResolver = null;
    folderPickerRequestId += 1;
    if (folderPickerDialogEl && folderPickerDialogEl.open) {
      folderPickerDialogEl.close();
    }
    if (typeof resolve === 'function') {
      resolve(selectedDir);
    }
  }

  function renderFolderPickerDialog() {
    if (!folderPickerDialogEl || !folderPickerTitleEl || !folderPickerPathEl || !folderPickerListEl) {
      return;
    }
    folderPickerTitleEl.textContent = `${folderPickerActionText}到目标目录`;
    folderPickerPathEl.textContent = folderPickerCurrentDir || '.';
    if (folderPickerConfirmBtn) {
      folderPickerConfirmBtn.textContent = `${folderPickerActionText}到当前目录`;
      folderPickerConfirmBtn.disabled = folderPickerLoading || !folderPickerCurrentDir;
    }
    if (folderPickerRootBtn) {
      folderPickerRootBtn.disabled = folderPickerLoading;
    }
    if (folderPickerUpBtn) {
      folderPickerUpBtn.disabled = folderPickerLoading || !folderPickerParentDir;
    }
    if (folderPickerCancelBtn) {
      folderPickerCancelBtn.disabled = false;
    }

    folderPickerListEl.textContent = '';
    if (folderPickerLoading) {
      const loadingEl = document.createElement('p');
      loadingEl.className = 'files-folder-picker-empty';
      loadingEl.textContent = '目录读取中...';
      folderPickerListEl.appendChild(loadingEl);
      return;
    }
    if (folderPickerError) {
      const errorEl = document.createElement('p');
      errorEl.className = 'files-folder-picker-empty files-empty-error';
      errorEl.textContent = folderPickerError;
      folderPickerListEl.appendChild(errorEl);
      return;
    }
    if (folderPickerEntries.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'files-folder-picker-empty';
      emptyEl.textContent = '当前目录为空';
      folderPickerListEl.appendChild(emptyEl);
      return;
    }
    const fragment = document.createDocumentFragment();
    folderPickerEntries.forEach((entry) => {
      const isDir = entry.type === 'dir';
      const row = document.createElement(isDir ? 'button' : 'div');
      if (row instanceof HTMLButtonElement) {
        row.type = 'button';
      }
      row.className = `files-folder-picker-item ${isDir ? 'is-dir' : 'is-file'}`;
      if (isDir) {
        row.dataset.folderAction = 'open-dir';
        row.dataset.path = entry.path;
      }

      const icon = document.createElement('span');
      icon.className = 'files-folder-picker-item-icon';
      icon.textContent = isDir ? 'DIR' : 'FILE';

      const name = document.createElement('span');
      name.className = 'files-folder-picker-item-name';
      name.textContent = entry.name;

      const meta = document.createElement('span');
      meta.className = 'files-folder-picker-item-meta';
      meta.textContent = isDir ? '-' : formatBytes(entry.size);

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(meta);
      fragment.appendChild(row);
    });
    folderPickerListEl.appendChild(fragment);
  }

  async function loadFolderPickerDirectory(pathToLoad) {
    const requestId = ++folderPickerRequestId;
    folderPickerLoading = true;
    folderPickerError = '';
    renderFolderPickerDialog();
    try {
      const payload = await fetchJson('/api/fs/list', {
        query: { path: pathToLoad || '.' }
      });
      if (requestId !== folderPickerRequestId || !folderPickerResolver) {
        return;
      }
      folderPickerCurrentDir = typeof payload.path === 'string' ? payload.path : '.';
      folderPickerParentDir = typeof payload.parent === 'string' ? payload.parent : null;
      const listing = Array.isArray(payload.entries) ? payload.entries : [];
      folderPickerEntries = listing
        .filter((entry) => entry && (entry.type === 'dir' || entry.type === 'file'))
        .map((entry) => ({
          name: typeof entry.name === 'string' ? entry.name : '',
          path: typeof entry.path === 'string' ? entry.path : '',
          type: entry.type === 'dir' ? 'dir' : 'file',
          size: Number.isFinite(entry.size) ? Number(entry.size) : 0
        }))
        .filter((entry) => entry.name && entry.path);
    } catch (error) {
      if (requestId !== folderPickerRequestId || !folderPickerResolver) {
        return;
      }
      const feedback = classifyFsError(error);
      folderPickerEntries = [];
      folderPickerError = feedback.listTitle;
      toast.show(feedback.listToast, feedback.listToastType);
    } finally {
      if (requestId !== folderPickerRequestId || !folderPickerResolver) {
        return;
      }
      folderPickerLoading = false;
      renderFolderPickerDialog();
    }
  }

  function selectTargetDirectory(actionText, initialDir) {
    const dialog = ensureFolderPickerDialog();
    if (folderPickerResolver) {
      closeFolderPicker(null);
    }

    folderPickerActionText = actionText;
    folderPickerCurrentDir = normalizeTargetFolderInput(initialDir);
    folderPickerParentDir = null;
    folderPickerEntries = [];
    folderPickerLoading = true;
    folderPickerError = '';

    const selectedPromise = new Promise((resolve) => {
      folderPickerResolver = resolve;
    });

    renderFolderPickerDialog();
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement) {
      activeEl.blur();
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    void loadFolderPickerDirectory(folderPickerCurrentDir);
    return selectedPromise;
  }

  function ensureContextMenu() {
    if (contextMenuEl) {
      return contextMenuEl;
    }
    contextBackdropEl = document.createElement('div');
    contextBackdropEl.className = 'touch-context-backdrop files-context-backdrop';
    contextBackdropEl.hidden = true;
    contextBackdropEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      hideContextMenu();
    });
    contextBackdropEl.addEventListener('click', (event) => {
      event.preventDefault();
      hideContextMenu();
    });
    document.body.appendChild(contextBackdropEl);

    contextMenuEl = document.createElement('div');
    contextMenuEl.className = 'touch-context-menu files-context-menu';
    contextMenuEl.hidden = true;
    contextMenuEl.innerHTML = `
      <button type="button" class="touch-context-btn" data-action="open">打开</button>
      <button type="button" class="touch-context-btn" data-action="copy-path-rel">复制相对路径</button>
      <button type="button" class="touch-context-btn" data-action="copy-path-abs">复制绝对路径</button>
      <button type="button" class="touch-context-btn" data-action="open-terminal">在此打开终端</button>
      <button type="button" class="touch-context-btn" data-action="download">下载</button>
      <button type="button" class="touch-context-btn" data-action="rename">重命名</button>
      <button type="button" class="touch-context-btn" data-action="copy-to">复制到...</button>
      <button type="button" class="touch-context-btn" data-action="move-to">移动到...</button>
      <button type="button" class="touch-context-btn" data-action="remove">删除</button>
    `;
    document.body.appendChild(contextMenuEl);

    const resolveActionButton = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const node of path) {
        if (!(node instanceof Element)) {
          continue;
        }
        const buttonFromPath = node.closest('[data-action]');
        if (buttonFromPath && contextMenuEl && contextMenuEl.contains(buttonFromPath)) {
          return buttonFromPath;
        }
      }
      const target = event.target;
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      if (!element) {
        return;
      }
      const button = element.closest('[data-action]');
      if (!button || (contextMenuEl && !contextMenuEl.contains(button))) {
        return;
      }
      return button;
    };

    const runContextAction = async (event) => {
      const button = resolveActionButton(event);
      const targetEntry = contextTarget;
      if (!button || !targetEntry) {
        return;
      }
      const action = button.dataset.action;
      hideContextMenu();
      if (action === 'open') {
        await openEntry(targetEntry);
        return;
      }
      if (action === 'copy-path-rel') {
        await copyEntryPath(targetEntry, 'relative');
        return;
      }
      if (action === 'copy-path-abs') {
        await copyEntryPath(targetEntry, 'absolute');
        return;
      }
      if (action === 'download') {
        if (targetEntry.type !== 'file') {
          toast.show('目录不支持下载', 'warn');
          return;
        }
        toast.show('正在准备下载...', 'warn');
        await downloadEntry(targetEntry.path);
        return;
      }
      if (action === 'open-terminal') {
        openTerminalForEntry(targetEntry);
        return;
      }
      if (action === 'rename') {
        await renameEntry(targetEntry);
        return;
      }
      if (action === 'copy-to') {
        await copyEntryToFolder(targetEntry);
        return;
      }
      if (action === 'move-to') {
        await moveEntryToFolder(targetEntry);
        return;
      }
      if (action === 'remove') {
        await removeEntry(targetEntry);
      }
    };
    let lastContextActionAt = 0;
    const triggerContextAction = (event, source) => {
      const now = Date.now();
      if (now - lastContextActionAt < 300) {
        return;
      }
      lastContextActionAt = now;
      if (source !== 'click') {
        event.preventDefault();
      }
      void runContextAction(event);
    };
    contextMenuEl.addEventListener('pointerup', (event) => {
      triggerContextAction(event, 'pointerup');
    });
    contextMenuEl.addEventListener(
      'touchend',
      (event) => {
        triggerContextAction(event, 'touchend');
      },
      { passive: false }
    );
    contextMenuEl.addEventListener('click', (event) => {
      if ((event.detail || 0) === 0) {
        triggerContextAction(event, 'click');
      }
    });

    return contextMenuEl;
  }

  function hideContextMenu() {
    if (!contextMenuEl) {
      return;
    }
    contextMenuEl.hidden = true;
    if (contextBackdropEl) {
      contextBackdropEl.hidden = true;
    }
    contextTarget = null;
  }

  function showContextMenu(entry, x, y) {
    const menu = ensureContextMenu();
    if (contextBackdropEl) {
      contextBackdropEl.hidden = false;
    }
    contextTarget = entry;
    menu.hidden = false;

    const readonly = isReadonlyToken();
    const downloadBtn = menu.querySelector('[data-action="download"]');
    if (downloadBtn) {
      downloadBtn.hidden = entry.type !== 'file';
    }
    const openTerminalBtn = menu.querySelector('[data-action="open-terminal"]');
    if (openTerminalBtn) {
      openTerminalBtn.hidden = entry.type !== 'dir' && entry.type !== 'file';
    }
    const copyAbsBtn = menu.querySelector('[data-action="copy-path-abs"]');
    if (copyAbsBtn) {
      copyAbsBtn.hidden = typeof entry.absPath !== 'string' || !entry.absPath;
    }
    const renameBtn = menu.querySelector('[data-action="rename"]');
    if (renameBtn) {
      renameBtn.hidden = readonly;
    }
    const copyToBtn = menu.querySelector('[data-action="copy-to"]');
    if (copyToBtn) {
      copyToBtn.hidden = readonly;
    }
    const moveToBtn = menu.querySelector('[data-action="move-to"]');
    if (moveToBtn) {
      moveToBtn.hidden = readonly;
    }
    const removeBtn = menu.querySelector('[data-action="remove"]');
    if (removeBtn) {
      removeBtn.hidden = readonly;
    }

    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const next = clampMenuPosition(x, y, rect.width || 168, rect.height || 220);
    menu.style.left = `${Math.round(next.x)}px`;
    menu.style.top = `${Math.round(next.y)}px`;
  }

  function render() {
    if (!DOM.filesList || !DOM.filesPath) {
      return;
    }
    syncWriteAccessUi();
    DOM.filesPath.textContent = currentPath || '.';
    syncHiddenButton();

    DOM.filesList.textContent = '';
    if (loading) {
      const loadingEl = document.createElement('p');
      loadingEl.className = 'files-empty';
      loadingEl.textContent = '读取中...';
      DOM.filesList.appendChild(loadingEl);
      return;
    }

    if (listNotice) {
      const titleEl = document.createElement('p');
      titleEl.className = 'files-empty files-empty-error';
      titleEl.textContent = listNotice.title;
      DOM.filesList.appendChild(titleEl);
      if (listNotice.hint) {
        const hintEl = document.createElement('p');
        hintEl.className = 'files-empty-hint';
        hintEl.textContent = listNotice.hint;
        DOM.filesList.appendChild(hintEl);
      }
      return;
    }

    if (entries.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'files-empty';
      emptyEl.textContent = '目录为空';
      DOM.filesList.appendChild(emptyEl);
      return;
    }

    const visibleEntries = getFilteredEntries();
    if (visibleEntries.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'files-empty';
      emptyEl.textContent = searchQuery ? '无匹配文件' : '隐藏文件已关闭显示';
      DOM.filesList.appendChild(emptyEl);
      return;
    }

    const fragment = document.createDocumentFragment();
    visibleEntries.forEach((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'files-item';
      row.dataset.path = entry.path;
      row.dataset.type = entry.type;

      const icon = document.createElement('span');
      icon.className = 'files-item-icon';
      icon.textContent = entry.type === 'dir' ? 'DIR' : entry.type === 'file' ? 'FILE' : 'ETC';

      const name = document.createElement('span');
      name.className = 'files-item-name';
      name.textContent = entry.name;

      const meta = document.createElement('span');
      meta.className = 'files-item-meta';
      meta.textContent = entry.type === 'file' ? formatBytes(entry.size) : '-';

      row.appendChild(icon);
      row.appendChild(name);
      row.appendChild(meta);
      fragment.appendChild(row);
    });
    DOM.filesList.appendChild(fragment);
  }

  function getFilteredEntries() {
    const base = showHiddenEntries ? entries : entries.filter((entry) => !isHiddenEntry(entry));
    if (!searchQuery) {
      return base;
    }
    const query = searchQuery.toLowerCase();
    return base.filter((entry) => entry.name.toLowerCase().includes(query));
  }

  function isHiddenEntry(entry) {
    if (!entry || typeof entry.name !== 'string') {
      return false;
    }
    return entry.name.startsWith('.');
  }

  function syncHiddenButton() {
    const button = DOM.filesHiddenBtn;
    if (!button) {
      return;
    }
    const icon = button.querySelector('.files-tool-icon');
    const label = button.querySelector('.files-tool-label');
    const actionText = showHiddenEntries ? '隐藏隐藏文件' : '显示隐藏文件';
    if (icon) {
      icon.textContent = showHiddenEntries ? 'H-' : 'H+';
    }
    if (label) {
      label.textContent = showHiddenEntries ? '隐藏' : '显示';
    }
    button.classList.toggle('is-active', !showHiddenEntries);
    button.title = actionText;
    button.setAttribute('aria-label', actionText);
  }

  async function refresh(nextPath = currentPath, options = {}) {
    const requestPath = nextPath || '.';
    const silentAuthRetry = options && options.silentAuthRetry === true;
    if (!State.token && silentAuthRetry) {
      scheduleAuthRetry(requestPath);
      return;
    }
    loading = true;
    listNotice = null;
    render();
    try {
      const payload = await fetchJson('/api/fs/list', {
        query: { path: requestPath }
      });
      if (authRetryTimer) {
        window.clearTimeout(authRetryTimer);
        authRetryTimer = 0;
      }
      currentPath = typeof payload.path === 'string' ? payload.path : '.';
      parentPath = typeof payload.parent === 'string' ? payload.parent : null;
      entries = Array.isArray(payload.entries) ? payload.entries : [];
      persistFilesPath(currentPath);
      searchQuery = '';
      if (DOM.filesSearchInput) {
        DOM.filesSearchInput.value = '';
      }
      listNotice = null;
    } catch (error) {
      if (silentAuthRetry && isAuthFailureError(error)) {
        scheduleAuthRetry(requestPath);
      } else {
        const feedback = classifyFsError(error);
        listNotice = {
          title: feedback.listTitle,
          hint: feedback.listHint
        };
        toast.show(feedback.listToast, feedback.listToastType);
      }
    } finally {
      loading = false;
      render();
    }
  }

  const MD_EXT = /\.(md|markdown)$/i;
  const IMG_EXTS = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

  function markDirty(isDirty) {
    editorDirty = isDirty;
    document.title = `${isDirty ? '● ' : ''}${DOM.filesEditorPath.textContent || 'C2P Controller'}`;
  }

  function resetEditorState() {
    if (imgBlobUrl) {
      URL.revokeObjectURL(imgBlobUrl);
      imgBlobUrl = '';
    }
    editorOriginalContent = '';
    DOM.filesEditor.value = '';
    DOM.filesEditor.hidden = false;
    DOM.filesMdPreview.innerHTML = '';
    DOM.filesMdPreview.dataset.source = '';
    DOM.filesMdPreview.hidden = true;
    DOM.filesImgPreview.replaceChildren();
    DOM.filesImgPreview.hidden = true;
    DOM.filesMdToggleBtn.hidden = true;
    DOM.filesMdToggleBtn.textContent = '预览';
    DOM.filesEditorSaveBtn.disabled = writeBlocked;
    resetEditorZoom();
    markDirty(false);
    document.title = 'C2P Controller';
  }

  function noteViewportChanged() {
    lastViewportChangeAt = Date.now();
  }

  function shouldGuardDialogClose(reason) {
    const closeReason = typeof reason === 'string' ? reason : 'manual';
    if (closeReason !== 'backdrop' && closeReason !== 'cancel') {
      return false;
    }
    if (!lastViewportChangeAt) {
      return false;
    }
    return Date.now() - lastViewportChangeAt <= FILES_VIEWPORT_CLOSE_GUARD_MS;
  }

  function resolveEditorViewMode() {
    if (DOM.filesImgPreview && !DOM.filesImgPreview.hidden) {
      return '';
    }
    if (!DOM.filesMdToggleBtn || DOM.filesMdToggleBtn.hidden) {
      return '';
    }
    return DOM.filesMdPreview && !DOM.filesMdPreview.hidden ? 'md-preview' : 'md-edit';
  }

  function persistCurrentEditorSession() {
    if (!DOM.filesEditorDialog || !DOM.filesEditorDialog.open || !DOM.filesEditorPath) {
      return;
    }
    const pathValue = (DOM.filesEditorPath.textContent || '').trim();
    if (!pathValue) {
      return;
    }
    persistEditorSession({
      path: pathValue,
      mode: resolveEditorViewMode()
    });
  }

  function applyRestoredEditorMode(mode) {
    if (mode !== 'md-edit' && mode !== 'md-preview') {
      return;
    }
    if (!DOM.filesMdToggleBtn || DOM.filesMdToggleBtn.hidden) {
      return;
    }

    if (mode === 'md-preview') {
      if (DOM.filesMdPreview.hidden) {
        const source = DOM.filesEditor.value;
        DOM.filesMdPreview.dataset.source = source;
        renderMarkdownPreview(source);
        DOM.filesEditor.hidden = true;
        DOM.filesMdPreview.hidden = false;
        DOM.filesMdToggleBtn.textContent = '编辑';
        markDirty(source !== editorOriginalContent);
      }
      return;
    }

    if (!DOM.filesMdPreview.hidden) {
      DOM.filesEditor.value = DOM.filesMdPreview.dataset.source || '';
      DOM.filesEditor.hidden = false;
      DOM.filesMdPreview.hidden = true;
      DOM.filesMdToggleBtn.textContent = '预览';
      markDirty(DOM.filesEditor.value !== editorOriginalContent);
    }
  }

  async function restoreEditorSessionIfNeeded() {
    const saved = readPersistedEditorSession();
    if (!saved || !saved.path) {
      return;
    }
    await openFileForEdit(saved.path, { suppressErrorToast: true });
    if (!DOM.filesEditorDialog || !DOM.filesEditorDialog.open) {
      clearPersistedEditorSession();
      return;
    }
    applyRestoredEditorMode(saved.mode);
    persistCurrentEditorSession();
  }

  function readTouchDistance(touchA, touchB) {
    const dx = touchA.clientX - touchB.clientX;
    const dy = touchA.clientY - touchB.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.max(min, Math.min(max, value));
  }

  function applyEditorTextZoom(nextZoom) {
    const clamped = clampNumber(nextZoom, FILES_TEXT_ZOOM_MIN, FILES_TEXT_ZOOM_MAX);
    editorTextZoom = Math.round(clamped * 100) / 100;
    if (!DOM.filesEditorDialog) {
      return;
    }
    DOM.filesEditorDialog.style.setProperty('--files-text-zoom', String(editorTextZoom));
  }

  function resetEditorZoom() {
    editorPinchState = null;
    applyEditorTextZoom(1);
  }

  function bindEditorPinchZoom() {
    if (editorPinchBound || !DOM.filesEditorDialog) {
      return;
    }
    editorPinchBound = true;

    DOM.filesEditorDialog.addEventListener(
      'touchstart',
      (event) => {
        if (!DOM.filesEditorDialog.open || event.touches.length !== 2) {
          if (event.touches.length < 2) {
            editorPinchState = null;
          }
          return;
        }
        if (DOM.filesImgPreview && !DOM.filesImgPreview.hidden) {
          return;
        }
        const target = event.target;
        const targetEl =
          target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
        if (!targetEl || !targetEl.closest('.file-dialog-body')) {
          return;
        }
        const distance = readTouchDistance(event.touches[0], event.touches[1]);
        if (!Number.isFinite(distance) || distance <= 0) {
          return;
        }
        editorPinchState = {
          baseDistance: distance,
          baseZoom: editorTextZoom
        };
        event.preventDefault();
      },
      { passive: false, capture: true }
    );

    DOM.filesEditorDialog.addEventListener(
      'touchmove',
      (event) => {
        if (!editorPinchState || event.touches.length !== 2 || !DOM.filesEditorDialog.open) {
          return;
        }
        if (DOM.filesImgPreview && !DOM.filesImgPreview.hidden) {
          return;
        }
        const distance = readTouchDistance(event.touches[0], event.touches[1]);
        if (!Number.isFinite(distance) || distance <= 0 || editorPinchState.baseDistance <= 0) {
          return;
        }
        const scale = distance / editorPinchState.baseDistance;
        applyEditorTextZoom(editorPinchState.baseZoom * scale);
        event.preventDefault();
      },
      { passive: false, capture: true }
    );

    DOM.filesEditorDialog.addEventListener(
      'touchend',
      (event) => {
        if (event.touches.length < 2) {
          editorPinchState = null;
        }
      },
      { passive: true }
    );

    DOM.filesEditorDialog.addEventListener(
      'touchcancel',
      () => {
        editorPinchState = null;
      },
      { passive: true }
    );

    let iosGestureBaseZoom = 1;
    const bindLegacyGestureZoom = (el) => {
      if (!(el instanceof HTMLElement)) {
        return;
      }
      el.addEventListener(
        'gesturestart',
        (event) => {
          if (!DOM.filesEditorDialog.open || el.hidden || (DOM.filesImgPreview && !DOM.filesImgPreview.hidden)) {
            return;
          }
          iosGestureBaseZoom = editorTextZoom;
          event.preventDefault();
        },
        { passive: false }
      );
      el.addEventListener(
        'gesturechange',
        (event) => {
          if (!DOM.filesEditorDialog.open || el.hidden || (DOM.filesImgPreview && !DOM.filesImgPreview.hidden)) {
            return;
          }
          const scale = Number(event.scale);
          if (!Number.isFinite(scale) || scale <= 0) {
            return;
          }
          applyEditorTextZoom(iosGestureBaseZoom * scale);
          event.preventDefault();
        },
        { passive: false }
      );
      el.addEventListener(
        'gestureend',
        () => {
          iosGestureBaseZoom = editorTextZoom;
        },
        { passive: true }
      );
    };
    bindLegacyGestureZoom(DOM.filesEditor);
    bindLegacyGestureZoom(DOM.filesMdPreview);
  }

  function tryCloseDialog(options = {}) {
    const reason = options && typeof options.reason === 'string' ? options.reason : 'manual';
    if (shouldGuardDialogClose(reason)) {
      return;
    }
    if (editorDirty && !window.confirm('有未保存的更改，确认关闭？')) {
      return;
    }
    DOM.filesEditorDialog.close();
    resetEditorState();
    clearPersistedEditorSession();
  }

  function getMarkdownRenderer() {
    if (!mdRenderer && window.marked && typeof window.marked.Renderer === 'function') {
      mdRenderer = new window.marked.Renderer();
      mdRenderer.html = () => '';
    }
    return mdRenderer;
  }

  function renderMarkdownPreview(mdText) {
    const renderer = getMarkdownRenderer();
    if (!renderer || !window.marked || typeof window.marked.parse !== 'function') {
      return;
    }
    DOM.filesMdPreview.innerHTML = window.marked.parse(mdText, { renderer });
    if (window.hljs && typeof window.hljs.highlightElement === 'function') {
      DOM.filesMdPreview.querySelectorAll('pre code').forEach((blockEl) => window.hljs.highlightElement(blockEl));
    }
  }

  async function openImagePreview(filePath) {
    const response = await authedFetch(`/api/fs/download?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      toast.show('图片加载失败', 'warn');
      return;
    }
    const blob = await response.blob();
    if (imgBlobUrl) {
      URL.revokeObjectURL(imgBlobUrl);
    }
    imgBlobUrl = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = imgBlobUrl;
    img.alt = filePath;
    DOM.filesImgPreview.replaceChildren(img);
    DOM.filesEditor.hidden = true;
    DOM.filesMdPreview.hidden = true;
    DOM.filesImgPreview.hidden = false;
    DOM.filesMdToggleBtn.hidden = true;
    DOM.filesEditorSaveBtn.disabled = true;
  }

  async function openFileForEdit(filePath, options = {}) {
    if (!DOM.filesEditorDialog || !DOM.filesEditor || !DOM.filesEditorPath) {
      return;
    }
    const suppressErrorToast = options && options.suppressErrorToast === true;
    try {
      resetEditorState();
      DOM.filesEditorPath.textContent = filePath;

      if (IMG_EXTS.test(filePath)) {
        await openImagePreview(filePath);
        if (DOM.filesImgPreview.hidden) {
          return;
        }
      } else {
        const payload = await fetchJson('/api/fs/read', {
          query: { path: filePath }
        });
        const content = typeof payload.content === 'string' ? payload.content : '';
        editorOriginalContent = content;
        DOM.filesEditorPath.textContent = payload.path || filePath;

        if (MD_EXT.test(filePath)) {
          DOM.filesMdPreview.dataset.source = content;
          renderMarkdownPreview(content);
          DOM.filesMdPreview.hidden = false;
          DOM.filesEditor.hidden = true;
          DOM.filesMdToggleBtn.hidden = false;
          DOM.filesMdToggleBtn.textContent = '编辑';
        } else {
          DOM.filesEditor.value = content;
          DOM.filesEditor.hidden = false;
        }
        DOM.filesEditorSaveBtn.disabled = writeBlocked;
      }
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement) {
        activeEl.blur();
      }
      DOM.filesEditorDialog.showModal();
      persistCurrentEditorSession();
    } catch (error) {
      const feedback = classifyFsError(error);
      if (feedback.kind === 'permission') {
        if (!suppressErrorToast) {
          toast.show('权限不足：当前令牌无权读取该文件', 'warn');
        }
        return;
      }
      if (feedback.kind === 'size') {
        if (!suppressErrorToast) {
          toast.show('文件过大，无法在线读取；请下载后处理', 'warn');
        }
        return;
      }
      if (!suppressErrorToast) {
        toast.show(`读取文件失败: ${readErrorMessage(error) || 'unknown'}`, 'danger');
      }
    }
  }

  async function downloadEntry(filePath) {
    const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    const isIOSDevice = /iPad|iPhone|iPod/i.test(userAgent);
    const isMacTouchDevice = /Macintosh/i.test(userAgent) && Number(navigator.maxTouchPoints || 0) > 1;
    const isAppleWebKit = /AppleWebKit/i.test(userAgent);
    const isThirdPartyIOSBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
    const shouldPreopenWindow = (isIOSDevice || isMacTouchDevice) && isAppleWebKit && !isThirdPartyIOSBrowser;
    const preopenedWindow = shouldPreopenWindow ? window.open('about:blank', '_blank') : null;
    if (preopenedWindow) {
      try {
        preopenedWindow.document.title = 'Preparing download';
        preopenedWindow.document.body.textContent = 'Downloading...';
      } catch {
        // Ignore cross-browser document access errors.
      }
    }
    const url = buildApiUrl('/api/fs/download', {
      path: filePath
    });
    try {
      const response = await authedFetch(url);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload && payload.error ? payload.error : `download failed (${response.status})`;
        throw new Error(message);
      }
      const blob = await response.blob();
      const { base } = splitPath(filePath);
      const filename = base || 'download';
      const blobUrl = URL.createObjectURL(blob);
      if (preopenedWindow && !preopenedWindow.closed) {
        preopenedWindow.location.href = blobUrl;
        toast.show('下载已开始', 'success');
        window.setTimeout(() => {
          URL.revokeObjectURL(blobUrl);
        }, 60000);
        return;
      }
      const canUseAnchorDownload = typeof HTMLAnchorElement !== 'undefined' && 'download' in HTMLAnchorElement.prototype;
      if (canUseAnchorDownload) {
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        link.rel = 'noopener';
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast.show('下载已开始', 'success');
      } else {
        const opened = window.open(blobUrl, '_blank', 'noopener');
        if (!opened) {
          window.location.href = blobUrl;
        }
        toast.show('当前环境不支持直接下载，已在新窗口打开文件', 'warn');
      }
      window.setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60000);
    } catch (error) {
      if (preopenedWindow && !preopenedWindow.closed) {
        try {
          preopenedWindow.close();
        } catch {
          // ignore
        }
      }
      toast.show(`下载失败: ${readErrorMessage(error) || 'unknown'}`, 'danger');
    }
  }

  function tryCopyTextWithExecCommand(text) {
    if (typeof document.execCommand !== 'function') {
      return false;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);

    const selection = window.getSelection();
    const savedRanges = [];
    if (selection && selection.rangeCount > 0) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        savedRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }

    textarea.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) {
        selection.addRange(range);
      }
    }
    if (activeElement) {
      activeElement.focus();
    }
    return copied;
  }

  async function copyText(text, successText) {
    if (!text) {
      toast.show('路径为空，无法复制', 'warn');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        toast.show(successText, 'success');
        return;
      } catch {
        // Fall through to execCommand fallback for legacy or restricted contexts.
      }
    }
    if (tryCopyTextWithExecCommand(text)) {
      toast.show(successText, 'success');
      return;
    }
    toast.show('复制失败', 'danger');
  }

  async function copyEntryPath(entry, mode) {
    if (mode === 'absolute') {
      const absolutePath = typeof entry.absPath === 'string' ? entry.absPath : '';
      await copyText(absolutePath, '绝对路径已复制');
      return;
    }
    await copyText(entry.path, '相对路径已复制');
  }

  async function renameEntry(entry) {
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    const { dir, base } = splitPath(entry.path);
    const nextNameRaw = window.prompt('输入新名称', base);
    if (nextNameRaw === null) {
      return;
    }
    const nextName = nextNameRaw.trim();
    if (!nextName) {
      return;
    }
    const to = joinPath(dir, nextName);
    try {
      await fetchJson('/api/fs/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: entry.path,
          to
        })
      });
      toast.show('重命名成功', 'success');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`重命名失败: ${error.message}`, 'danger');
    }
  }

  function normalizeTargetFolderInput(rawPath) {
    if (typeof rawPath !== 'string') {
      return '.';
    }
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed === '/') {
      return '.';
    }
    const normalized = trimmed.replace(/^\/+/g, '').replace(/\/+$/g, '');
    return normalized || '.';
  }

  function buildTransferTarget(entry, targetDirRaw) {
    const { base } = splitPath(entry.path);
    if (!base) {
      toast.show('当前条目名称无效', 'warn');
      return null;
    }
    const targetDir = normalizeTargetFolderInput(targetDirRaw);
    const targetPath = joinPath(targetDir, base);
    if (targetPath === entry.path) {
      toast.show('目标目录与当前目录相同', 'warn');
      return null;
    }
    return {
      targetDir,
      targetPath
    };
  }

  async function copyEntryToFolder(entry) {
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    const selectedDir = await selectTargetDirectory('复制', currentPath || '.');
    if (selectedDir === null) {
      return;
    }
    const transferTarget = buildTransferTarget(entry, selectedDir);
    if (!transferTarget) {
      return;
    }
    try {
      await fetchJson('/api/fs/copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: entry.path,
          to: transferTarget.targetPath
        })
      });
      toast.show(`复制完成: ${transferTarget.targetDir}`, 'success');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`复制失败: ${error.message}`, 'danger');
    }
  }

  async function moveEntryToFolder(entry) {
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    const selectedDir = await selectTargetDirectory('移动', currentPath || '.');
    if (selectedDir === null) {
      return;
    }
    const transferTarget = buildTransferTarget(entry, selectedDir);
    if (!transferTarget) {
      return;
    }
    try {
      await fetchJson('/api/fs/rename', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: entry.path,
          to: transferTarget.targetPath
        })
      });
      toast.show(`移动完成: ${transferTarget.targetDir}`, 'success');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`移动失败: ${error.message}`, 'danger');
    }
  }

  async function removeEntry(entry) {
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    const confirmed = window.confirm(`确认删除 ${entry.name} ?`);
    if (!confirmed) {
      return;
    }
    try {
      await fetchJson('/api/fs/remove', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: entry.path,
          recursive: entry.type === 'dir'
        })
      });
      toast.show('删除完成', 'warn');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`删除失败: ${error.message}`, 'danger');
    }
  }

  async function openEntry(entry) {
    if (entry.type === 'dir') {
      await refresh(entry.path);
      return;
    }
    if (entry.type === 'file') {
      await openFileForEdit(entry.path);
      return;
    }
    toast.show('当前条目不支持打开', 'warn');
  }

  function resolveTerminalCwd(entry) {
    if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) {
      return '';
    }
    if (entry.type === 'dir') {
      return entry.path;
    }
    if (entry.type === 'file') {
      return splitPath(entry.path).dir;
    }
    return '';
  }

  function openTerminalForEntry(entry) {
    const cwd = resolveTerminalCwd(entry);
    if (!cwd) {
      toast.show('当前条目不支持在此打开终端', 'warn');
      return;
    }
    if (typeof openTerminalAtPath !== 'function') {
      toast.show('终端模块未就绪', 'warn');
      return;
    }
    openTerminalAtPath(cwd);
  }

  async function saveEditorFile() {
    if (!DOM.filesEditorDialog || !DOM.filesEditorDialog.open || !DOM.filesEditor || !DOM.filesEditorPath) {
      return;
    }
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    if (!DOM.filesImgPreview.hidden) {
      return;
    }
    const targetPath = DOM.filesEditorPath.textContent || '';
    const content = DOM.filesEditor.hidden ? DOM.filesMdPreview.dataset.source || '' : DOM.filesEditor.value;
    try {
      await fetchJson('/api/fs/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: targetPath,
          content
        })
      });
      editorOriginalContent = content;
      markDirty(false);
      toast.show('文件已保存', 'success');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`保存失败: ${error.message}`, 'danger');
    }
  }

  async function createFile() {
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    const fileNameRaw = window.prompt('新文件名称', 'new-file.txt');
    if (fileNameRaw === null) {
      return;
    }
    const fileName = fileNameRaw.trim();
    if (!fileName) {
      return;
    }

    const targetPath = joinPath(currentPath, fileName);
    const existing = entries.find((entry) => entry.path === targetPath);
    if (existing) {
      if (existing.type !== 'file') {
        toast.show('同名目录已存在，无法创建文件', 'warn');
        return;
      }
      const overwrite = window.confirm(`文件 ${fileName} 已存在，是否覆盖为空文件？`);
      if (!overwrite) {
        return;
      }
    }

    try {
      await fetchJson('/api/fs/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: targetPath,
          content: ''
        })
      });
      toast.show(existing ? '文件已覆盖' : '文件创建成功', 'success');
      await refresh();
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        toast.show('只读模式不可写', 'warn');
        return;
      }
      toast.show(`创建文件失败: ${error.message}`, 'danger');
    }
  }

  async function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    if (isReadonlyToken()) {
      toast.show('只读模式不可写', 'warn');
      return;
    }
    for (const file of fileList) {
      const targetPath = joinPath(currentPath, file.name);
      try {
        const response = await fetch(buildApiUrl('/api/fs/upload', { path: targetPath }), {
          method: 'POST',
          headers: buildAuthHeaders({
            'Content-Type': 'application/octet-stream'
          }),
          body: file
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const message = payload && payload.error ? payload.error : `upload failed (${response.status})`;
          throw new Error(message);
        }
        toast.show(`上传完成: ${file.name}`, 'success');
      } catch (error) {
        if (isInsufficientScopeError(error)) {
          toast.show('只读模式不可写', 'warn');
          return;
        }
        const feedback = classifyFsError(error);
        if (feedback.kind === 'size') {
          toast.show(`上传失败: ${file.name} 超出大小限制，请压缩或拆分后重试`, 'warn');
          continue;
        }
        toast.show(`上传失败: ${file.name} - ${readErrorMessage(error) || 'unknown'}`, 'danger');
      }
    }
    await refresh();
  }

  function clearLongPress() {
    if (!longPressTimer) {
      return;
    }
    window.clearTimeout(longPressTimer);
    longPressTimer = 0;
  }

  function bindListInteractions() {
    if (!DOM.filesList) {
      return;
    }

    DOM.filesList.addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const row = event.target.closest('.files-item[data-path]');
      if (!row) {
        return;
      }
      const entry = entries.find((item) => item.path === row.dataset.path);
      if (!entry) {
        return;
      }
      void openEntry(entry);
    });

    DOM.filesList.addEventListener('pointerdown', (event) => {
      const row = event.target.closest('.files-item[data-path]');
      if (!row) {
        return;
      }
      const entry = entries.find((item) => item.path === row.dataset.path);
      if (!entry) {
        return;
      }
      clearLongPress();
      const x = event.clientX;
      const y = event.clientY;
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        suppressClick = true;
        showContextMenu(entry, x, y);
      }, FILES_LONG_PRESS_MS);
    });

    DOM.filesList.addEventListener('pointerup', () => {
      clearLongPress();
    });
    DOM.filesList.addEventListener('pointercancel', () => {
      clearLongPress();
    });
    DOM.filesList.addEventListener(
      'pointermove',
      (event) => {
        if (!longPressTimer) {
          return;
        }
        if (Math.abs(event.movementX) > 5 || Math.abs(event.movementY) > 5) {
          clearLongPress();
        }
      },
      { passive: true }
    );

    DOM.filesList.addEventListener(
      'dragenter',
      (event) => {
        event.preventDefault();
        dragDepth += 1;
        DOM.filesList.classList.add('is-dragover');
      },
      { passive: false }
    );
    DOM.filesList.addEventListener(
      'dragover',
      (event) => {
        event.preventDefault();
      },
      { passive: false }
    );
    DOM.filesList.addEventListener(
      'dragleave',
      (event) => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          DOM.filesList.classList.remove('is-dragover');
        }
      },
      { passive: false }
    );
    DOM.filesList.addEventListener(
      'drop',
      (event) => {
        event.preventDefault();
        dragDepth = 0;
        DOM.filesList.classList.remove('is-dragover');
        const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
        if (files.length === 0) {
          return;
        }
        void uploadFiles(files);
      },
      { passive: false }
    );
  }

  function bindToolbar() {
    if (DOM.filesHiddenBtn) {
      DOM.filesHiddenBtn.addEventListener('click', () => {
        showHiddenEntries = !showHiddenEntries;
        render();
      });
    }
    if (DOM.filesRootBtn) {
      DOM.filesRootBtn.addEventListener('click', () => {
        void refresh('/');
      });
    }
    if (DOM.filesRefreshBtn) {
      DOM.filesRefreshBtn.addEventListener('click', () => {
        void refresh();
      });
    }
    if (DOM.filesUpBtn) {
      DOM.filesUpBtn.addEventListener('click', () => {
        if (!parentPath) {
          return;
        }
        void refresh(parentPath);
      });
    }
    if (DOM.filesMkdirBtn) {
      DOM.filesMkdirBtn.addEventListener('click', async () => {
        if (isReadonlyToken()) {
          toast.show('只读模式不可写', 'warn');
          return;
        }
        const folderNameRaw = window.prompt('新目录名称', 'new-folder');
        if (folderNameRaw === null) {
          return;
        }
        const folderName = folderNameRaw.trim();
        if (!folderName) {
          return;
        }
        try {
          await fetchJson('/api/fs/mkdir', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              path: joinPath(currentPath, folderName),
              recursive: true
            })
          });
          toast.show('目录创建成功', 'success');
          await refresh();
        } catch (error) {
          if (isInsufficientScopeError(error)) {
            toast.show('只读模式不可写', 'warn');
            return;
          }
          toast.show(`创建目录失败: ${error.message}`, 'danger');
        }
      });
    }
    if (DOM.filesNewfileBtn) {
      DOM.filesNewfileBtn.addEventListener('click', () => {
        void createFile();
      });
    }
    if (DOM.filesUploadBtn && DOM.filesUploadInput) {
      DOM.filesUploadBtn.addEventListener('click', () => {
        DOM.filesUploadInput.click();
      });
      DOM.filesUploadInput.addEventListener('change', () => {
        const files = Array.from(DOM.filesUploadInput.files || []);
        DOM.filesUploadInput.value = '';
        if (files.length === 0) {
          return;
        }
        void uploadFiles(files);
      });
    }
  }

  function bindEditor() {
    if (!DOM.filesEditorDialog || !DOM.filesEditor || !DOM.filesMdPreview) {
      return;
    }

    bindEditorPinchZoom();
    if (!editorViewportGuardBound) {
      editorViewportGuardBound = true;
      const handleViewportChange = () => {
        noteViewportChanged();
      };
      window.addEventListener('resize', handleViewportChange, { passive: true });
      window.addEventListener('orientationchange', handleViewportChange, { passive: true });
      const viewport = window.visualViewport;
      if (viewport && typeof viewport.addEventListener === 'function') {
        viewport.addEventListener('resize', handleViewportChange, { passive: true });
      }
    }

    DOM.filesEditorCancelBtn.addEventListener('click', () => {
      tryCloseDialog({ reason: 'button' });
    });
    DOM.filesEditorSaveBtn.addEventListener('click', () => {
      void saveEditorFile();
    });

    DOM.filesEditorDialog.addEventListener('click', (event) => {
      if (event.target === DOM.filesEditorDialog) {
        tryCloseDialog({ reason: 'backdrop' });
      }
    });
    DOM.filesEditorDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      tryCloseDialog({ reason: 'cancel' });
    });
    DOM.filesEditorDialog.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        void saveEditorFile();
      }
    });

    DOM.filesEditor.addEventListener('input', () => {
      markDirty(DOM.filesEditor.value !== editorOriginalContent);
    });
    DOM.filesEditor.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const { selectionStart, selectionEnd, value } = DOM.filesEditor;
        DOM.filesEditor.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
        DOM.filesEditor.selectionStart = selectionStart + 2;
        DOM.filesEditor.selectionEnd = selectionStart + 2;
        markDirty(true);
      }
    });

    DOM.filesMdToggleBtn.addEventListener('click', () => {
      const inPreview = !DOM.filesMdPreview.hidden;
      if (inPreview) {
        DOM.filesEditor.value = DOM.filesMdPreview.dataset.source || '';
        DOM.filesEditor.hidden = false;
        DOM.filesMdPreview.hidden = true;
        DOM.filesMdToggleBtn.textContent = '预览';
        markDirty(DOM.filesEditor.value !== editorOriginalContent);
      } else {
        const source = DOM.filesEditor.value;
        DOM.filesMdPreview.dataset.source = source;
        renderMarkdownPreview(source);
        DOM.filesEditor.hidden = true;
        DOM.filesMdPreview.hidden = false;
        DOM.filesMdToggleBtn.textContent = '编辑';
        markDirty(source !== editorOriginalContent);
      }
      persistCurrentEditorSession();
    });
  }

  function bindSearch() {
    if (!DOM.filesSearchInput) {
      return;
    }
    DOM.filesSearchInput.addEventListener('input', (event) => {
      searchQuery = event.target.value.trim();
      render();
    });
  }

  return {
    init(options = {}) {
      if (!DOM.filesList || !DOM.filesPath) {
        return;
      }
      const silentAuthRetry = options && options.silentAuthRetry === true;
      const initialPath =
        options && typeof options.initialPath === 'string' && options.initialPath.trim()
          ? options.initialPath.trim()
          : readPersistedFilesPath();
      bindToolbar();
      bindEditor();
      bindSearch();
      bindListInteractions();
      void refresh(initialPath, { silentAuthRetry }).finally(() => {
        void restoreEditorSessionIfNeeded();
      });
    },
    refresh() {
      void refresh();
    }
  };
}
