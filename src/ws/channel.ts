import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export interface WsChannel {
  readonly pathname: string;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}
