import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapZernioWebhook, verifyWebhookSignature } from '../src/services/zernio/webhook.js';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a correct signature', () => {
    const body = '{"type":"post.updated"}';
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('accepts the sha256= prefixed form', () => {
    const body = '{"type":"post.updated"}';
    expect(verifyWebhookSignature(Buffer.from(body), `sha256=${sign(body)}`, SECRET)).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    expect(verifyWebhookSignature(Buffer.from('{"tampered":true}'), sign('{"original":true}'), SECRET)).toBe(false);
  });

  it('rejects a missing or empty header', () => {
    expect(verifyWebhookSignature(Buffer.from('{}'), undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{}'), '', SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{"type":"post.updated"}';
    const wrong = createHmac('sha256', 'another-secret').update(Buffer.from(body)).digest('hex');
    expect(verifyWebhookSignature(Buffer.from(body), wrong, SECRET)).toBe(false);
  });
});

describe('mapZernioWebhook', () => {
  it('maps a post status update, folding the status', () => {
    expect(
      mapZernioWebhook({ type: 'post.updated', data: { postId: 'zp1', status: 'Published' } }),
    ).toEqual({ kind: 'post_status', zernioPostId: 'zp1', status: 'published' });
  });

  it('reads flat bodies and alternate key spellings', () => {
    expect(mapZernioWebhook({ event: 'publish.failed', post_id: 'zp2', state: 'failed' })).toEqual({
      kind: 'post_status',
      zernioPostId: 'zp2',
      status: 'failed',
    });
  });

  it('maps a lapsed account to reconnect_required, never to hidden', () => {
    expect(
      mapZernioWebhook({ type: 'account.updated', data: { accountId: 'za1', status: 'token_expired' } }),
    ).toEqual({ kind: 'account_status', accountId: 'za1', status: 'reconnect_required' });
  });

  it('maps a recovered account back to connected', () => {
    expect(mapZernioWebhook({ type: 'account.updated', data: { id: 'za1', status: 'active' } })).toEqual({
      kind: 'account_status',
      accountId: 'za1',
      status: 'connected',
    });
  });

  it('ignores what it does not understand, with a reason', () => {
    expect(mapZernioWebhook({ type: 'comment.created', data: { text: 'hi' } })).toMatchObject({ kind: 'ignore' });
    expect(mapZernioWebhook({ type: 'post.updated', data: {} })).toMatchObject({ kind: 'ignore' });
    expect(mapZernioWebhook(null)).toMatchObject({ kind: 'ignore' });
    expect(mapZernioWebhook('string')).toMatchObject({ kind: 'ignore' });
  });
});
