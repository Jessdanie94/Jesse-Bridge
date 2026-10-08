const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const WEBHOOK_RETENTION_DAYS = 30;

function openDb(file = process.env.DB_PATH || './data/bridge.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_webhooks (
      id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sellvia_order_id TEXT NOT NULL,
      shopify_order_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('retrying','success','failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_sellvia ON approvals (sellvia_order_id);
  `);

  const now = () => new Date().toISOString();
  const insertWebhook = db.prepare(
    'INSERT OR IGNORE INTO processed_webhooks (id, processed_at) VALUES (?, ?)'
  );
  const pruneWebhooks = db.prepare('DELETE FROM processed_webhooks WHERE processed_at < ?');
  const insertApproval = db.prepare(
    `INSERT INTO approvals (sellvia_order_id, shopify_order_id, status, retry_count, created_at, updated_at)
     VALUES (?, ?, 'retrying', 0, ?, ?)`
  );
  const updateApproval = db.prepare(
    'UPDATE approvals SET status = ?, retry_count = ?, error = ?, updated_at = ? WHERE id = ?'
  );
  const listApprovals = db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT ?');

  return {
    raw: db,
    // Atomically records the webhook id; returns false if it was already processed
    markWebhookProcessed(id) {
      return insertWebhook.run(String(id), now()).changes === 1;
    },
    pruneOldWebhooks(days = WEBHOOK_RETENTION_DAYS) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      return pruneWebhooks.run(cutoff).changes;
    },
    startApproval(sellviaOrderId, shopifyOrderId = null) {
      const t = now();
      return Number(
        insertApproval.run(String(sellviaOrderId), shopifyOrderId == null ? null : String(shopifyOrderId), t, t)
          .lastInsertRowid
      );
    },
    updateApproval(id, { status, retryCount, error = null }) {
      const err = error == null ? null : typeof error === 'string' ? error : JSON.stringify(error);
      updateApproval.run(status, retryCount, err, now(), id);
    },
    listApprovals(limit = 100) {
      return listApprovals.all(Math.min(Math.max(Number(limit) || 100, 1), 500));
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openDb };
