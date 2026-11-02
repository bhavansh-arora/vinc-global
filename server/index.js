'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
require('./db');
const A = require('./auth');

const app = express();
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const NM = path.join(ROOT, 'node_modules');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
      // Links the admin publishes open inside the viewer, so any https page may be framed.
      frameSrc: ["'self'", 'https:'],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(A.loadUser);

// API
app.use('/api/auth', require('./routes-auth').router);
app.use('/api/member', require('./routes-member').router);
app.use('/api/chat', require('./routes-chat').member);
app.use('/api/admin/chats', require('./routes-chat').admin);
app.use('/api/admin', require('./routes-admin').router);
app.use('/api/files', require('./routes-files'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Front-end libraries served from node_modules (no CDN needed).
const vendor = (route, dir) => app.use(route, express.static(path.join(NM, dir), { maxAge: '7d', fallthrough: false }));
vendor('/vendor/pdfjs/build', 'pdfjs-dist/build');
vendor('/vendor/pdfjs/wasm', 'pdfjs-dist/wasm');
vendor('/vendor/pdfjs/cmaps', 'pdfjs-dist/cmaps');
vendor('/vendor/pdfjs/standard_fonts', 'pdfjs-dist/standard_fonts');
vendor('/vendor/chartjs', 'chart.js/dist');

// Pages with clean URLs.
const pages = { '/': 'index.html', '/login': 'login.html', '/signup': 'signup.html', '/advisor': 'advisor.html', '/admin': 'admin.html' };
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUB, file));
  });
}
app.use(express.static(PUB, { extensions: ['html'], maxAge: '1h' }));
app.use((_req, res) => res.status(404).sendFile(path.join(PUB, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`VINC Global portal running on http://localhost:${PORT}`));
}
module.exports = app;
