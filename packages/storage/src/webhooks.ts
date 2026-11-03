import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SnapshotStore, StoreScope } from './index.js';

export interface VerifiedWebhook { deliveryId: string; event: string; payload: Record<string, unknown> }
const events = new Set(['push', 'pull_request', 'installation', 'installation_repositories', 'ping']);

/** Validate the exact raw request bytes before parsing or recording the delivery. */
export function verifyWebhook(rawBody: Uint8Array, headers: { signature?: string; deliveryId?: string; event?: string }, secret: string): VerifiedWebhook {
  if (!secret || secret.length < 16) throw new Error('Webhook secret is not configured securely');
  if (rawBody.byteLength > 1_048_576) throw new Error('Webhook payload exceeds 1 MiB limit');
  if (!headers.signature || !/^sha256=[0-9a-fA-F]{64}$/.test(headers.signature)) throw new Error('Invalid webhook signature');
  const received = Buffer.from(headers.signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw new Error('Invalid webhook signature');
  if (!headers.deliveryId || !/^[A-Za-z0-9-]{8,100}$/.test(headers.deliveryId)) throw new Error('Invalid webhook delivery ID');
  if (!headers.event || !events.has(headers.event)) throw new Error('Unsupported webhook event');
  const payload: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid webhook payload');
  return { deliveryId: headers.deliveryId, event: headers.event, payload: payload as Record<string, unknown> };
}

/** Scope must come from an authorized installation lookup, never request body owner/repo alone. */
export async function acceptWebhookDelivery(store: SnapshotStore, scope: StoreScope, webhook: VerifiedWebhook): Promise<{ duplicate: boolean }> {
  return { duplicate: !await store.recordWebhookDelivery(scope, webhook.deliveryId) };
}
