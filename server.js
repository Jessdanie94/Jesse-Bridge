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

app.use(errorMiddleware);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => logger.info({ port: PORT }, 'Server running'));
}

module.exports = { app, db, approveSellviaOrder };
