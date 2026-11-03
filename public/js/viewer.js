/* The view-only document container. PDFs, Excel sheets, links and images open in a panel on top of
   the current page with a Close button in its top bar (Esc also closes). PDFs are drawn onto canvases
   with PDF.js, with no download or print buttons and a watermark carrying the viewer's ID. Sheets
   arrive from the server as plain cell text, so the workbook file never reaches the browser. */
(function () {
  'use strict';
  const VG = window.VG;
  let pdfjsPromise = null;
  const loadPdfjs = () => {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/build/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
        return m;
      });
    }
    return pdfjsPromise;
  };

  const KIND_LABEL = { pdf: 'PDF', excel: 'XLS', link: 'LINK', image: 'IMG' };
  let current = null;

  function watermark(text) {
    const wm = document.createElement('div');
    wm.className = 'watermark';
    let html = '';
    for (let y = -10; y < 110; y += 16) for (let x = -20; x < 110; x += 38) html += `<span style="left:${x}%;top:${y}%">${VG.esc(text)}</span>`;
    wm.innerHTML = html;
    return wm;
  }

  function blockKeys(e) {
    if (!current) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'c'].includes(k)) e.preventDefault();
  }

  function open(opts) {
    if (current) close(true);
    const { kind, title = 'Document', src, url, sheetSrc, subtitle } = opts;
    const who = VG.me ? VG.me.uid : '';
    const wmText = `${who} · CONFIDENTIAL · ${new Date().toLocaleDateString('en-IN')}`;
    const el = document.createElement('div');
    el.className = 'viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title);
    el.innerHTML = `<div class="viewer-box">
      <div class="viewer-bar">
        <div class="vt"><span class="kind ${kind === 'image' ? 'img' : kind}" style="width:34px;height:40px;font-size:.58rem;padding-bottom:4px">${KIND_LABEL[kind] || ''}</span>
          <div style="min-width:0"><b>${VG.esc(title)}</b>${subtitle ? `<div class="muted small" style="line-height:1.2">${VG.esc(subtitle)}</div>` : ''}</div></div>
        <div class="vtools"></div>
        <span class="chip hide-sm" title="View only">${VG.icon.lock.replace('<svg', '<svg width="14" height="14"')} View only</span>
        <button class="viewer-close" type="button">${VG.icon.x}<span>Close</span></button>
      </div>
      <div class="viewer-body"><div class="viewer-loading"><div class="spinner"></div><span>Opening…</span></div></div>
    </div>`;
    const body = el.querySelector('.viewer-body');
    const tools = el.querySelector('.vtools');
    el.querySelector('.viewer-close').addEventListener('click', () => close());
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
    document.body.appendChild(el);
    document.body.classList.add('viewing');
    document.documentElement.style.overflow = 'hidden';
    current = { el, prevFocus: document.activeElement, cleanup: [] };
    document.addEventListener('keydown', blockKeys, true);
    el.querySelector('.viewer-close').focus();

    const fail = (msg) => { body.innerHTML = `<div class="viewer-loading"><div class="empty">${VG.icon.file}<b>Could not open this file</b><p class="muted">${VG.esc(msg)}</p></div></div>`; };

    if (kind === 'pdf') renderPdf(src, body, tools, wmText).catch((e) => fail(e.message || 'The PDF could not be read.'));
    else if (kind === 'excel') renderSheet(sheetSrc, body, wmText).catch((e) => fail(e.message));
    else if (kind === 'image') {
      body.innerHTML = `<div class="viewer-img"><img alt="${VG.esc(title)}" draggable="false"></div>`;
      const img = body.querySelector('img');
      img.onerror = () => fail('The image could not be loaded.');
      img.src = src;
      body.querySelector('.viewer-img').appendChild(watermark(wmText));
    } else if (kind === 'link') {
      renderLink(opts, body, el).catch(() => linkCard(body, { url, host: hostOf(url), message: 'The link could not be opened here.' }, title));
    }
  }

  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

  // Links: ask the server first. Sites that refuse to be shown inside another page get a clear card with an
  // "open in a new tab" button; the rest open right here, using the embeddable form of the link when there is one.
  async function renderLink(opts, body, el) {
    const me = current;
    let info = { url: opts.url, embed_url: opts.url, host: hostOf(opts.url), frameable: null };
    if (opts.docId) { try { info = await VG.api(`/api/files/doc/${opts.docId}/link`); } catch { /* fall back to the raw link */ } }
    if (current !== me) return;
    if (info.frameable === false) return linkCard(body, info, opts.title);
    body.classList.add('frame');
    body.innerHTML = '';
    const f = document.createElement('iframe');
    f.title = opts.title || 'Linked page';
    // Some players (YouTube) refuse to play without knowing which site embeds them.
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation');
    f.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write');
    f.allowFullscreen = true;
    f.src = info.embed_url || info.url;
    body.appendChild(f);
    const note = document.createElement('div');
    note.className = 'viewer-note';
    note.innerHTML = `<span>${VG.icon.link.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} ${VG.esc(info.host || hostOf(info.url))}${info.frameable === null ? ' · If this stays blank, the site does not allow being shown here.' : ''}</span>
      <a href="${VG.esc(info.url)}" target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>`;
    el.querySelector('.viewer-box').appendChild(note);
  }

  function linkCard(body, info, title) {
    body.classList.remove('frame');
    body.innerHTML = `<div class="link-card">
        <span class="link-card-ic">${VG.icon.link}</span>
        <p class="label" style="margin:0">${VG.esc(info.host || hostOf(info.url))}</p>
        <h3>${VG.esc(title || 'Linked page')}</h3>
        <p class="muted">${VG.esc(info.message || 'This website does not allow itself to be shown inside another page, so it opens in a new tab.')}</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn btn-primary" href="${VG.esc(info.url)}" target="_blank" rel="noopener noreferrer">${VG.icon.ext} Open ${VG.esc(info.host || 'the link')}</a>
          <button type="button" class="btn btn-soft" data-copy>${VG.icon.copy} Copy link</button>
        </div></div>`;
    body.querySelector('[data-copy]').addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(info.url); e.currentTarget.textContent = 'Copied ✓'; } catch { /* ignore */ }
    });
  }

  function close(immediate) {
    if (!current) return;
    const c = current;
    current = null;
    document.removeEventListener('keydown', blockKeys, true);
    c.cleanup.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    const done = () => {
      c.el.remove();
      document.body.classList.remove('viewing');
      document.documentElement.style.overflow = '';
      if (c.prevFocus && c.prevFocus.focus) c.prevFocus.focus();
    };
    if (immediate) return done();
    c.el.classList.add('closing');
    setTimeout(done, 220);
  }

  async function renderPdf(src, body, tools, wmText) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      url: src,
      cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      isEvalSupported: false,
      enableXfa: false,
    });
    const me = current;
    me.cleanup.push(() => task.destroy());
    const pdf = await task.promise;
    if (current !== me) return;
    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const fit = () => Math.min(1.6, Math.max(0.4, (body.clientWidth - 48) / base.width));
    let scale = fit();

    tools.innerHTML = `<button class="icon-btn" type="button" data-z="-1" aria-label="Zoom out" style="width:36px;height:36px">${VG.icon.zoomOut}</button>
      <span class="zoom">${Math.round(scale * 100)}%</span>
      <button class="icon-btn" type="button" data-z="1" aria-label="Zoom in" style="width:36px;height:36px">${VG.icon.zoomIn}</button>
      <span class="chip hide-sm">${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}</span>`;
    const zoomLabel = tools.querySelector('.zoom');

    const wrap = document.createElement('div');
    wrap.className = 'pdf-pages';
    body.innerHTML = '';
    body.appendChild(wrap);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const d = document.createElement('div');
      d.className = 'pdf-page';
      d.dataset.n = i;
      d.innerHTML = `<span class="pg">${i} / ${pdf.numPages}</span>`;
      d.appendChild(watermark(wmText));
      wrap.appendChild(d);
      pages.push({ el: d, rendered: 0, task: null });
    }
    // Placeholders use page 1's size (most PDFs share one); each page corrects itself when drawn.
    const sizeAll = () => {
      for (const p of pages) {
        const w = (p.w || base.width) * scale, h = (p.h || base.height) * scale;
        p.el.style.width = Math.floor(w) + 'px';
        p.el.style.height = Math.floor(h) + 'px';
      }
    };
    const render = async (p) => {
      if (p.rendered === scale) return;
      p.rendered = scale;
      const page = await pdf.getPage(Number(p.el.dataset.n));
      const unit = page.getViewport({ scale: 1 });
      p.w = unit.width; p.h = unit.height;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + 'px'; canvas.style.height = Math.floor(vp.height) + 'px';
      p.el.style.width = Math.floor(vp.width) + 'px'; p.el.style.height = Math.floor(vp.height) + 'px';
      if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
      p.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, canvas });
      try { await p.task.promise; } catch { return; }
      const old = p.el.querySelector('canvas');
      if (old) old.remove();
      p.el.prepend(canvas);
    };
    sizeAll();
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) render(pages[Number(en.target.dataset.n) - 1]);
    }), { root: body, rootMargin: '600px 0px' });
    pages.forEach((p) => io.observe(p.el));
    me.cleanup.push(() => io.disconnect());

    tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-z]');
      if (!b) return;
      scale = Math.min(3, Math.max(0.4, scale + Number(b.dataset.z) * 0.2));
      zoomLabel.textContent = Math.round(scale * 100) + '%';
      sizeAll();
      pages.forEach((p) => {
        const r = p.el.getBoundingClientRect(), br = body.getBoundingClientRect();
        if (r.bottom > br.top - 600 && r.top < br.bottom + 600) render(p);
      });
    });
  }

  async function renderSheet(src, body, wmText) {
    const data = await VG.api(src);
    const me = current;
    if (current !== me || !current) return;
    if (!data.sheets.length) throw new Error('This workbook has no visible sheets.');
    const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    body.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'sheet-tabs';
    const holder = document.createElement('div');
    holder.style.position = 'relative';
    body.append(tabs, holder);
    const show = (idx) => {
      const s = data.sheets[idx];
      tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === idx)));
      const cols = Math.max(1, s.cols);
      let html = '<table class="sheet"><thead><tr><th></th>';
      for (let c = 0; c < cols; c++) html += `<th>${colName(c)}</th>`;
      html += '</tr></thead><tbody>';
      s.rows.forEach((row, r) => {
        html += `<tr><th>${r + 1}</th>`;
        for (let c = 0; c < cols; c++) {
          const cell = row[c];
          const cls = cell ? [cell.n ? 'n' : '', cell.b ? 'b' : ''].join(' ').trim() : '';
          html += `<td${cls ? ` class="${cls}"` : ''}${cell && cell.t.length > 40 ? ` title="${VG.esc(cell.t)}"` : ''}>${cell ? VG.esc(cell.t) : ''}</td>`;
        }
        html += '</tr>';
      });
      html += '</tbody></table>';
      if (s.truncated) html += '<p class="muted small" style="padding:10px 14px">Showing the first 3,000 rows.</p>';
      holder.innerHTML = html;
      holder.appendChild(watermark(wmText));
      body.scrollTo(0, 0);
    };
    data.sheets.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = s.name;
      b.addEventListener('click', () => show(i));
      tabs.appendChild(b);
    });
    show(0);
  }

  VG.viewer = { open, close };

  // Open a document record from the API (members and admin share this).
  VG.openDocument = function (d) {
    if (d.kind === 'pdf') open({ kind: 'pdf', title: d.title, subtitle: d.description, src: `/api/files/doc/${d.id}/raw` });
    else if (d.kind === 'excel') open({ kind: 'excel', title: d.title, subtitle: d.description, sheetSrc: `/api/files/doc/${d.id}/sheet` });
    else open({ kind: 'link', title: d.title, subtitle: d.description, url: d.url, docId: d.id });
  };
  VG.openStored = function (title, mime, src, subtitle) {
    open({ kind: mime === 'application/pdf' ? 'pdf' : 'image', title, src, subtitle });
  };
})();
