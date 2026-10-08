const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'jesse-autopilot-bridge' },
  redact: ['req.headers.authorization', 'headers.authorization', '*.apiKey'],
});

module.exports = logger;
