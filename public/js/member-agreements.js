/* Advisor / investor portal: the Agreements section (list, signing screen, signed copies). */
(function () {
  'use strict';
  const VG = window.VG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const STATUS = {
    pending: ['To sign', 'warn'],
    member_signed: ['Waiting for VINC to countersign', 'teal'],
    executed: ['Signed by both parties', 'ok'],
  };
  const REQUIRED = ['name', 'relation_name', 'address1', 'pan', 'email', 'phone'];

  async function render(el, id, { onChanged }) {
    if (id) return renderSign(el, Number(id), { onChanged });
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div></div>';
    let d;
    try { d = await VG.api('/api/member/agreements'); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const me = VG.me || {};
    el.innerHTML = `<div class="section-title"><div><h2>Your agreements</h2>
        <p>${me.access_type === 'permanent' ? 'Your signed onboarding documents with VINC DEEPTECH PRIVATE LIMITED.' : 'Sign your onboarding document to become a permanent member of the VINC circle.'}</p></div></div>
      ${d.waiting_for_template ? `<div class="card">${emptyHtml('The VINC team is preparing your agreement. It will appear here, and you will get an email when it is ready.')}</div>` : ''}
      <div class="grid" style="gap:16px">${d.agreements.map(card).join('')}</div>
      <div class="card agr-note"><h3>How signing works</h3>
        <ol class="agr-how">
          <li><b>Fill in the blanks</b> directly on the document, or in the panel beside it.</li>
          <li><b>Sign</b> by drawing with your finger, mouse or pen, or by typing your name.</li>
          <li><b>We record</b> the date and time, the place you enter, and your IP address. Sharing your location is optional.</li>
          <li><b>VINC countersigns</b>, you become a permanent member, and the signed PDF is emailed to you.</li>
        </ol></div>`;
    $$('[data-open]', el).forEach((b) => b.addEventListener('click', () => { location.hash = `#agreements/${b.dataset.open}`; }));
    $$('[data-view-pdf]', el).forEach((b) => b.addEventListener('click', () => {
      const a = d.agreements.find((x) => String(x.id) === b.dataset.viewPdf);
      VG.viewer.open({ kind: 'pdf', title: `${a.title} · ${a.ref}`, src: `/api/member/agreements/${a.id}/document` });
    }));
  }

  function emptyHtml(text) { return `<div class="empty">${VG.icon.file}<p>${VG.esc(text)}</p></div>`; }

  function card(a) {
    const [label, cls] = STATUS[a.status] || [a.status, ''];
    return `<article class="card agr-card ${a.status}">
      <span class="agr-ic">${VG.icon.file}</span>
      <div class="agr-main"><p class="label" style="margin:0 0 4px">${VG.esc(a.ref)}</p><h3 style="margin:0 0 6px">${VG.esc(a.title)}</h3>
        <div class="btn-row" style="gap:8px"><span class="chip ${cls}"><span class="dot"></span>${label}</span>
          ${a.member_signed_at ? `<span class="muted small">You signed ${VG.dateTime(a.member_signed_at)}${a.member_place ? ', ' + VG.esc(a.member_place) : ''}</span>` : ''}
          ${a.company_signed_at ? `<span class="muted small">· VINC signed ${VG.dateTime(a.company_signed_at)}</span>` : ''}</div>
        ${a.last_void_reason && a.status === 'pending' ? `<p class="small" style="margin:8px 0 0;color:var(--bad)">The team asked you to sign again: ${VG.esc(a.last_void_reason)}</p>` : ''}</div>
      <div class="agr-actions">
        ${a.status === 'pending' ? `<button class="btn btn-amber" data-open="${a.id}">${VG.icon.spark} Review and sign</button>` : ''}
        ${a.status === 'executed' ? `<button class="btn btn-soft btn-sm" data-view-pdf="${a.id}">${VG.icon.eye} View</button><a class="btn btn-primary btn-sm" href="/api/member/agreements/${a.id}/document?download=1">${VG.icon.download} Download PDF</a>` : ''}
      </div></article>`;
  }

  // ------------------------------------------------------------------ the signing screen
  async function renderSign(el, id, { onChanged }) {
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div><span>Opening your agreement…</span></div>';
    let d;
    try { d = await VG.api(`/api/member/agreements/${id}`); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const ag = d.agreement;
    if (ag.status !== 'pending') { location.hash = '#agreements'; return; }
    const isTS = ag.kind === 'term_sheet';
    const state = {
      fields: { relation_type: 'S/o', ...pick(d.prefill, ['name', 'relation_type', 'relation_name', 'address1', 'address2', 'pan', 'email', 'phone', 'residence', 'ticket']) },
      place: '', signature: null, geo: null, consent: false,
    };
    const now = () => new Date();
    const preview = (key) => {
      const t = now();
      if (key === 'date_day') { const n = t.getDate(); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
      if (key === 'date_month') return t.toLocaleString('en-GB', { month: 'long' });
      if (key === 'date_year') return String(t.getFullYear()).slice(2);
      if (key === 'member_name') return state.fields.name || '';
      if (key === 'member_date') return 'When you sign';
      if (key === 'ticket_chosen') return d.tickets[state.fields.ticket] || '';
      return '';
    };

    el.innerHTML = `<div class="sign-head"><a href="#agreements" class="btn btn-soft btn-sm">← All agreements</a>
        <div><p class="label" style="margin:0">${VG.esc(ag.ref)}</p><h2 style="margin:0">${VG.esc(d.spec.title)}</h2></div>
        <div class="sign-progress" aria-live="polite"><span class="sp-text"></span><span class="meter"><i></i></span></div></div>
      <div class="sign-layout">
        <div class="sign-doc" id="sign-doc"><div class="viewer-loading"><div class="spinner"></div></div></div>
        <aside class="sign-panel card" id="sign-panel">
          <h3>1 · Your details</h3>
          <p class="muted small" style="margin-top:-6px">Type on the document, or here. Both stay in step.</p>
          <label class="field"><span>Full name</span><input class="input" data-k="name" maxlength="80" autocomplete="name"></label>
          <div class="field"><span>S/o / D/o / W/o</span><div class="rel-row"><select class="input" data-k="relation_type"><option>S/o</option><option>D/o</option><option>W/o</option></select><input class="input" data-k="relation_name" maxlength="80" placeholder="Father's or spouse's name"></div></div>
          <label class="field"><span>Address</span><input class="input" data-k="address1" maxlength="60" placeholder="House, street, area" autocomplete="address-line1"></label>
          <label class="field" style="margin-top:-8px"><input class="input" data-k="address2" maxlength="60" placeholder="City, PIN, state (optional)" autocomplete="address-line2"></label>
          <div class="form-row">
            <label class="field"><span>PAN</span><input class="input mono" data-k="pan" maxlength="10" placeholder="ABCDE1234F" autocapitalize="characters"></label>
            <label class="field"><span>Phone</span><input class="input" data-k="phone" maxlength="20" autocomplete="tel"></label>
          </div>
          <label class="field"><span>Email</span><input class="input" data-k="email" maxlength="120" autocomplete="email"></label>
          ${isTS ? `<div class="field"><span>Residential status</span><div class="choice-row" data-choice="residence">
              <button type="button" data-v="resident">Resident Indian</button><button type="button" data-v="nonresident">Non-Resident</button></div>
              <span class="hint">The other one is struck out on the document.</span></div>
            <div class="field"><span>Ticket size</span><div class="choice-row col" data-choice="ticket">
              <button type="button" data-v="1"><b>Option 1</b> · Rs. 6,00,000</button><button type="button" data-v="2"><b>Option 2</b> · Rs. 12,00,000</button></div></div>` : ''}
          <h3>2 · Place, date and time</h3>
          <label class="field"><span>Place of signing</span><input class="input" data-k="place" maxlength="60" placeholder="e.g. Bengaluru"></label>
          <div class="geo-row"><button type="button" class="btn btn-soft btn-sm" id="geo-btn">${VG.icon.spark.replace('<svg', '<svg width="14" height="14"')} Add my location <span class="muted">(optional)</span></button><span class="muted small" id="geo-status"></span></div>
          <p class="muted small sign-clock">Date and time are recorded when you sign: <b id="sign-clock"></b></p>
          <h3>3 · Your signature</h3>
          <div id="sigpad"></div>
          <label class="check consent"><input type="checkbox" id="consent"><span>${VG.esc(d.consent)}</span></label>
          <p class="form-error" id="sign-err" role="alert"></p>
          <div class="btn-row"><button type="button" class="btn btn-soft" id="next-btn">Next empty field ↓</button>
            <button type="button" class="btn btn-amber" id="sign-btn" style="flex:1">${VG.icon.check} Sign ${VG.esc(d.spec.title)}</button></div>
          <p class="muted small" style="margin:10px 0 0">The company side is signed by ${VG.esc(d.company.signer)}.</p>
        </aside>
      </div>`;

    const panel = $('#sign-panel');
    const pad = VG.SignaturePad($('#sigpad'), { name: state.fields.name || '', onChange: async () => { state.signature = pad.isEmpty() ? null : await pad.toDataURL(); update(); } });
    let doc = null;

    function update() {
      // Panel inputs
      $$('[data-k]', panel).forEach((i) => {
        const k = i.dataset.k;
        const v = k === 'place' ? state.place : state.fields[k];
        if (document.activeElement !== i && i.value !== (v || '')) i.value = v || (k === 'relation_type' ? 'S/o' : '');
      });
      $$('[data-choice]', panel).forEach((row) => $$('button', row).forEach((b) => b.setAttribute('aria-pressed', String(state.fields[row.dataset.choice] === b.dataset.v))));
      // Progress
      const req = [...REQUIRED, ...(isTS ? ['residence', 'ticket'] : [])];
      const done = req.filter((k) => (state.fields[k] || '').trim()).length + (state.place.trim() ? 1 : 0) + (state.signature ? 1 : 0);
      const total = req.length + 2;
      $('.sp-text', el).textContent = `${done} of ${total} done`;
      $('.sign-progress .meter i', el).style.setProperty('--p', Math.round((done / total) * 100) + '%');
      $('.sign-progress .meter i', el).style.setProperty('--c', done === total ? 'var(--ok)' : 'var(--amber)');
      if (doc) doc.sync();
    }
    const setField = (k, v) => {
      if (k === 'place') state.place = v; else state.fields[k] = v;
      if (k === 'name') pad.setName(v);
      update();
    };
    $$('[data-k]', panel).forEach((i) => i.addEventListener('input', () => setField(i.dataset.k, i.dataset.k === 'pan' ? i.value.toUpperCase() : i.value)));
    $$('[data-k]', panel).forEach((i) => { if (i.tagName === 'SELECT') i.addEventListener('change', () => setField(i.dataset.k, i.value)); });
    $$('[data-choice]', panel).forEach((row) => $$('button', row).forEach((b) => b.addEventListener('click', () => setField(row.dataset.choice, b.dataset.v))));

    // Live clock
    const clock = $('#sign-clock');
    const tickClock = () => { clock.textContent = new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST'; };
    tickClock();
    const clockTimer = setInterval(() => { if (!document.body.contains(clock)) clearInterval(clockTimer); else tickClock(); }, 15000);

    // Optional location
    $('#geo-btn').addEventListener('click', () => {
      const st = $('#geo-status');
      if (!navigator.geolocation) { st.textContent = 'Not available on this device.'; return; }
      st.textContent = 'Asking your browser…';
      navigator.geolocation.getCurrentPosition((p) => {
        state.geo = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        st.innerHTML = `<span style="color:var(--ok)">✓ Location added</span> (about ±${Math.round(p.coords.accuracy)} m)`;
      }, () => { st.textContent = 'Location not shared. That is fine, it is optional.'; }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
    });

    $('#consent').addEventListener('change', (e) => { state.consent = e.target.checked; });
    $('#next-btn').addEventListener('click', () => {
      if (doc && doc.focusNext()) return;
      if (!state.place.trim()) { panel.querySelector('[data-k=place]').focus(); return; }
      if (!state.signature) { $('#sigpad').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      $('#consent').focus();
    });

    // The document with its typing boxes
    try {
      doc = await VG.FieldDoc($('#sign-doc'), {
        url: `/api/member/agreements/${id}/document`, spec: d.spec, state, preview,
        onInput: setField,
        onChoice: (k, v) => setField(k, v),
        onSignClick: () => { $('#sigpad').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#sigpad').classList.remove('nudge'); void $('#sigpad').offsetWidth; $('#sigpad').classList.add('nudge'); },
      });
    } catch (e) { $('#sign-doc').innerHTML = `<div class="card">${emptyHtml('The document could not be opened. Please reload the page.')}</div>`; }
    update();

    $('#sign-btn').addEventListener('click', async () => {
      const err = $('#sign-err');
      err.textContent = '';
      state.signature = pad.isEmpty() ? null : await pad.toDataURL();
      update();
      if (!state.signature) { err.textContent = 'Please add your signature.'; $('#sigpad').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      if (!state.consent) { err.textContent = 'Please tick the box to agree to sign electronically.'; return; }
      const ok = await VG.confirm(`You are about to sign the ${d.spec.title}. Your details, signature, the date and time, place and IP address will be recorded and the document cannot be changed afterwards.`, { title: 'Sign this agreement?', ok: 'Sign now' });
      if (!ok) return;
      await VG.busy($('#sign-btn'), async () => {
        try {
          const r = await VG.api(`/api/member/agreements/${id}/sign`, { body: { fields: state.fields, place: state.place, signature: state.signature, geo: state.geo, consent: true } });
          success(el, d.spec.title, r);
          onChanged && onChanged(r);
        } catch (ex) { err.textContent = ex.message; }
      });
    });
  }

  function success(el, title, r) {
    el.innerHTML = `<div class="card sign-done">
        <svg class="tick" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45"/><path d="M30 52l13 13 27-29"/></svg>
        <p class="label">${r.executed ? 'Agreement executed' : 'Signed'}</p>
        <h2>${r.upgraded ? 'Welcome to the VINC circle' : r.executed ? 'Your agreement is signed' : 'Thank you for signing'}</h2>
        <p class="lead" style="margin-inline:auto">${r.upgraded ? `Your ${VG.esc(title)} is signed by both parties and you are now a <b>permanent member</b>. The signed PDF is on its way to your inbox.`
          : r.executed ? 'Signed by both parties. The signed PDF is on its way to your inbox.'
            : 'VINC will countersign shortly. You will get an email with the signed PDF, and your membership becomes permanent.'}</p>
        <div class="btn-row" style="justify-content:center"><a class="btn btn-primary" href="#agreements">See my agreements</a><a class="btn btn-soft" href="#home">Go to home</a></div>
      </div>`;
    if (r.upgraded || r.executed) burst(el.querySelector('.sign-done'));
  }

  function burst(host) {
    if (VG.reducedMotion()) return;
    const colors = ['var(--amber)', 'var(--teal-2)', 'var(--plum)', 'var(--olive)', 'var(--band-accent)'];
    for (let i = 0; i < 40; i++) {
      const b = document.createElement('i');
      b.className = 'confetti';
      b.style.background = colors[i % colors.length];
      host.appendChild(b);
      const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 220;
      b.animate([{ transform: 'translate(-50%,-50%) scale(.4)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist * 0.7 + 80}px)) rotate(${Math.random() * 720}deg)`, opacity: 0 }],
      { duration: 1400 + Math.random() * 900, easing: 'cubic-bezier(.22,1,.36,1)' }).onfinish = () => b.remove();
    }
  }

  function pick(o, keys) { const r = {}; for (const k of keys) if (o && o[k] != null) r[k] = o[k]; return r; }

  VG.memberAgreements = { render };
})();
