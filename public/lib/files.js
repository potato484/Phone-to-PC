import { DOM, apiUrl, authedFetch, buildAuthHeaders } from './state.js';

const FILES_LONG_PRESS_MS = 520;

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

export function createFiles({ toast, openTerminalAtPath }) {
  let currentPath = '.';
  let parentPath = null;
  let entries = [];
  let showHiddenEntries = true;
  let contextTarget = null;
  let contextMenuEl = null;
  let contextBackdropEl = null;
  let longPressTimer = 0;
  let dragDepth = 0;
  let suppressClick = false;
  let loading = false;

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
      if (action === 'remove') {
        await removeEntry(targetEntry);
      }
    };
    contextMenuEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      void runContextAction(event);
    });
    contextMenuEl.addEventListener('click', (event) => {
      // Keyboard-initiated click has detail=0 and may not emit pointer events.
      if ((event.detail || 0) === 0) {
        void runContextAction(event);
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

    if (entries.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'files-empty';
      emptyEl.textContent = '目录为空';
      DOM.filesList.appendChild(emptyEl);
      return;
    }

    const visibleEntries = showHiddenEntries ? entries : entries.filter((entry) => !isHiddenEntry(entry));
    if (visibleEntries.length === 0) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'files-empty';
      emptyEl.textContent = '隐藏文件已关闭显示';
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

  async function refresh(nextPath = currentPath) {
    const requestPath = nextPath || '.';
    loading = true;
    render();
    try {
      const payload = await fetchJson('/api/fs/list', {
        query: { path: requestPath }
      });
      currentPath = typeof payload.path === 'string' ? payload.path : '.';
      parentPath = typeof payload.parent === 'string' ? payload.parent : null;
      entries = Array.isArray(payload.entries) ? payload.entries : [];
      if (DOM.filesEditorWrap && !DOM.filesEditorWrap.hidden) {
        DOM.filesEditorWrap.hidden = true;
      }
    } catch (error) {
      toast.show(`读取目录失败: ${error.message}`, 'danger');
    } finally {
      loading = false;
      render();
    }
  }

  async function openFileForEdit(filePath) {
    if (!DOM.filesEditorWrap || !DOM.filesEditor || !DOM.filesEditorPath) {
      return;
    }
    try {
      const payload = await fetchJson('/api/fs/read', {
        query: { path: filePath }
      });
      DOM.filesEditorPath.textContent = payload.path || filePath;
      DOM.filesEditor.value = typeof payload.content === 'string' ? payload.content : '';
      DOM.filesEditorWrap.hidden = false;
    } catch (error) {
      toast.show(`读取文件失败: ${error.message}`, 'danger');
    }
  }

  async function downloadEntry(filePath) {
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
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 1000);
    } catch (error) {
      toast.show(`下载失败: ${error.message}`, 'danger');
    }
  }

  async function copyText(text, successText) {
    if (!text) {
      toast.show('路径为空，无法复制', 'warn');
      return;
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast.show('当前环境不支持复制', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.show(successText, 'success');
    } catch {
      toast.show('复制失败', 'danger');
    }
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
      toast.show(`重命名失败: ${error.message}`, 'danger');
    }
  }

  async function removeEntry(entry) {
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
    if (!DOM.filesEditorWrap || DOM.filesEditorWrap.hidden || !DOM.filesEditor || !DOM.filesEditorPath) {
      return;
    }
    const targetPath = DOM.filesEditorPath.textContent || '';
    try {
      await fetchJson('/api/fs/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          path: targetPath,
          content: DOM.filesEditor.value
        })
      });
      toast.show('文件已保存', 'success');
      await refresh();
    } catch (error) {
      toast.show(`保存失败: ${error.message}`, 'danger');
    }
  }

  async function createFile() {
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
      toast.show(`创建文件失败: ${error.message}`, 'danger');
    }
  }

  async function uploadFiles(fileList) {
    if (!fileList || fileList.length === 0) {
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
        toast.show(`上传失败: ${file.name} - ${error.message}`, 'danger');
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
    if (DOM.filesEditorCancelBtn && DOM.filesEditorWrap) {
      DOM.filesEditorCancelBtn.addEventListener('click', () => {
        DOM.filesEditorWrap.hidden = true;
      });
    }
    if (DOM.filesEditorSaveBtn) {
      DOM.filesEditorSaveBtn.addEventListener('click', () => {
        void saveEditorFile();
      });
    }
  }

  return {
    init() {
      if (!DOM.filesList || !DOM.filesPath) {
        return;
      }
      bindToolbar();
      bindEditor();
      bindListInteractions();
      void refresh('.');
    },
    refresh() {
      void refresh();
    }
  };
}
