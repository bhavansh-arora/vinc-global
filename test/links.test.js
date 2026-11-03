'use strict';
// Links in the data room: embeddable addresses and whether a site may be shown inside the portal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.LINK_CHECK_ALLOW_PRIVATE = '1';
process.env.PUBLIC_URL = 'https://vinc-global.com';
const L = require('../server/links.js');

test('share links become their embeddable form', () => {
  assert.equal(L.toEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3').url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(L.toEmbed('https://youtu.be/dQw4w9WgXcQ').url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(L.toEmbed('https://vimeo.com/123456789').url, 'https://player.vimeo.com/video/123456789');
  assert.equal(L.toEmbed('https://docs.google.com/spreadsheets/d/1AbC_x-9/edit#gid=0').url, 'https://docs.google.com/spreadsheets/d/1AbC_x-9/preview');
  assert.equal(L.toEmbed('https://docs.google.com/presentation/d/1XyZ/edit?usp=sharing').url, 'https://docs.google.com/presentation/d/1XyZ/preview');
  assert.equal(L.toEmbed('https://drive.google.com/file/d/1FiLe/view?usp=sharing').url, 'https://drive.google.com/file/d/1FiLe/preview');
  assert.equal(L.toEmbed('https://drive.google.com/open?id=1FiLe').url, 'https://drive.google.com/file/d/1FiLe/preview');
  assert.equal(L.toEmbed('https://www.loom.com/share/abc123').url, 'https://www.loom.com/embed/abc123');
  assert.equal(L.toEmbed('http://example.com/page').url, 'https://example.com/page');
  assert.equal(L.toEmbed('https://example.com/page').provider, null);
});

test('framing rules are read the way browsers read them', () => {
  const h = (o) => new Headers(o);
  assert.equal(L.frameVerdict(h({})).frameable, true);
  assert.equal(L.frameVerdict(h({ 'x-frame-options': 'SAMEORIGIN' })).frameable, false);
  assert.equal(L.frameVerdict(h({ 'x-frame-options': 'deny' })).frameable, false);
  assert.equal(L.frameVerdict(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://vinc-global.com" })).frameable, true);
  assert.equal(L.frameVerdict(h({ 'content-security-policy': 'frame-ancestors https://*.vinc-global.com' })).frameable, false, 'a subdomain wildcard does not cover the bare domain');
  assert.equal(L.frameVerdict(h({ 'content-security-policy': "frame-ancestors 'none'" })).frameable, false);
  // frame-ancestors wins over X-Frame-Options
  assert.equal(L.frameVerdict(h({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' })).frameable, true);
  assert.equal(L.isPrivate('10.1.2.3'), true);
  assert.equal(L.isPrivate('172.20.0.5'), true);
  assert.equal(L.isPrivate('8.8.8.8'), false);
});

let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.end('<p>ok</p>'); return; }
    if (req.url === '/deny') { res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.end('no'); return; }
    if (req.url === '/allow-us') { res.setHeader('Content-Security-Policy', 'frame-ancestors https://vinc-global.com'); res.end('ok'); return; }
    if (req.url === '/hop') { res.statusCode = 302; res.setHeader('Location', '/deny'); res.end(); return; }
    res.statusCode = 404; res.end();
  });
  server.listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('the server asks the site, following redirects', async () => {
  assert.equal((await L.check(base + '/ok', { upgradeHttp: false })).frameable, true);
  assert.equal((await L.check(base + '/allow-us', { upgradeHttp: false })).frameable, true);
  const deny = await L.check(base + '/deny', { upgradeHttp: false });
  assert.equal(deny.frameable, false);
  assert.equal(deny.reason, 'refuses');
  assert.equal((await L.check(base + '/hop', { upgradeHttp: false })).frameable, false);
  assert.equal((await L.check(base + '/missing', { upgradeHttp: false })).reason, 'not_found');
});
