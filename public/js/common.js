/* Shared helpers for every page: API calls, formatting, toasts, confirm dialogs, the brand mark,
   the theme button, scroll reveals, segmented controls and the drifting-bubble canvas. */
(function () {
  'use strict';
  const VG = (window.VG = {});

  // ---------- API ----------
  VG.api = async function (path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (init.body && init.method === 'GET') init.method = 'POST';
    let res;
    try { res = await fetch(path, init); } catch { throw new Error('Could not reach the server. Check your connection.'); }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status}).`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  };

  // ---------- Formatting ----------
  VG.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  VG.initials = (name) => (String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  VG.currency = '₹';
  VG.money = (n, cur) => {
    if (n == null || !isFinite(n)) return '—';
    const c = cur || VG.currency;
    const locale = c === '₹' ? 'en-IN' : 'en-US';
    return c + Number(n).toLocaleString(locale, { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 });
  };
  VG.num = (n, d = 0) => (n == null || !isFinite(n) ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }));
  VG.date = (t) => (t ? new Date(typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t + 'T00:00:00' : t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  VG.dateTime = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
  VG.time = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  VG.ago = (t) => {
    if (!t) return '—';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' d ago';
    return VG.date(t);
  };
  VG.size = (b) => (!b ? '' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB');
  VG.greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

  // ---------- Icons ----------
  const ic = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  VG.icon = {
    arrow: ic('<path d="M4 12h15M13 6l6 6-6 6"/>', 'class="arrow"'),
    home: ic('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
    news: ic('<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/>'),
    vault: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5"/>'),
    id: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14 10h4M14 13.5h3"/>'),
    chart: ic('<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>'),
    chat: ic('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/>'),
    gear: ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.8 3.1 2.6 3.5 5.2"/>'),
    check: ic('<path d="M20 6L9 17l-5-5"/>'),
    shield: ic('<path d="M12 3l8 3v6c0 4.6-3.4 8.4-8 9-4.6-.6-8-4.4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
    clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    upload: ic('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
    download: ic('<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
    eye: ic('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: ic('<path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1"/>'),
    x: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
    trash: ic('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    send: ic('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
    logout: ic('<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>'),
    sun: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 'class="sun"'),
    moon: ic('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', 'class="moon"'),
    menu: ic('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    link: ic('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
    file: ic('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>'),
    sheet: ic('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>'),
    copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    seal: ic('<circle cx="12" cy="9" r="5"/><path d="M9 13.5L7.5 21l4.5-2.5 4.5 2.5-1.5-7.5"/>'),
    spark: ic('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>'),
    book: ic('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7M8 11h5"/>'),
    bulb: ic('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/>'),
    gear2: ic('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6.5 8-6.5s7 2.5 8 6.5"/>'),
    pin: ic('<path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5M9 11l4-4 1-4"/>'),
    rocket: ic('<path d="M5 15c-1.5 1-2 4-2 6 2 0 5-.5 6-2"/><path d="M9 15l-3-3c1-4 4-9 12-9 0 8-5 11-9 12z"/><circle cx="15" cy="9" r="1.6"/>'),
    lock: ic('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
    inbox: ic('<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>'),
    refresh: ic('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>'),
    zoomIn: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
    zoomOut: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>'),
    ext: ic('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  };

  // ---------- Brand: the VINC mark from vinc-lab.com with "Global" ----------
  VG.wordmark = `<svg class="wordmark" viewBox="0 0 372 124" role="img" aria-label="VINC">
    <g class="wm-amber"><polygon points="4,24 40,24 84,116 56,116"/><polygon points="62,116 80,116 140,4 122,4"/><rect x="130" y="4" width="238" height="6" rx="3"/></g>
    <path class="wm-teal" d="M57.5 58 q9 -5 18 0 t17.5 0 L73.5 92 Z"/>
    <g class="wm-teal2"><circle cx="69" cy="47" r="4"/><circle cx="80" cy="36" r="3"/><circle cx="72" cy="27" r="2.2"/></g>
    <g class="wm-ink"><rect x="156" y="24" width="22" height="92"/><rect x="196" y="24" width="22" height="92"/><rect x="250" y="24" width="22" height="92"/><polygon points="196,24 218,24 272,116 250,116"/></g>
    <path class="wm-ink-s" d="M357 45 A35 35 0 1 0 357 95" fill="none" stroke-width="22"/>
  </svg>`;
  function paintBrand() {
    document.querySelectorAll('[data-brand]').forEach((el) => {
      el.innerHTML = VG.wordmark + '<span class="global">Global</span>';
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'VINC Global home');
    });
  }

  // ---------- Theme ----------
  function bindTheme() {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      b.innerHTML = VG.icon.moon + VG.icon.sun;
      b.setAttribute('aria-label', 'Switch light or dark theme');
      b.title = 'Light / dark';
      b.addEventListener('click', () => {
        const root = document.documentElement;
        const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        const next = cur === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('vg:theme', next); } catch { /* ignore */ }
        document.dispatchEvent(new CustomEvent('vg:theme'));
      });
    });
    document.querySelectorAll('[data-sound-toggle]').forEach((b) => {
      if (!b.innerHTML.trim()) b.innerHTML = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="sr-only">Background sound</span>';
    });
  }
  VG.isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  VG.cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  VG.reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Toasts ----------
  VG.toast = function (msg, type = '') {
    let box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = `<span>${VG.esc(msg)}</span>`;
    box.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, type === 'bad' ? 5200 : 3400);
  };

  // ---------- Confirm / prompt ----------
  VG.confirm = function (message, { title = 'Are you sure?', ok = 'Yes', danger = false, input = null } = {}) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'dlg';
      d.innerHTML = `<form method="dialog"><div class="dlg-body"><h3>${VG.esc(title)}</h3><p class="muted">${VG.esc(message)}</p>
        ${input ? `<label class="field"><span>${VG.esc(input.label)}</span><input class="input" name="v" type="${input.type || 'text'}" value="${VG.esc(input.value || '')}" ${input.attrs || ''}></label>` : ''}</div>
        <div class="dlg-foot"><button class="btn btn-soft" value="cancel" type="submit">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" type="submit">${VG.esc(ok)}</button></div></form>`;
      document.body.appendChild(d);
      d.addEventListener('close', () => {
        const okd = d.returnValue === 'ok';
        const v = input ? d.querySelector('[name=v]').value : true;
        d.remove();
        resolve(okd ? v : false);
      });
      d.showModal();
    });
  };

  // ---------- Buttons with a loading state ----------
  VG.busy = async function (btn, fn) {
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    try { return await fn(); } finally { if (btn) { btn.classList.remove('loading'); btn.disabled = false; } }
  };

  // ---------- Segmented control with a sliding pill ----------
  VG.seg = function (el, onChange) {
    let ind = el.querySelector('.seg-ind');
    if (!ind) { ind = document.createElement('span'); ind.className = 'seg-ind'; el.prepend(ind); }
    const btns = [...el.querySelectorAll('button')];
    const place = () => {
      const on = btns.find((b) => b.getAttribute('aria-pressed') === 'true') || btns[0];
      ind.style.width = on.offsetWidth + 'px'; ind.style.height = on.offsetHeight + 'px';
      ind.style.translate = `${on.offsetLeft}px ${on.offsetTop}px`;
    };
    btns.forEach((b) => b.addEventListener('click', () => {
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      place();
      onChange && onChange(b.dataset.value, b);
    }));
    requestAnimationFrame(place);
    window.addEventListener('resize', place);
    if (document.fonts) document.fonts.ready.then(place);
    return { place };
  };

  // ---------- Scroll reveals and pointer glow ----------
  VG.reveal = function (root = document) {
    const els = root.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window) || VG.reducedMotion()) { els.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach((e) => io.observe(e));
  };
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.glowy');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', e.clientX - r.left + 'px');
    card.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });

  // ---------- Count-up numbers ----------
  VG.countUp = function (el, to, { dur = 1200, format = (v) => VG.num(v) } = {}) {
    if (VG.reducedMotion() || !isFinite(to)) { el.textContent = format(to); return; }
    const from = 0, t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = format(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // ---------- Drifting bubbles: the lab-bench background used across VINC sites ----------
  VG.bubbles = function (canvas, { density = 1, dark = false } = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, parts = [], raf = 0, pointer = { x: -999, y: -999 };
    const colors = () => {
      const onBand = dark;
      return [VG.cssVar('--amber'), VG.cssVar('--teal-2'), VG.cssVar('--olive'), VG.cssVar('--plum'), onBand ? VG.cssVar('--band-accent') : VG.cssVar('--rust')];
    };
    let palette = colors();
    const make = (initial) => {
      const r = 2 + Math.random() * Math.random() * 16;
      return {
        x: Math.random() * w, y: initial ? Math.random() * h : h + r + Math.random() * 60, r,
        vy: 0.12 + Math.random() * 0.35 + (16 - r) * 0.012, sway: Math.random() * Math.PI * 2, swaySpeed: 0.004 + Math.random() * 0.01,
        c: palette[Math.floor(Math.random() * palette.length)], a: 0.12 + Math.random() * 0.28, ring: Math.random() < 0.35,
      };
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width; h = rect.height;
      canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(90, (w * h) / 14000) * density);
      parts = Array.from({ length: n }, () => make(true));
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.sway += p.swaySpeed;
        p.y -= p.vy;
        p.x += Math.sin(p.sway) * 0.25;
        const dx = p.x - pointer.x, dy = p.y - pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < 120 * 120) { const f = (1 - Math.sqrt(d2) / 120) * 1.4; p.x += (dx / (Math.sqrt(d2) + 1)) * f; p.y += (dy / (Math.sqrt(d2) + 1)) * f; }
        if (p.y < -p.r - 10) Object.assign(p, make(false));
        ctx.globalAlpha = p.a;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (p.ring) { ctx.strokeStyle = p.c; ctx.lineWidth = 1.5; ctx.stroke(); }
        else { ctx.fillStyle = p.c; ctx.fill(); }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('vg:theme', () => { palette = colors(); parts.forEach((p) => { p.c = palette[Math.floor(Math.random() * palette.length)]; }); });
    canvas.parentElement.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { passive: true });
    canvas.parentElement.addEventListener('pointerleave', () => { pointer = { x: -999, y: -999 }; });
    if (VG.reducedMotion()) { draw(); cancelAnimationFrame(raf); return; }
    // Pause when off screen to save battery.
    const io = new IntersectionObserver(([en]) => { cancelAnimationFrame(raf); if (en.isIntersecting) raf = requestAnimationFrame(draw); });
    io.observe(canvas);
  };

  // ---------- Password show/hide + strength ----------
  VG.bindPasswords = function (root = document) {
    root.querySelectorAll('.pwd-wrap').forEach((w) => {
      const input = w.querySelector('input');
      const b = w.querySelector('button');
      if (!b || b.dataset.bound) return;
      b.dataset.bound = '1';
      b.innerHTML = VG.icon.eye;
      b.setAttribute('aria-label', 'Show password');
      b.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.innerHTML = show ? VG.icon.eyeOff : VG.icon.eye;
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
  };
  VG.strength = function (p) {
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    const levels = [['Too short', 'var(--bad)'], ['Weak', 'var(--rust)'], ['Fair', 'var(--warn)'], ['Good', 'var(--amber)'], ['Strong', 'var(--teal)'], ['Very strong', 'var(--ok)']];
    return { score: s, label: levels[s][0], color: levels[s][1] };
  };

  // ---------- Session ----------
  VG.me = null;
  VG.loadMe = async function () {
    const r = await VG.api('/api/auth/me');
    VG.me = r.user; VG.settings = r.settings;
    if (r.settings && r.settings.currency) VG.currency = r.settings.currency;
    return r;
  };
  VG.logout = async function () {
    try { await VG.api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.href = '/login';
  };

  document.addEventListener('DOMContentLoaded', () => {
    paintBrand();
    bindTheme();
    VG.bindPasswords();
    VG.reveal();
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', VG.logout));
  });
})();
