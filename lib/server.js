'use strict';

const path = require('path');
const express = require('express');
const { runRegistryAnalysis } = require('./engine');

/** Comma-separated origins, e.g. https://you.github.io — required for GH Pages → Render API. */
function allowedOrigins() {
  const raw = process.env.PLEXUS_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function corsForPages(req, res, next) {
  const list = allowedOrigins();
  if (list.length === 0) return next();
  const origin = req.headers.origin;
  if (origin && list.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}

/** One JSON line per /api request for Render logs and log drains (duration_ms, status). */
function structuredApiLog(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  const start = Date.now();
  res.on('finish', () => {
    const line = JSON.stringify({
      event: 'api_call',
      path: req.path,
      method: req.method,
      duration_ms: Date.now() - start,
      status: res.statusCode,
    });
    console.log(line);
  });
  next();
}

function createApp() {
  const app = express();
  app.use(corsForPages);
  app.use(express.json({ limit: '3mb' }));
  app.use(structuredApiLog);

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.post('/api/analyze', async (req, res) => {
    try {
      const body = req.body;
      const raw = body.packageJson ?? body;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).type('json').send({ error: 'Send JSON: { "packageJson": { ... } } or raw package.json fields' });
      }
      const pkg = { ...raw };
      delete pkg.private;
      delete pkg.main;
      const flags = {
        fix: body.fix === true,
        bundleSize: body.bundleSize === true,
      };
      const result = await runRegistryAnalysis(pkg, flags);
      res.type('html').send(result.html);
    } catch (e) {
      console.error(e);
      const status =
        typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600
          ? e.statusCode
          : 500;
      res.status(status).type('json').send({ error: String(e.message || e) });
    }
  });

  return app;
}

function startServer(opts = {}) {
  const port = Number(process.env.PORT || opts.port || 3847) || 3847;
  const host = process.env.HOST || '0.0.0.0';
  const app = createApp();
  app.listen(port, host, () => {
    const openHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`Plexus web: http://${openHost}:${port}`);
  });
}

module.exports = { createApp, startServer };
