function resolveClipboard(adapters = {}) {
  if (Object.prototype.hasOwnProperty.call(adapters, 'clipboard')) {
    return adapters.clipboard;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    return navigator.clipboard;
  }
  return null;
}

function resolveDocument(adapters = {}) {
  if (Object.prototype.hasOwnProperty.call(adapters, 'document')) {
    return adapters.document;
  }
  if (typeof document !== 'undefined') {
    return document;
  }
  return null;
}

function copyWithExecCommand(text, doc) {
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
    return false;
  }
  const host = doc.body || doc.documentElement;
  if (!host || typeof host.appendChild !== 'function' || typeof host.removeChild !== 'function') {
    return false;
  }

  let textarea = null;
  try {
    textarea = doc.createElement('textarea');
    if (!textarea) {
      return false;
    }
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    if (textarea.style) {
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.left = '-1000px';
      textarea.style.opacity = '0';
    }
    host.appendChild(textarea);
    if (typeof textarea.focus === 'function') {
      textarea.focus();
    }
    if (typeof textarea.select === 'function') {
      textarea.select();
    }
    if (typeof textarea.setSelectionRange === 'function') {
      textarea.setSelectionRange(0, text.length);
    }
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    if (textarea && textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }
}

export async function writeClipboardText(text, adapters = {}) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const clipboard = resolveClipboard(adapters);

  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // continue with execCommand fallback
    }
  }

  const doc = resolveDocument(adapters);
  return copyWithExecCommand(value, doc);
}
