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
// Health check for Docker / uptime monitors.
app.get('/healthz', (_req, res) => {
  try { require('./db').db.prepare('SELECT 1').get(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
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

// Asset version: a hash of every CSS/JS/image file. Pages link to /css/x.css?v=<hash>, so after an update
// browsers fetch the new files instead of reusing ones cached from the previous version.
const crypto = require('node:crypto');
const fs = require('node:fs');
function assetVersion() {
  const h = crypto.createHash('sha1');
  for (const dir of ['css', 'js', 'img']) {
    const full = path.join(PUB, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) h.update(f).update(fs.readFileSync(path.join(full, f)));
  }
  return h.digest('hex').slice(0, 10);
}
const ASSET_V = assetVersion();
const pageCache = new Map();
function page(file) {
  if (!pageCache.has(file) || process.env.NODE_ENV !== 'production') {
    const html = fs.readFileSync(path.join(PUB, file), 'utf8')
      .replace(/(src|href)="(\/(?:css|js|img)\/[^"?#]+)"/g, `$1="$2?v=${ASSET_V}"`);
    pageCache.set(file, html);
  }
  return pageCache.get(file);
}

// Pages with clean URLs.
const pages = { '/': 'index.html', '/login': 'login.html', '/signup': 'signup.html', '/advisor': 'advisor.html', '/admin': 'admin.html' };
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(page(file));
  });
}
app.get(/^\/(index|login|signup|advisor|admin)\.html$/, (req, res) => res.redirect(301, req.path === '/index.html' ? '/' : req.path.replace(/\.html$/, '')));
// Versioned files (?v=…) never change, so browsers may keep them; anything else is re-checked each time.
app.use(express.static(PUB, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    const versioned = res.req && res.req.query && res.req.query.v;
    res.setHeader('Cache-Control', /\.html$/.test(filePath) ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
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
