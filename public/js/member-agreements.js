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
  const LOAN_REQUIRED = ['folio', 'loan_amount', 'tenure', 'bank_holder', 'bank_name', 'bank_account', 'bank_ifsc'];

  /** 550000 → "Five Lakh Fifty Thousand" (Indian numbering, as printed on the agreement). */
  function inWords(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (!n) return 'Zero';
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = (x) => (x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : ''));
    const three = (x) => (x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' + two(x % 100) : '') : two(x));
    const parts = [];
    const crore = Math.floor(n / 1e7); n %= 1e7;
    const lakh = Math.floor(n / 1e5); n %= 1e5;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(inWords(crore) + ' Crore');
    if (lakh) parts.push(two(lakh) + ' Lakh');
    if (thousand) parts.push(two(thousand) + ' Thousand');
    if (n) parts.push(three(n));
    return parts.join(' ');
  }

  async function render(el, id, { onChanged }) {
    if (id) return renderSign(el, Number(id), { onChanged });
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div></div>';
    let d;
    try { d = await VG.api('/api/member/agreements'); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const me = VG.me || {};
    el.innerHTML = `<div class="section-title"><div><h2>Your agreements</h2>
        <p>${me.access_type === 'permanent' || (d.steam_ie && !d.agreements.length) ? 'Your agreements with VINC DEEPTECH PRIVATE LIMITED.' : `To become a permanent member, sign your ${VG.esc(requiredNames(d.agreements) || 'onboarding documents')}.`}</p></div></div>
      ${d.waiting_for_template ? `<div class="card">${emptyHtml(d.steam_ie ? 'Your onboarding agreement for the STEAM-IE share swap is being prepared. It will appear here, and you will get an email when it is ready to sign.' : 'The VINC team is preparing your agreement. It will appear here, and you will get an email when it is ready.')}</div>` : ''}
      ${listHtml(d)}
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
      const toSign = a.status === 'pending';
      VG.viewer.open({
        kind: 'pdf', title: `${a.title} · ${a.ref}`, src: `/api/member/agreements/${a.id}/document`,
        subtitle: toSign ? 'Read it in full before you sign. Nothing is signed by viewing.' : a.status === 'member_signed' ? 'Your signed copy, waiting for VINC to countersign' : 'Signed by both parties',
        action: toSign ? { label: a.group ? 'Choose and sign' : 'Sign this agreement', icon: VG.icon.spark.replace('<svg', '<svg width="14" height="14"'), onClick: () => { location.hash = `#agreements/${a.id}`; } } : null,
      });
    }));
  }

  // Standalone documents first, then each "sign any one of these" group in its own panel.
  function listHtml(d) {
    const single = d.agreements.filter((a) => !a.group);
    const groups = [...new Set(d.agreements.filter((a) => a.group).map((a) => a.group))];
    let html = `<div class="grid" style="gap:16px">${single.map((a) => card(a)).join('')}</div>`;
    for (const g of groups) {
      const items = d.agreements.filter((a) => a.group === g);
      const chosen = items.find((a) => a.status !== 'pending');
      html += items.length > 1 && !chosen
        ? `<section class="agr-choice"><div class="agr-choice-head"><span class="agr-or">Choose one</span>
            <div><h3>${VG.esc((d.groups && d.groups[g] && d.groups[g].title) || 'Choose one')}: sign any one of these ${items.length}</h3>
            <p class="muted small">Pick the one that matches how you are investing. When you sign it, the others are withdrawn.</p></div></div>
            <div class="grid" style="gap:12px">${items.map((a) => card(a, true)).join('')}</div></section>`
        : `<div class="grid" style="gap:16px">${items.map((a) => card(a)).join('')}</div>`;
    }
    return html;
  }

  /** "Advisory Agreement and one of: Investor Term Sheet, Shareholder Loan Agreement or Convertible Debt Note Agreement" */
  function describe(list) {
    const and = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0] || '');
    const or = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}` : a[0] || '');
    const parts = [], seen = new Set();
    for (const a of list) {
      if (!a.group) { parts.push(a.title); continue; }
      if (seen.has(a.group)) continue;
      seen.add(a.group);
      const titles = list.filter((x) => x.group === a.group).map((x) => x.title);
      parts.push(titles.length > 1 ? `one of: ${or(titles)}` : titles[0]);
    }
    return and(parts);
  }
  function requiredNames(list) { return describe(list.filter((a) => a.mandatory)); }

  function emptyHtml(text) { return `<div class="empty">${VG.icon.file}<p>${VG.esc(text)}</p></div>`; }

  function card(a, inChoice) {
    const [label, cls] = a.updating ? ['Being updated by VINC', ''] : (STATUS[a.status] || [a.status, '']);
    return `<article class="card agr-card ${a.status}">
      <span class="agr-ic">${VG.icon.file}</span>
      <div class="agr-main"><p class="label" style="margin:0 0 4px">${VG.esc(a.ref)}</p><h3 style="margin:0 0 6px">${VG.esc(a.title)}</h3>
        <div class="btn-row" style="gap:8px"><span class="chip ${cls}"><span class="dot"></span>${label}</span>${inChoice ? '<span class="chip plum">Option</span>' : a.mandatory ? '<span class="chip">Required</span>' : '<span class="chip">Optional</span>'}
          ${a.member_signed_at ? `<span class="muted small">You signed ${VG.dateTime(a.member_signed_at)}${a.member_place ? ', ' + VG.esc(a.member_place) : ''}</span>` : ''}
          ${a.company_signed_at ? `<span class="muted small">· VINC signed ${VG.dateTime(a.company_signed_at)}</span>` : ''}</div>
        ${a.last_void_reason && a.status === 'pending' ? `<p class="small" style="margin:8px 0 0;color:var(--bad)">The team asked you to sign again: ${VG.esc(a.last_void_reason)}</p>` : ''}</div>
      <div class="agr-actions">
        ${!a.updating ? `<button class="btn btn-soft ${a.status === 'pending' ? '' : 'btn-sm'}" data-view-pdf="${a.id}" title="Read the full document">${VG.icon.eye} View</button>` : ''}
        ${a.status === 'pending' && !a.updating ? `<button class="btn ${inChoice ? 'btn-soft' : 'btn-amber'}" data-open="${a.id}">${VG.icon.spark} ${inChoice ? 'Choose and sign' : 'Sign'}</button>` : ''}
        ${a.status === 'executed' ? `<a class="btn btn-primary btn-sm" href="/api/member/agreements/${a.id}/document?download=1">${VG.icon.download} Download PDF</a>` : ''}
      </div></article>`;
  }

  // ------------------------------------------------------------------ the signing screen
  async function renderSign(el, id, { onChanged }) {
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div><span>Opening your agreement…</span></div>';
    let d;
    try { d = await VG.api(`/api/member/agreements/${id}`); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const ag = d.agreement;
    if (ag.status !== 'pending') { location.hash = '#agreements'; return; }
    if (ag.updating) { el.innerHTML = `<div class="card">${emptyHtml('VINC is updating this document. Please check back shortly; you will be able to sign it here.')}</div>`; return; }
    const isTS = ag.kind === 'term_sheet' && !d.spec.custom;
    const isLoan = ag.kind === 'member_loan' && !d.spec.custom;
    const custom = !!d.spec.custom;
    const customFields = custom ? d.spec.fields.filter((f) => f.src === 'member' && !f.type && !f.placeOf) : [];
    const state = {
      fields: { relation_type: 'S/o', ...pick(d.prefill, ['name', 'relation_type', 'relation_name', 'address1', 'address2', 'pan', 'email', 'phone', 'residence', 'ticket']) },
      place: '', signature: null, geo: null, consent: false,
    };
    const now = () => new Date();
    const preview = (key, fd) => {
      const t = now();
      if (key === 'date_day') { const n = t.getDate(); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
      if (key === 'date_month') return t.toLocaleString('en-GB', { month: 'long' });
      if (key === 'date_year') return String(t.getFullYear()).slice(2);
      if (key === 'member_name') return state.fields.name || '';
      if (key === 'member_date') return 'When you sign';
      if (key === 'ticket_chosen') return d.tickets[state.fields.ticket] || '';
      // Member Loan Agreement: the amount and tenure typed once appear everywhere, with the words written out.
      const amount = Number(String(state.fields.loan_amount || '').replace(/[^\d]/g, ''));
      const tenure = Number(String(state.fields.tenure || '').replace(/[^\d]/g, ''));
      if (key === 'loan_amount_3') return amount ? amount.toLocaleString('en-IN') : '';
      if (key === 'loan_words_2' || key === 'loan_words_3') return amount ? inWords(amount) : '';
      if (key === 'maturity_months') return tenure ? String(tenure) : '';
      if (key === 'tenure_words') return tenure ? inWords(tenure).toLowerCase() : '';
      if (key === 'resolution_date') return (d.settings && d.settings.resolution_date) || '';
      if (key === 'disburse_days') return (d.settings && d.settings.disburse_days) || '';
      if (custom && fd) {
        const f = fd;
        if (f.mode === 'member_name') return (VG.me && VG.me.name) || '';
        if (f.mode === 'member_date') return 'When you sign';
        if (f.mode === 'date') return 'On signing';
      }
      return '';
    };

    el.innerHTML = `<div class="sign-head"><a href="#agreements" class="btn btn-soft btn-sm">← All agreements</a>
        <div><p class="label" style="margin:0">${VG.esc(ag.ref)}</p><h2 style="margin:0">${VG.esc(d.spec.title)}</h2></div>
        <div class="sign-progress" aria-live="polite"><span class="sp-text"></span><span class="meter"><i></i></span></div></div>
      <div class="sign-layout">
        <div class="sign-doc" id="sign-doc"><div class="viewer-loading"><div class="spinner"></div></div></div>
        <aside class="sign-panel card" id="sign-panel">
          <h3>1 · ${custom ? 'Fill in the blanks' : 'Your details'}</h3>
          <p class="muted small" style="margin-top:-6px">${custom && !customFields.length ? 'There is nothing to fill in on this document. Read it, then sign below.' : 'Type on the document, or here. Both stay in step.'}</p>
          ${custom ? customFields.map((f) => `<label class="field"><span>${VG.esc(f.label)}${f.optional ? ' <span class="hint">optional</span>' : ''}</span><input class="input" data-k="${f.key}" maxlength="120"></label>`).join('') : `
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
          ${isLoan ? `<label class="field"><span>Folio no. / number of equity shares held</span><input class="input" data-k="folio" maxlength="60" placeholder="e.g. Folio 0042 / 1,558 shares"></label>
            <div class="form-row">
              <label class="field"><span>Loan amount (Rs.)</span><input class="input mono" data-k="loan_amount" inputmode="numeric" maxlength="15" placeholder="500000"><span class="hint" id="loan-words"></span></label>
              <label class="field"><span>Tenure (months)</span><input class="input mono" data-k="tenure" inputmode="numeric" maxlength="3" placeholder="12"><span class="hint">At least 3; no more than 36</span></label>
            </div>
            <h4 class="label" style="margin:6px 0 8px">Bank account for interest and repayment (Schedule 1)</h4>
            <label class="field"><span>Account holder name</span><input class="input" data-k="bank_holder" maxlength="80"></label>
            <label class="field"><span>Bank and branch</span><input class="input" data-k="bank_name" maxlength="80" placeholder="e.g. HDFC Bank, Indiranagar"></label>
            <div class="form-row">
              <label class="field"><span>Account number</span><input class="input mono" data-k="bank_account" maxlength="24"></label>
              <label class="field"><span>IFSC</span><input class="input mono" data-k="bank_ifsc" maxlength="11" placeholder="HDFC0001234" autocapitalize="characters"></label>
            </div>` : ''}`}
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
    if (custom) state.fields = {};
    const pad = VG.SignaturePad($('#sigpad'), { name: state.fields.name || (VG.me && VG.me.name) || '', onChange: async () => { state.signature = pad.isEmpty() ? null : await pad.toDataURL(); update(); } });
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
      const req = custom ? customFields.filter((f) => !f.optional).map((f) => f.key) : [...REQUIRED, ...(isTS ? ['residence', 'ticket'] : []), ...(isLoan ? LOAN_REQUIRED : [])];
      const words = $('#loan-words', panel);
      if (words) { const n = Number(String(state.fields.loan_amount || '').replace(/[^\d]/g, '')); words.textContent = n ? `Rupees ${inWords(n)} only` : 'Figures only, for example 500000'; }
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
    const UPPER = ['pan', 'bank_ifsc', 'bank_account'];
    $$('[data-k]', panel).forEach((i) => i.addEventListener('input', () => setField(i.dataset.k, UPPER.includes(i.dataset.k) ? i.value.toUpperCase() : i.value)));
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

  VG.memberAgreements = { render, describe };
})();
