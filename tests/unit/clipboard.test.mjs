import assert from 'node:assert/strict';
import test from 'node:test';
import { writeClipboardText } from '../../public/lib/clipboard.js';

function createFakeDocument(execResult = true) {
  const host = {
    children: [],
    appendChild(node) {
      node.parentNode = host;
      host.children.push(node);
    },
    removeChild(node) {
      const index = host.children.indexOf(node);
      if (index >= 0) {
        host.children.splice(index, 1);
      }
      node.parentNode = null;
    }
  };

  const calls = {
    createElement: 0,
    execCommand: []
  };

  return {
    document: {
      body: host,
      documentElement: host,
      createElement(tagName) {
        calls.createElement += 1;
        assert.equal(tagName, 'textarea');
        return {
          value: '',
          style: {},
          parentNode: null,
          setAttribute() {},
          focus() {},
          select() {},
          setSelectionRange() {}
        };
      },
      execCommand(command) {
        calls.execCommand.push(command);
        return execResult;
      }
    },
    calls
  };
}

test('writeClipboardText uses Clipboard API when available', async () => {
  const writes = [];
  const result = await writeClipboardText('hello', {
    clipboard: {
      writeText: async (value) => {
        writes.push(value);
      }
    }
  });

  assert.equal(result, true);
  assert.deepEqual(writes, ['hello']);
});

test('writeClipboardText falls back to execCommand when Clipboard API is unavailable', async () => {
  const fakeDoc = createFakeDocument(true);
  const result = await writeClipboardText('fallback-copy', {
    clipboard: null,
    document: fakeDoc.document
  });

  assert.equal(result, true);
  assert.equal(fakeDoc.calls.createElement > 0, true);
  assert.deepEqual(fakeDoc.calls.execCommand, ['copy']);
});

test('writeClipboardText falls back to execCommand when Clipboard API write fails', async () => {
  const fakeDoc = createFakeDocument(true);
  const result = await writeClipboardText('recover-copy', {
    clipboard: {
      writeText: async () => {
        throw new Error('permission denied');
      }
    },
    document: fakeDoc.document
  });

  assert.equal(result, true);
  assert.deepEqual(fakeDoc.calls.execCommand, ['copy']);
});

test('writeClipboardText returns false when both Clipboard API and fallback copy fail', async () => {
  const fakeDoc = createFakeDocument(false);
  const result = await writeClipboardText('fail-copy', {
    clipboard: {
      writeText: async () => {
        throw new Error('permission denied');
      }
    },
    document: fakeDoc.document
  });

  assert.equal(result, false);
  assert.deepEqual(fakeDoc.calls.execCommand, ['copy']);
});
