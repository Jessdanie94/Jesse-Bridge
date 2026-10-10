require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');
const { openDb } = require('./db');
const { withRetry } = require('./retry');
const { sendAlert, errorMiddleware } = require('./alerts');

// ---- Config: fail fast if secrets are missing (no placeholder fallbacks) ----
const REQUIRED_ENV = ['SHOPIFY_API_SECRET', 'SELLVIA_API_KEY', 'ADMIN_TOKEN'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  logger.fatal(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const { SHOPIFY_API_SECRET, SELLVIA_API_KEY, ADMIN_TOKEN } = process.env;
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || 'wonderful-gems-point.myshopify.com';
const SELLVIA_API_BASE =
  process.env.SELLVIA_API_BASE || 'https://api.sellvia.com/api/v1';

const MAX_ATTEMPTS = parseInt(process.env.APPROVAL_MAX_ATTEMPTS, 10) || 5;
const BASE_DELAY_MS = parseInt(process.env.APPROVAL_BASE_DELAY_MS, 10) || 1000;
const db = openDb();
db.pruneOldWebhooks();

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Single body parser that also keeps the raw bytes for HMAC verification
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---- Helpers ----
// Constant-time compare that is safe for strings of different lengths
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !req.rawBody) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(req.rawBody)
    .digest('base64');
  return safeEqual(digest, hmacHeader);
}

