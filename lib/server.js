'use strict';

const path = require('path');
const express = require('express');
const { runRegistryAnalysis } = require('./engine');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  app.post('/api/analyze', async (req, res) => {
    try {
      const body = req.body;
      const pkg = body.packageJson ?? body;
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        return res.status(400).type('json').send({ error: 'Send JSON: { "packageJson": { ... } } or raw package.json fields' });
      }
      const flags = {
        fix: body.fix === true,
        bundleSize: body.bundleSize === true,
      };
      const result = await runRegistryAnalysis(pkg, flags);
      res.type('html').send(result.html);
    } catch (e) {
      console.error(e);
      res.status(500).type('json').send({ error: String(e.message || e) });
    }
  });

  return app;
}

function startServer(opts = {}) {
  const port = opts.port ?? 3847;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Plexus web: http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp, startServer };
