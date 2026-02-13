import webpush from 'web-push';
import type { PushSubscriptionRecord } from './store.js';
import { C2PStore } from './store.js';

interface PushConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

function hasValidConfig(config: Partial<PushConfig>): config is PushConfig {
  return Boolean(config.subject && config.publicKey && config.privateKey);
}

export class PushService {
  private readonly store: C2PStore;
  private enabled = false;
  private publicKey = '';

  constructor(store: C2PStore) {
    this.store = store;
  }

  init(config: Partial<PushConfig>): void {
    if (!hasValidConfig(config)) {
      this.enabled = false;
      this.publicKey = config.publicKey ?? '';
      return;
    }

    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    this.enabled = true;
    this.publicKey = config.publicKey;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async notify(title: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const payload = JSON.stringify({
      title,
      body,
      data: extra,
      url: '/'
    });

    const subscriptions = this.store.listSubscriptions();
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription as unknown as PushSubscriptionRecord, payload);
        } catch (error) {
          const statusCode =
            typeof error === 'object' && error !== null && 'statusCode' in error
              ? Number((error as { statusCode: number }).statusCode)
              : 0;

          if (statusCode === 404 || statusCode === 410) {
            this.store.removeSubscription(subscription.endpoint);
          }
        }
      })
    );
  }
}
