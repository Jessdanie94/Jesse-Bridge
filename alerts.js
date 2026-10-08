const axios = require('axios');
const logger = require('./logger');

// Best-effort alert hook. Posts to a Slack-compatible webhook when ALERT_WEBHOOK_URL is set.
// Swap the body for email/PagerDuty/etc. without touching callers.
async function sendAlert(title, context = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    await axios.post(
      url,
      { text: `:rotating_light: ${title}\n\`\`\`${JSON.stringify(context, null, 2)}\`\`\`` },
      { timeout: 5000 }
    );
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to send alert');
    return false;
  }
}

// Express error-handling middleware: logs with context and alerts
function errorMiddleware(err, req, res, next) {
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled request error');
  sendAlert('Unhandled error in Jesse-Bridge', { method: req.method, path: req.path, error: err.message });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Internal Server Error' });
}

module.exports = { sendAlert, errorMiddleware };
