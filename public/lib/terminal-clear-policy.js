const CSI_SCROLLBACK_CLEAR_SEQUENCE = '\x1b[3J';
const CSI_SCROLLBACK_CLEAR_PREFIX_MAX_LENGTH = CSI_SCROLLBACK_CLEAR_SEQUENCE.length - 1;

function resolveTrailingSequenceCarry(value) {
  const text = typeof value === 'string' ? value : '';
  const maxLength = Math.min(CSI_SCROLLBACK_CLEAR_PREFIX_MAX_LENGTH, text.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(CSI_SCROLLBACK_CLEAR_SEQUENCE.slice(0, length))) {
      return text.slice(-length);
    }
  }
  return '';
}

export function extractScrollbackClearSequence(data, carry = '') {
  const safeData = typeof data === 'string' ? data : '';
  const safeCarry = resolveTrailingSequenceCarry(carry);
  const combined = `${safeCarry}${safeData}`;
  if (!combined) {
    return {
      text: '',
      shouldClearScrollback: false,
      carry: ''
    };
  }

  const trailingCarry = resolveTrailingSequenceCarry(combined);
  const stableText = trailingCarry ? combined.slice(0, combined.length - trailingCarry.length) : combined;
  const segments = stableText.split(CSI_SCROLLBACK_CLEAR_SEQUENCE);
  const shouldClearScrollback = segments.length > 1;

  return {
    text: shouldClearScrollback ? segments.join('') : stableText,
    shouldClearScrollback,
    carry: trailingCarry
  };
}
