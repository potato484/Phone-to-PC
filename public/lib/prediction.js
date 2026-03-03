const ALT_SCREEN_ENTER_RE = /\x1b\[\?(?:1049|1047|47)h/g;
const ALT_SCREEN_EXIT_RE = /\x1b\[\?(?:1049|1047|47)l/g;
const PREDICTION_TIMEOUT_MS = 120;
const ALT_SEQUENCE_CARRY_LIMIT = 32;
const PREDICTION_MAX_PENDING = 256;

function isSafePrintableInput(key) {
  return typeof key === 'string' && key.length === 1 && key >= ' ' && key <= '~';
}

function shouldAdvanceEpochFromInput(key) {
  if (typeof key !== 'string' || !key) {
    return false;
  }
  if (key === '\r' || key === '\n' || key === '\t' || key === '\x7f') {
    return true;
  }
  return key.startsWith('\x1b');
}

function hasEpochControlFromServer(data) {
  if (typeof data !== 'string' || !data) {
    return false;
  }
  return (
    data.includes('\r') ||
    data.includes('\n') ||
    data.includes('\t') ||
    data.includes('\x08') ||
    data.includes('\x7f') ||
    data.includes('\x1b')
  );
}

function parsePrintableChars(data) {
  const source = typeof data === 'string' ? data : '';
  if (!source) {
    return [];
  }
  const chars = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\x1b') {
      const next = source[index + 1] || '';
      if (next === '[') {
        index += 2;
        while (index < source.length) {
          const code = source.charCodeAt(index);
          if (code >= 0x40 && code <= 0x7e) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next === ']') {
        index += 2;
        while (index < source.length) {
          const code = source.charCodeAt(index);
          if (code === 0x07) {
            index += 1;
            break;
          }
          if (code === 0x1b && source[index + 1] === '\\') {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if (ch >= ' ' && ch <= '~') {
      chars.push(ch);
    }
    index += 1;
  }
  return chars;
}

export class PredictionEngine {
  constructor(terminal) {
    this.terminal = terminal;
    this.altScreenActive = false;
    this.epoch = 0;
    this.nextPredictionId = 0;
    this.pending = [];
    this.altSequenceCarry = '';
  }

  reset() {
    this.pending.forEach((entry) => {
      this.#disposePrediction(entry);
    });
    this.pending.length = 0;
    this.altScreenActive = false;
    this.altSequenceCarry = '';
    this.epoch += 1;
  }

  dispose() {
    this.reset();
  }

  onInput(key) {
    if (!this.terminal) {
      return;
    }
    if (shouldAdvanceEpochFromInput(key)) {
      this.epoch += 1;
      this.#discardOlderEpochPredictions();
      return;
    }
    if (this.altScreenActive || !isSafePrintableInput(key)) {
      return;
    }
    while (this.pending.length >= PREDICTION_MAX_PENDING) {
      const dropped = this.pending.shift();
      if (dropped) {
        this.#disposePrediction(dropped);
      }
    }

    const cursor = this.#readCursor();
    const marker = this.#createMarker();
    const prediction = {
      id: ++this.nextPredictionId,
      epoch: this.epoch,
      char: key,
      col: Number.isFinite(cursor.col) ? cursor.col : 0,
      marker,
      decoration: null,
      timeoutId: 0
    };
    this.terminal.write(key);
    prediction.timeoutId = window.setTimeout(() => {
      this.#markTimeout(prediction.id);
    }, PREDICTION_TIMEOUT_MS);
    this.pending.push(prediction);
  }

  onRawOutput(data) {
    const text = typeof data === 'string' ? data : '';
    if (!text) {
      return;
    }
    const withCarry = `${this.altSequenceCarry}${text}`;
    this.altSequenceCarry = withCarry.slice(-ALT_SEQUENCE_CARRY_LIMIT);
    const transitions = [];
    ALT_SCREEN_ENTER_RE.lastIndex = 0;
    ALT_SCREEN_EXIT_RE.lastIndex = 0;
    let match = ALT_SCREEN_ENTER_RE.exec(withCarry);
    while (match) {
      transitions.push({ index: match.index, active: true });
      match = ALT_SCREEN_ENTER_RE.exec(withCarry);
    }
    match = ALT_SCREEN_EXIT_RE.exec(withCarry);
    while (match) {
      transitions.push({ index: match.index, active: false });
      match = ALT_SCREEN_EXIT_RE.exec(withCarry);
    }
    transitions.sort((a, b) => a.index - b.index);
    transitions.forEach((transition) => {
      this.altScreenActive = transition.active;
    });
    if (this.altScreenActive && this.pending.length > 0) {
      this.reset();
    }
  }

  onServerFrame(data) {
    const text = typeof data === 'string' ? data : '';
    if (!text || this.pending.length === 0) {
      if (hasEpochControlFromServer(text)) {
        this.epoch += 1;
        this.#discardOlderEpochPredictions();
      }
      return;
    }
    const printableChars = parsePrintableChars(text);
    for (let i = 0; i < printableChars.length && this.pending.length > 0; ) {
      const nextChar = printableChars[i];
      const prediction = this.pending[0];
      if (prediction.char === nextChar) {
        this.pending.shift();
        this.#disposePrediction(prediction);
        i += 1;
        continue;
      }
      this.pending.shift();
      this.#disposePrediction(prediction);
      if (this.pending.length === 0) {
        i += 1;
      }
    }
    if (hasEpochControlFromServer(text)) {
      this.epoch += 1;
      this.#discardOlderEpochPredictions();
    }
  }

  #readCursor() {
    const cursorX = Number(
      this.terminal &&
        this.terminal.buffer &&
        this.terminal.buffer.active &&
        Number.isFinite(this.terminal.buffer.active.cursorX)
        ? this.terminal.buffer.active.cursorX
        : 0
    );
    return {
      col: Number.isFinite(cursorX) ? cursorX : 0
    };
  }

  #createMarker() {
    if (!this.terminal || typeof this.terminal.registerMarker !== 'function') {
      return null;
    }
    try {
      return this.terminal.registerMarker(0);
    } catch {
      return null;
    }
  }

  #markTimeout(predictionId) {
    const prediction = this.pending.find((entry) => entry.id === predictionId);
    if (!prediction || prediction.decoration || !prediction.marker) {
      return;
    }
    if (!this.terminal || typeof this.terminal.registerDecoration !== 'function') {
      return;
    }
    try {
      const decoration = this.terminal.registerDecoration({
        marker: prediction.marker,
        x: Math.max(0, Math.floor(prediction.col)),
        width: 1,
        layer: 'top'
      });
      if (decoration && typeof decoration.onRender === 'function') {
        decoration.onRender((element) => {
          if (!(element instanceof HTMLElement)) {
            return;
          }
          element.style.textDecoration = 'underline';
          element.style.textDecorationColor = '#f59e0b';
          element.style.textDecorationThickness = '2px';
        });
      }
      prediction.decoration = decoration || null;
    } catch {
      prediction.decoration = null;
    }
  }

  #discardOlderEpochPredictions() {
    if (this.pending.length === 0) {
      return;
    }
    const keep = [];
    this.pending.forEach((entry) => {
      if (entry.epoch >= this.epoch) {
        keep.push(entry);
        return;
      }
      this.#disposePrediction(entry);
    });
    this.pending = keep;
  }

  #disposePrediction(entry) {
    if (!entry) {
      return;
    }
    if (entry.timeoutId) {
      window.clearTimeout(entry.timeoutId);
      entry.timeoutId = 0;
    }
    if (entry.decoration && typeof entry.decoration.dispose === 'function') {
      entry.decoration.dispose();
      entry.decoration = null;
    }
    if (entry.marker && typeof entry.marker.dispose === 'function') {
      entry.marker.dispose();
      entry.marker = null;
    }
  }
}