function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token');
  if (!token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function buildRefundEmail({ orderId, customerEmail, reason, message }) {
  const safeReason = (reason || 'General issue').trim();
  const safeMessage = (message || '').trim();
  const body = [
    'Hello,',
    '',
    `I’m requesting a refund for order #${orderId || 'N/A'}.`,
    `Customer email: ${customerEmail || 'not provided'}`,
    `Reason: ${safeReason}`,
    safeMessage ? `Details: ${safeMessage}` : '',
    '',
    'Please let me know the next steps and whether a refund has been approved.',
    '',
    'Thank you.',
  ].filter(Boolean).join('\n');

  return {
    to: 'papoosedaniels94@gmail.com',
    subject: `Refund request for order #${orderId || 'N/A'}`,
    body,
  };
}

async function approveSellviaOrderOnce(orderId) {
  const resp = await axios.post(
    `${SELLVIA_API_BASE}/orders/${encodeURIComponent(orderId)}/approve`,
    {},
    {
      headers: {
        Authorization: `Bearer ${SELLVIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return resp.data;
}

// Approve with exponential backoff; persists every attempt outcome for audit
async function approveSellviaOrder(orderId, shopifyOrderId = null, retryOpts = {}) {
  const recordId = db.startApproval(orderId, shopifyOrderId);
  const ctx = { sellviaOrderId: orderId, shopifyOrderId };
  const result = await withRetry(() => approveSellviaOrderOnce(orderId), {
    maxAttempts: MAX_ATTEMPTS,
    baseDelayMs: BASE_DELAY_MS,
    ...retryOpts,
    onFailure: ({ attempt, err, permanent, willRetry }) => {
      const detail = err.response?.data || err.message;
      logger.warn({ ...ctx, attempt, permanent, willRetry, status: err.response?.status, detail }, 'Sellvia approve attempt failed');
      db.updateApproval(recordId, {
        status: willRetry ? 'retrying' : 'failed',
        retryCount: attempt - 1,
        error: detail,
      });
    },
  });
  if (result.success) {
    db.updateApproval(recordId, { status: 'success', retryCount: result.retryCount });
    logger.info({ ...ctx, attempts: result.attempts }, 'Sellvia order approved');
    return { success: true, attempts: result.attempts, data: result.data };
  }
  const error = result.error.response?.data || result.error.message;
  logger.error({ ...ctx, attempts: result.attempts, permanent: result.permanent, error }, 'Sellvia approval failed');
  await sendAlert('Sellvia approval failed', { ...ctx, attempts: result.attempts, permanent: result.permanent, error });
  return { success: false, attempts: result.attempts, permanent: result.permanent, error };
}

// ---- Routes ----
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'jesse-autopilot-bridge' });
});

app.get('/refund-request', (req, res) => {
  const orderId = (req.query.orderId || '').toString();
  const customerEmail = (req.query.customerEmail || '').toString();
  const draft = buildRefundEmail({
    orderId,
    customerEmail,
    reason: 'Product not as described',
    message: 'Please review this order and confirm the refund status.',
  });

  const html = `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Refund Request</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f8fafc; margin: 0; padding: 32px; color: #0f172a; }
          .card { max-width: 760px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
          h1 { margin-top: 0; }
          label { display: block; margin-top: 16px; font-weight: 600; }
          input, select, textarea { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; margin-top: 6px; }
          textarea { min-height: 180px; }
          button { margin-top: 24px; background: #0f766e; color: white; border: 0; border-radius: 8px; padding: 12px 18px; font-size: 15px; cursor: pointer; }
          .meta { color: #475569; font-size: 13px; margin-top: 12px; }
          .success { margin-top: 18px; color: #166534; background: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; display: none; }
          .error { margin-top: 18px; color: #991b1b; background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 8px; display: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Refund Request</h1>
          <p class="meta">Draft will be addressed to <strong>${draft.to}</strong>.</p>
          <form id="refundForm">
            <label>Order ID
              <input name="orderId" value="${orderId}" required />
            </label>
            <label>Customer email
              <input name="customerEmail" type="email" value="${customerEmail}" required />
            </label>
            <label>Reason
              <select name="reason">
                <option value="Product not as described">Product not as described</option>
                <option value="Damaged item">Damaged item</option>
                <option value="Wrong item received">Wrong item received</option>
                <option value="Late delivery">Late delivery</option>
                <option value="Changed my mind">Changed my mind</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label>Message
              <textarea name="message">${draft.body.replace(/"/g, '&quot;')}</textarea>
            </label>
            <button type="submit">Submit refund request</button>
          </form>
          <div id="success" class="success">Your refund request was saved and a draft email was prepared.</div>
          <div id="error" class="error"></div>
        </div>
        <script>
          const form = document.getElementById('refundForm');
          const success = document.getElementById('success');
          const error = document.getElementById('error');

          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            success.style.display = 'none';
            error.style.display = 'none';
            const formData = new FormData(form);
            const payload = Object.fromEntries(formData.entries());

            try {
              const res = await fetch('/api/refund/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Something went wrong');
              success.style.display = 'block';
              const draft = data.emailDraft;
              const mailto = `mailto:${draft.to}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
              window.location.href = mailto;
            } catch (err) {
              error.textContent = err.message;
              error.style.display = 'block';
            }
          });
        </script>
      </body>
    </html>`;

  res.type('html').send(html);
});

app.post('/api/refund/request', (req, res) => {
  const { orderId, customerEmail, reason, message } = req.body || {};

  if (!orderId || !customerEmail || !reason) {
    return res.status(400).json({ error: 'orderId, customerEmail, and reason are required' });
  }

  const draft = buildRefundEmail({ orderId, customerEmail, reason, message });
  const saved = db.createRefundRequest({
    orderId,
    customerEmail,
    reason,
    message: message || '',
  });

  res.status(201).json({
    message: 'Refund request received',
    id: saved.id,
    status: saved.status,
    emailDraft: draft,
  });
});

app.get('/api/refund/draft', (req, res) => {
  const { orderId, customerEmail, reason, message } = req.query;
  if (!orderId || !customerEmail || !reason) {
    return res.status(400).json({ error: 'orderId, customerEmail, and reason are required' });
  }

  res.json(buildRefundEmail({ orderId, customerEmail, reason, message: message || '' }));
});

// Shopify webhook -> approve matching Sellvia order
app.post('/api/shopify/webhook/orders', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    logger.warn('Invalid Shopify HMAC');
    return res.status(401).send('Invalid HMAC');
  }

  // Ack right away so Shopify doesn't time out and retry
  res.status(200).send('OK');

  try {
    const webhookId = req.get('X-Shopify-Webhook-Id');
    if (webhookId && !db.markWebhookProcessed(webhookId)) {
      logger.info({ webhookId }, 'Duplicate webhook, skipping');
      return;
    }

    const order = req.body;
    logger.info(
      { webhookId, shopifyOrderId: order.id, total: order.total_price, currency: order.currency },
      'Shopify order webhook received'
    );

    if (order.financial_status !== 'paid') {
      logger.info({ shopifyOrderId: order.id, financialStatus: order.financial_status }, 'Order not paid, skipping');
      return;
    }

    const sellviaOrderId = order.note_attributes?.find(
      (a) => a.name === 'sellvia_order_id'
    )?.value;

    if (!sellviaOrderId) {
      logger.warn({ shopifyOrderId: order.id }, 'Order has no sellvia_order_id, skipping');
      return;
    }

    await approveSellviaOrder(sellviaOrderId, order.id);
  } catch (e) {
    logger.error({ err: e }, 'Webhook processing error');
    await sendAlert('Webhook processing error', { error: e.message });
  }
});

// Manually approve all pending Sellvia orders (protected, POST only)
app.post('/api/sellvia/auto-approve', requireAdmin, async (req, res) => {
  try {
    const pendingRes = await axios.get(
      `${SELLVIA_API_BASE}/orders?status=pending_approval`,
      {
        headers: { Authorization: `Bearer ${SELLVIA_API_KEY}` },
        timeout: 15000,
      }
    );
    const pending = pendingRes.data?.orders || [];

    const results = [];
    for (const o of pending) {
      const { data, ...r } = await approveSellviaOrder(o.id);
      results.push({ order: o.id, ...r });
    }
    res.json({ message: `Attempted ${results.length} approvals`, results });
  } catch (err) {
    logger.error({ err }, 'Batch auto-approve failed');
    res.status(500).json({
      error: err.message,
      hint: 'Check SELLVIA_API_KEY and SELLVIA_API_BASE in Render env vars',
    });
  }
});

// Audit trail of approval attempts (protected)
app.get('/api/approvals', requireAdmin, (req, res) => {
  res.json({ approvals: db.listApprovals(req.query.limit) });
});

// Payout checklist (protected). No fake numbers: check Sellvia > Finances for real balances.
app.get('/api/payouts/status', requireAdmin, (req, res) => {
  res.json({
    shop: SHOPIFY_STORE_DOMAIN,
    note: 'Real balances live in Sellvia > Finances.',
    next_steps: [
      'POST /api/sellvia/auto-approve to clear pending orders',
      'Connect Wise in Sellvia Finances',
      'Tap Withdraw (Wise typically takes 2-3 days)',
    ],
  });
});

app.get('/api/shopify/auth', (req, res) => {
  res.json({
    message:
      'This bridge uses webhook HMAC auth, not OAuth. Set the Shopify app secret in Render env vars.',
  });
});

app.get('/api/refund/requests', requireAdmin, (req, res) => {
  res.json({ requests: db.listRefundRequests(req.query.limit) });
});

app.use(errorMiddleware);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => logger.info({ port: PORT }, 'Server running'));
}

module.exports = { app, db, approveSellviaOrder, buildRefundEmail };
