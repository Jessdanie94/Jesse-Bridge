process.env.SHOPIFY_API_SECRET = 'secret';
process.env.SELLVIA_API_KEY = 'key';
process.env.ADMIN_TOKEN = 'admin';
process.env.DB_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';
process.env.APPROVAL_BASE_DELAY_MS = '1';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const axios = require('axios');
const { withRetry, isTransientError } = require('../retry');
const { app, db } = require('../server');

const httpErr = (status) => Object.assign(new Error('x'), { response: { status, data: 'e' } });

test('isTransientError classifies errors', () => {
  assert.ok(isTransientError(new Error('timeout')));
  assert.ok(isTransientError(httpErr(503)));
  assert.ok(isTransientError(httpErr(429)));
  assert.ok(!isTransientError(httpErr(401)));
  assert.ok(!isTransientError(httpErr(404)));
});

test('withRetry backs off exponentially then succeeds', async () => {
  const delays = [];
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) throw httpErr(500); return 'ok'; },
    { baseDelayMs: 10, sleep: async (ms) => delays.push(ms) });
  assert.deepStrictEqual([r.success, r.attempts, r.retryCount], [true, 3, 2]);
  assert.deepStrictEqual(delays, [10, 20]);
});

test('withRetry does not retry permanent errors and stops at max attempts', async () => {
  let n = 0;
  let r = await withRetry(async () => { n++; throw httpErr(404); }, { sleep: async () => {} });
  assert.deepStrictEqual([r.success, r.attempts, r.permanent, n], [false, 1, true, 1]);
  n = 0;
  r = await withRetry(async () => { n++; throw httpErr(502); }, { maxAttempts: 3, sleep: async () => {} });
  assert.deepStrictEqual([r.success, r.attempts, n], [false, 3, 3]);
});

test('webhook dedup persists in db and approvals are logged', async (t) => {
  let posts = 0;
  t.mock.method(axios, 'post', async () => {
    posts++;
    if (posts === 1) throw httpErr(503);
    return { data: { ok: true } };
  });
  const body = JSON.stringify({
    id: 1, total_price: '5', currency: 'USD', financial_status: 'paid',
    note_attributes: [{ name: 'sellvia_order_id', value: 'S1' }],
  });
  const hmac = crypto.createHmac('sha256', 'secret').update(body).digest('base64');
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/shopify/webhook/orders`;
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Webhook-Id': 'w1' };
  try {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(url, { method: 'POST', headers, body });
      assert.strictEqual(res.status, 200);
    }
    for (let i = 0; i < 50 && db.listApprovals().length === 0 || db.listApprovals()[0]?.status === 'retrying'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    server.close();
  }
  assert.strictEqual(posts, 2);
  const rows = db.listApprovals();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0].status, rows[0].retry_count, rows[0].shopify_order_id], ['success', 1, '1']);
  assert.strictEqual(db.markWebhookProcessed('w1'), false);
});
