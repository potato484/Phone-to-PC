import type { PerMessageDeflateOptions } from 'ws';

export const WS_PER_MESSAGE_DEFLATE: PerMessageDeflateOptions = {
  zlibDeflateOptions: {
    level: 1
  },
  threshold: 128
};
