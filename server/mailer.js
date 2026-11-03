'use strict';
// Outgoing email. Settings come from the environment (never from the repo):
//   SMTP_HOST, SMTP_PORT (587 = STARTTLS, 465 = TLS), SMTP_USER, SMTP_PASS,
//   MAIL_FROM (default "VINC Global <SMTP_USER>"), ADMIN_EMAIL (default SMTP_USER),
//   PUBLIC_URL (default https://vinc-global.com).
// Without SMTP_HOST nothing is sent; each email is recorded as "skipped" so the admin can see it.
// MAIL_TRANSPORT=json renders emails without sending them (used by the tests).
const nodemailer = require('nodemailer');
const { db } = require('./db');

const cfg = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  json: process.env.MAIL_TRANSPORT === 'json',
};
const FROM = process.env.MAIL_FROM || (cfg.user ? `VINC Global <${cfg.user}>` : 'VINC Global <no-reply@vinc-global.com>');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || cfg.user || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://vinc-global.com').replace(/\/+$/, '');

let transport = null;
if (cfg.json) transport = nodemailer.createTransport({ jsonTransport: true });
else if (cfg.host) {
  transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,          // 587 upgrades with STARTTLS
    requireTLS: cfg.port !== 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    pool: true, maxConnections: 2, maxMessages: 50,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => typeof s === 'string' && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s.trim());

/**
 * Branded email. `lines` are plain-text paragraphs (escaped here); `facts` is [label, value] rows;
 * `button` is { text, path } where path is relative to PUBLIC_URL.
 */
function render({ title, greeting, lines = [], facts = [], button, quote, footer }) {
  const url = button ? PUBLIC_URL + button.path : null;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F7F0E3;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F0E3;padding:28px 12px;font-family:'DM Sans',Segoe UI,Arial,sans-serif;color:#2B1A10;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td style="padding:0 6px 16px;">
      <span style="font:700 26px Georgia,'Times New Roman',serif;color:#2B1A10;letter-spacing:-.5px;"><span style="color:#D98A1C;">V</span>INC</span>
      <span style="font:500 12px 'Courier New',monospace;letter-spacing:4px;color:#1F6F66;padding-left:8px;">GLOBAL</span>
    </td></tr>
    <tr><td style="background:#FFF9EF;border:1px solid #DCCBAE;border-radius:18px;padding:28px 26px;">
      <h1 style="margin:0 0 14px;font:600 24px/1.25 Georgia,'Times New Roman',serif;color:#2B1A10;">${esc(title)}</h1>
      ${greeting ? `<p style="margin:0 0 12px;font-size:16px;line-height:1.55;">${esc(greeting)}</p>` : ''}
      ${lines.map((l) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.55;color:#5E4634;">${esc(l)}</p>`).join('')}
      ${quote ? `<div style="margin:6px 0 16px;padding:12px 16px;border-left:4px solid #D98A1C;background:#FBF3E4;border-radius:8px;font-size:15px;line-height:1.5;white-space:pre-wrap;color:#2B1A10;">${esc(quote)}</div>` : ''}
      ${facts.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;width:100%;border-collapse:collapse;">${facts.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #EFE2CC;font:500 12px 'Courier New',monospace;letter-spacing:1px;text-transform:uppercase;color:#6E5442;width:42%;">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #EFE2CC;font-size:16px;font-weight:700;color:#2B1A10;">${esc(v)}</td></tr>`).join('')}</table>` : ''}
      ${url ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;"><tr><td style="background:#D98A1C;border-radius:999px;"><a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-weight:700;font-size:16px;color:#2B1A10;text-decoration:none;">${esc(button.text)} &rarr;</a></td></tr></table>
      <p style="margin:10px 0 0;font-size:12px;color:#6E5442;">Or open <a href="${esc(url)}" style="color:#1F6F66;">${esc(url)}</a></p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:#6E5442;">
      ${esc(footer || 'You are receiving this because you are part of VINC Global, the portal for VINC\'s advisors and investors.')}<br>
      VINC · Bengaluru · <a href="${PUBLIC_URL}" style="color:#1F6F66;">vinc-global.com</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
  const text = [title, '', greeting, ...lines, quote ? `\n"${quote}"\n` : '', ...facts.map(([k, v]) => `${k}: ${v}`), url ? `\n${button.text}: ${url}` : '', '', footer || '', 'VINC Global · vinc-global.com']
    .filter((x) => x !== undefined && x !== null).join('\n');
  return { html, text };
}

// A simple in-process queue so requests never wait on the mail server.
const queue = [];
let busy = false;
const log = db.prepare('INSERT INTO email_log (to_addr, subject, kind, status, error, at) VALUES (?, ?, ?, ?, ?, ?)');
const sent = [];   // last JSON-rendered emails (tests only)

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    if (!transport) { log.run(job.to, job.subject, job.kind, 'skipped', 'Email is not set up (SMTP_HOST missing).', Date.now()); continue; }
    try {
      const info = await transport.sendMail({ from: FROM, to: job.to, replyTo: job.replyTo || ADMIN_EMAIL || undefined, subject: job.subject, html: job.html, text: job.text });
      if (cfg.json) { sent.push({ to: job.to, subject: job.subject, kind: job.kind, text: job.text }); if (sent.length > 200) sent.shift(); void info; }
      log.run(job.to, job.subject, job.kind, 'sent', null, Date.now());
    } catch (e) {
      if (!job.retried) { job.retried = true; queue.push(job); await new Promise((r) => setTimeout(r, 3000)); continue; }
      console.error('[mail] failed to', job.to, '-', e.message);
      log.run(job.to, job.subject, job.kind, 'failed', String(e.message || e).slice(0, 300), Date.now());
    }
  }
  busy = false;
}

/** Queue one email. Returns false (and sends nothing) when the address is missing or invalid. */
function send({ to, subject, kind, replyTo, ...content }) {
  if (!isEmail(to)) return false;
  const { html, text } = render(content);
  queue.push({ to: to.trim(), subject, kind, replyTo, html, text });
  setImmediate(pump);
  return true;
}

function status() {
  return { configured: !!transport && !cfg.json, host: cfg.host || null, port: cfg.host ? cfg.port : null, from: FROM, admin_email: ADMIN_EMAIL || null, public_url: PUBLIC_URL };
}

async function verify() {
  if (!transport || cfg.json) return { ok: false, error: 'Email is not set up on the server (SMTP_HOST missing).' };
  try { await transport.verify(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

// Wait until the queue is empty (tests and graceful shutdown).
async function drain(timeoutMs = 5000) {
  const t0 = Date.now();
  while ((queue.length || busy) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 20));
}

module.exports = { send, render, status, verify, drain, isEmail, ADMIN_EMAIL, PUBLIC_URL, sent };
