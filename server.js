require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

// ---- Config: fail fast if secrets are missing (no placeholder fallbacks) ----
const REQUIRED_ENV = ['SHOPIFY_API_SECRET', 'SELLVIA_API_KEY', 'ADMIN_TOKEN'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const { SHOPIFY_API_SECRET, SELLVIA_API_KEY, ADMIN_TOKEN } = process.env;
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || 'wonderful-gems-point.myshopify.com';
const SELLVIA_API_BASE =
  process.env.SELLVIA_API_BASE || 'https://api.sellvia.com/api/v1';

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

async function approveSellviaOrder(orderId) {
  try {
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
    return { success: true, data: resp.data };
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Sellvia approve failed:', detail);
    return { success: false, error: detail };
  }
}

// In-memory dedupe for Shopify webhook retries (resets on restart/redeploy)
const processedWebhooks = new Set();
function markProcessed(id) {
  processedWebhooks.add(id);
  if (processedWebhooks.size > 5000) {
    processedWebhooks.delete(processedWebhooks.values().next().value);
  }
}

// ---- Routes ----
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'jesse-autopilot-bridge' });
});

// Shopify webhook -> approve matching Sellvia order
app.post('/api/shopify/webhook/orders', async (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.warn('Invalid Shopify HMAC');
    return res.status(401).send('Invalid HMAC');
  }

  // Ack right away so Shopify doesn't time out and retry
  res.status(200).send('OK');

  try {
    const webhookId = req.get('X-Shopify-Webhook-Id');
    if (webhookId && processedWebhooks.has(webhookId)) {
      console.log(`Duplicate webhook ${webhookId}, skipping`);
      return;
    }
    if (webhookId) markProcessed(webhookId);

    const order = req.body;
    console.log(`Shopify order ${order.id}: ${order.total_price} ${order.currency}`);

    if (order.financial_status !== 'paid') {
      console.log(`Order ${order.id} not paid (${order.financial_status}), skipping`);
      return;
    }

    const sellviaOrderId = order.note_attributes?.find(
      (a) => a.name === 'sellvia_order_id'
    )?.value;

    if (!sellviaOrderId) {
      console.warn(`Order ${order.id} has no sellvia_order_id, skipping`);
      return;
    }

    const result = await approveSellviaOrder(sellviaOrderId);
    if (result.success) {
      console.log(`Approved Sellvia order ${sellviaOrderId} for Shopify ${order.id}`);
    }
  } catch (e) {
    console.error('Webhook processing error:', e);
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
      const r = await approveSellviaOrder(o.id);
      results.push({ order: o.id, ...r });
    }
    res.json({ message: `Attempted ${results.length} approvals`, results });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      hint: 'Check SELLVIA_API_KEY and SELLVIA_API_BASE in Render env vars',
    });
  }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
