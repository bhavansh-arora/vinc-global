'use strict';
// Links in the data room open inside the portal. Many websites forbid being shown inside another page
// (X-Frame-Options or a Content-Security-Policy frame-ancestors rule), which leaves an empty panel.
// This module (1) rewrites common share links to their embeddable form and (2) asks the site, from the
// server, whether it allows being framed, so the viewer can show an "open in a new tab" card instead.
const dns = require('node:dns').promises;
const net = require('node:net');

const OUR_HOST = (() => { try { return new URL(process.env.PUBLIC_URL || 'https://vinc-global.com').host; } catch { return 'vinc-global.com'; } })();

/** Rewrite well-known share links to the version made for embedding. */
function toEmbed(raw, { upgradeHttp = true } = {}) {
  let u;
  try { u = new URL(raw); } catch { return { url: raw, provider: null }; }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const path = u.pathname;
  let m;
  // YouTube
  if (host === 'youtu.be' && (m = path.match(/^\/([\w-]{6,})/))) return { url: `https://www.youtube-nocookie.com/embed/${m[1]}`, provider: 'YouTube' };
  if (host === 'youtube.com') {
    const id = u.searchParams.get('v') || ((m = path.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/)) && m[1]);
    if (id) return { url: `https://www.youtube-nocookie.com/embed/${id}`, provider: 'YouTube' };
  }
  // Vimeo
  if (host === 'vimeo.com' && (m = path.match(/^\/(\d+)/))) return { url: `https://player.vimeo.com/video/${m[1]}`, provider: 'Vimeo' };
  // Google Docs, Sheets, Slides, Forms and Drive files
  if (host === 'docs.google.com') {
    if ((m = path.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/))) return { url: `https://docs.google.com/${m[1]}/d/${m[2]}/preview`, provider: 'Google' };
    if ((m = path.match(/^\/forms\/d\/(e\/)?([\w-]+)/))) return { url: `https://docs.google.com/forms/d/${m[1] || ''}${m[2]}/viewform?embedded=true`, provider: 'Google Forms' };
  }
  if (host === 'drive.google.com') {
    const id = ((m = path.match(/^\/file\/d\/([\w-]+)/)) && m[1]) || (path === '/open' && u.searchParams.get('id'));
    if (id) return { url: `https://drive.google.com/file/d/${id}/preview`, provider: 'Google Drive' };
  }
  // Loom, Figma, Canva
  if (host === 'loom.com' && (m = path.match(/^\/share\/([\w-]+)/))) return { url: `https://www.loom.com/embed/${m[1]}`, provider: 'Loom' };
  if (host === 'figma.com' && /^\/(file|design|proto|board)\//.test(path)) return { url: `https://www.figma.com/embed?embed_host=vinc-global&url=${encodeURIComponent(raw)}`, provider: 'Figma' };
  if (host === 'canva.com' && /^\/design\/[\w-]+\/[\w-]+\/view/.test(path)) { u.searchParams.set('embed', ''); return { url: u.toString(), provider: 'Canva' }; }
  // A secure page cannot show an insecure (http) one; try the https address.
  if (u.protocol === 'http:' && upgradeHttp) { u.protocol = 'https:'; return { url: u.toString(), provider: null, upgraded: true }; }
  return { url: u.toString(), provider: null };
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivate(v.slice(7));
}

/** Only public addresses: the server must never be used to reach machines on its own network. */
async function assertPublic(hostname) {
  if (process.env.LINK_CHECK_ALLOW_PRIVATE === '1') return;
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('private address');
}

/** Does this response allow us to show the page inside ours? */
function frameVerdict(headers) {
  const csp = String(headers.get('content-security-policy') || '');
  const fa = csp.split(/[;,]/).map((d) => d.trim()).find((d) => /^frame-ancestors\b/i.test(d));
  if (fa) {
    const sources = fa.split(/\s+/).slice(1).map((s) => s.toLowerCase());
    const ok = sources.some((s) => {
      if (s === '*') return true;
      if (s === "'none'" || s === "'self'") return false;
      const host = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (host.startsWith('*.')) return OUR_HOST.endsWith(host.slice(1));
      return host === OUR_HOST || s === 'https:';
    });
    return ok ? { frameable: true } : { frameable: false, reason: 'refuses' };
  }
  const xfo = String(headers.get('x-frame-options') || '').trim().toUpperCase();
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return { frameable: false, reason: 'refuses' };
  return { frameable: true };
}

const cache = new Map();   // url -> { at, result }

/** Ask the site (following redirects) whether it can be shown inside the portal. */
async function check(rawUrl, opts = {}) {
  const embed = toEmbed(rawUrl, opts);
  const hit = cache.get(embed.url);
  if (hit && Date.now() - hit.at < 3600e3) return hit.result;
  let result = { embed_url: embed.url, provider: embed.provider, frameable: null, reason: null };
  try {
    let url = embed.url;
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      await assertPublic(u.hostname);
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(7000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; VINC-Global-link-check/1.0)', accept: 'text/html,*/*;q=0.8' } });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
      const v = frameVerdict(res.headers);
      const finalHost = new URL(url).hostname;
      result = { ...result, ...v, final_url: url };
      // A private Google file sends people to the Google sign-in page, which refuses to be framed.
      if (/^accounts\.google\.com$/.test(finalHost)) result = { ...result, frameable: false, reason: 'google_private' };
      if (res.status >= 400) result = { ...result, frameable: res.status === 404 ? false : result.frameable, reason: res.status === 404 ? 'not_found' : result.reason };
      break;
    }
  } catch (e) {
    result = { ...result, frameable: embed.upgraded ? false : null, reason: embed.upgraded ? 'insecure' : 'unreachable' };
  }
  cache.set(embed.url, { at: Date.now(), result });
  return result;
}

const REASONS = {
  refuses: 'This website does not allow itself to be shown inside another page, so it opens in a new tab.',
  google_private: "This Google file isn't shared publicly. In Google, set sharing to “Anyone with the link can view” so it can open inside the portal.",
  insecure: 'This link uses an insecure (http) address, which browsers will not show inside a secure page.',
  not_found: 'The page could not be found. Check that the link is correct.',
  unreachable: 'The website could not be reached just now.',
};

module.exports = { toEmbed, frameVerdict, check, REASONS, isPrivate };
