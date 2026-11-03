/* Signing tools shared by the member and admin pages:
   - VG.SignaturePad: draw with a finger, mouse or pen, or type the name in a handwriting font.
   - VG.FieldDoc: draws the agreement PDF with typing boxes placed on its blank lines. */
(function () {
  'use strict';
  const VG = window.VG;

  // ------------------------------------------------------------------ signature pad
  VG.SignaturePad = function (host, { name = '', onChange } = {}) {
    host.classList.add('sigpad');
    host.innerHTML = `<div class="sigpad-tabs" role="tablist">
        <button type="button" role="tab" aria-selected="true" data-mode="draw">${VG.icon.spark.replace('<svg', '<svg width="15" height="15"')} Draw</button>
        <button type="button" role="tab" aria-selected="false" data-mode="type">Aa Type</button></div>
      <div class="sigpad-draw"><canvas aria-label="Draw your signature here"></canvas><span class="sigpad-hint">Sign here</span><span class="sigpad-line"></span></div>
      <div class="sigpad-type" hidden><input class="input" maxlength="40" placeholder="Type your full name" aria-label="Type your signature">
        <div class="sigpad-fonts"><button type="button" data-font="Caveat" aria-pressed="true">Signature</button><button type="button" data-font="Dancing Script" aria-pressed="false">Script</button></div>
        <div class="sigpad-preview" aria-hidden="true"></div></div>
      <div class="sigpad-foot"><span class="muted small">Your signature is stored with this agreement only.</span><button type="button" class="btn btn-soft btn-xs" data-clear>Clear</button></div>`;
    const canvas = host.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const drawBox = host.querySelector('.sigpad-draw'), typeBox = host.querySelector('.sigpad-type');
    const input = typeBox.querySelector('input'), preview = typeBox.querySelector('.sigpad-preview');
    let mode = 'draw', strokes = [], current = null, font = 'Caveat';
    input.value = name;

    const size = () => {
      const r = drawBox.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
      canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    const redraw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#10225C';
      for (const s of strokes) {
        for (let i = 1; i < s.length; i++) {
          const a = s[i - 1], b = s[i];
          ctx.lineWidth = Math.max(1.4, Math.min(3.6, 3.4 - (b.v || 0) * 1.6));
          ctx.beginPath(); ctx.moveTo(a.x, a.y);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.quadraticCurveTo(a.x, a.y, mx, my); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x, s[0].y, 1.6, 0, Math.PI * 2); ctx.fillStyle = '#10225C'; ctx.fill(); }
      }
      drawBox.classList.toggle('has-ink', strokes.length > 0);
    };
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); current = [pt(e)]; strokes.push(current); redraw(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const p = pt(e), last = current[current.length - 1];
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      if (d < 1.2) return;
      p.v = Math.min(1, d / Math.max(1, p.t - last.t) / 2);
      current.push(p); redraw();
    });
    const end = () => { if (current) { current = null; onChange && onChange(); } };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end); canvas.addEventListener('pointerleave', end);

    const paintType = () => {
      preview.textContent = input.value || ' ';
      preview.style.fontFamily = `"${font}", cursive`;
      onChange && onChange();
    };
    input.addEventListener('input', paintType);
    typeBox.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
      font = b.dataset.font;
      typeBox.querySelectorAll('[data-font]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paintType();
    }));
    host.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      host.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      drawBox.hidden = mode !== 'draw'; typeBox.hidden = mode !== 'type';
      if (mode === 'draw') requestAnimationFrame(size); else { paintType(); input.focus(); }
      onChange && onChange();
    }));
    host.querySelector('[data-clear]').addEventListener('click', () => { strokes = []; input.value = ''; redraw(); paintType(); });
    window.addEventListener('resize', () => { if (mode === 'draw') size(); });
    requestAnimationFrame(size);
    if (document.fonts) { document.fonts.load('48px Caveat'); document.fonts.load('48px "Dancing Script"'); }

    // Export a tight PNG of the ink (drawn) or of the typed name.
    async function toDataURL() {
      if (mode === 'type') {
        const text = input.value.trim();
        if (!text) return null;
        if (document.fonts) await document.fonts.load(`96px "${font}"`);
        const c = document.createElement('canvas'), x = c.getContext('2d');
        x.font = `96px "${font}", cursive`;
        const w = Math.ceil(x.measureText(text).width) + 40;
        c.width = Math.min(1600, w); c.height = 150;
        x.font = `96px "${font}", cursive`; x.fillStyle = '#10225C'; x.textBaseline = 'middle';
        x.fillText(text, 20, 80, c.width - 40);
        return trim(c);
      }
      if (!strokes.length || strokes.flat().length < 4) return null;
      return trim(canvas);
    }
    function trim(c) {
      const x = c.getContext('2d');
      const { width, height } = c;
      const data = x.getImageData(0, 0, width, height).data;
      let t = height, l = width, b = 0, r = 0;
      for (let y = 0; y < height; y++) for (let i = 0; i < width; i++) {
        if (data[(y * width + i) * 4 + 3] > 8) { if (y < t) t = y; if (y > b) b = y; if (i < l) l = i; if (i > r) r = i; }
      }
      if (r <= l || b <= t) return null;
      const pad = 8, out = document.createElement('canvas');
      out.width = r - l + pad * 2; out.height = b - t + pad * 2;
      out.getContext('2d').drawImage(c, l - pad, t - pad, out.width, out.height, 0, 0, out.width, out.height);
      // Keep the file small: at most 900px wide.
      if (out.width > 900) {
        const s = 900 / out.width, sm = document.createElement('canvas');
        sm.width = 900; sm.height = Math.round(out.height * s);
        sm.getContext('2d').drawImage(out, 0, 0, sm.width, sm.height);
        return sm.toDataURL('image/png');
      }
      return out.toDataURL('image/png');
    }
    return {
      toDataURL,
      isEmpty: () => (mode === 'type' ? !input.value.trim() : strokes.length === 0),
      setName: (n) => { if (!input.value) { input.value = n; if (mode === 'type') paintType(); } },
      clear: () => host.querySelector('[data-clear]').click(),
    };
  };

  // ------------------------------------------------------------------ the document with typing boxes
  let pdfjsPromise = null;
  const loadPdfjs = () => (pdfjsPromise = pdfjsPromise || import('/vendor/pdfjs/build/pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs'; return m; }));

  /**
   * host: element to draw into. spec: { fields }. state: { fields, place, signature, residence, ticket }.
   * preview(key): text to show for automatic fields. onInput(key, value), onSignClick(), onChoice(key, value).
   */
  VG.FieldDoc = async function (host, { url, spec, state, preview, onInput, onSignClick, onChoice, editable = true }) {
    const pdfjs = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ url, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', isEvalSupported: false }).promise;
    host.innerHTML = '';
    host.classList.add('fielddoc');
    const pages = [];
    const pagesWithFields = new Set(spec.fields.map((f) => f.page));
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const wrap = document.createElement('div');
      wrap.className = 'fd-page' + (pagesWithFields.has(n) ? ' has-fields' : '');
      wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
      wrap.innerHTML = `<canvas></canvas><span class="fd-pg">Page ${n} of ${pdf.numPages}</span>`;
      host.appendChild(wrap);
      pages.push({ n, page, vp, wrap, drawnAt: 0 });
    }
    const boxes = {};
    const pct = (v, total) => (v / total) * 100 + '%';
    for (const f of spec.fields) {
      const p = pages[f.page - 1];
      if (!p) continue;
      const W = p.vp.width, H = p.vp.height;
      const h = f.h || 15;
      const el = document.createElement('div');
      el.className = `fd-field fd-${f.type || 'text'} src-${f.src}`;
      el.dataset.key = f.key;
      el.style.left = pct(f.x, W); el.style.width = pct(f.w, W);
      // Strike boxes sit centred on the words; everything else sits on its line.
      const top = f.type === 'strike' ? f.line - 6.5 : f.line - h;
      el.style.top = pct(top, H); el.style.height = pct(f.type === 'strike' ? 13 : h, H);
      if (f.type === 'signature') {
        el.innerHTML = f.src === 'member' ? `<button type="button" class="fd-sign">${VG.icon.spark.replace('<svg', '<svg width="12" height="12"')}<span>Click to sign</span></button>` : '<span class="fd-auto">VINC signs here</span>';
      } else if (f.type === 'tick' || f.type === 'strike') {
        el.innerHTML = `<button type="button" class="fd-choice" title="${VG.esc(f.label)}"></button>`;
      } else if (f.src === 'member' && editable) {
        if (f.key === 'relation') {
          el.innerHTML = `<select aria-label="S/o, D/o or W/o"><option>S/o</option><option>D/o</option><option>W/o</option></select><input aria-label="Father's or spouse's name" placeholder="Name">`;
        } else {
          el.innerHTML = `<input aria-label="${VG.esc(f.label)}" placeholder="${VG.esc(f.label)}">`;
        }
      } else {
        el.innerHTML = `<span class="fd-auto"></span>`;
      }
      p.wrap.appendChild(el);
      boxes[f.key] = { el, f };
    }

    // Wire inputs
    for (const { el, f } of Object.values(boxes)) {
      const inp = el.querySelector('input');
      const sel = el.querySelector('select');
      if (f.key === 'relation') {
        sel.addEventListener('change', () => onInput('relation_type', sel.value));
        inp.addEventListener('input', () => onInput('relation_name', inp.value));
      } else if (inp) {
        const key = f.key === 'member_place' ? 'place' : f.key;
        inp.addEventListener('input', () => onInput(key, f.key === 'pan' ? inp.value.toUpperCase() : inp.value));
      }
      const sign = el.querySelector('.fd-sign');
      if (sign) sign.addEventListener('click', () => onSignClick && onSignClick());
      const choice = el.querySelector('.fd-choice');
      if (choice) choice.addEventListener('click', () => {
        const [k, v] = f.when;
        // A strike box sits on an option's words: clicking it chooses that option (the other one is struck out).
        onChoice && onChoice(k, f.type === 'strike' ? f.choose : v);
      });
    }

    function sync() {
      const fs = state.fields;
      for (const { el, f } of Object.values(boxes)) {
        const inp = el.querySelector('input');
        if (f.key === 'relation') {
          const sel = el.querySelector('select');
          if (sel && sel.value !== (fs.relation_type || 'S/o')) sel.value = fs.relation_type || 'S/o';
          if (inp && document.activeElement !== inp) inp.value = fs.relation_name || '';
          el.classList.toggle('filled', !!fs.relation_name);
        } else if (inp) {
          const v = f.key === 'member_place' ? state.place : fs[f.key];
          if (document.activeElement !== inp) inp.value = v || '';
          el.classList.toggle('filled', !!v);
        } else if (f.type === 'signature' && f.src === 'member') {
          const btn = el.querySelector('.fd-sign');
          if (state.signature) { btn.innerHTML = `<img alt="Your signature" src="${state.signature}">`; el.classList.add('filled'); }
          else { btn.innerHTML = `${VG.icon.spark.replace('<svg', '<svg width="12" height="12"')}<span>Click to sign</span>`; el.classList.remove('filled'); }
        } else if (f.type === 'tick' || f.type === 'strike') {
          const [k, v] = f.when;
          el.classList.toggle('on', fs[k] === v);
          el.classList.toggle('filled', !!fs[k]);
        } else {
          const span = el.querySelector('.fd-auto');
          if (span && f.src !== 'company') { const t = preview(f.key); span.textContent = t || ''; el.classList.toggle('filled', !!t); }
          else if (span && f.src === 'company' && f.type !== 'signature') span.textContent = 'Filled when VINC signs';
        }
      }
    }

    // Render pages to canvases (sharp at any width), and size the text in the boxes to the page.
    async function render() {
      for (const p of pages) {
        const width = p.wrap.clientWidth;
        if (!width || Math.abs(width - p.drawnAt) < 2) continue;
        p.drawnAt = width;
        const scale = width / p.vp.width;
        const dpr = Math.min(2.5, window.devicePixelRatio || 1);
        const vp = p.page.getViewport({ scale: scale * dpr });
        const canvas = p.wrap.querySelector('canvas');
        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        p.wrap.style.setProperty('--fs', (10 * scale).toFixed(2) + 'px');
        await p.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise.catch(() => {});
      }
    }
    await render();
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 200); });
    sync();
    return {
      sync,
      focusNext() {
        const order = spec.fields.filter((f) => f.src === 'member');
        for (const f of order) {
          const b = boxes[f.key];
          if (!b || b.el.classList.contains('filled')) continue;
          if (f.key === 'address2') continue;              // optional
          b.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          b.el.classList.remove('nudge'); void b.el.offsetWidth; b.el.classList.add('nudge');
          const inp = b.el.querySelector('input, button');
          if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 350);
          return true;
        }
        return false;
      },
    };
  };
})();
