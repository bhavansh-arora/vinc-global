/* Admin console: onboarding agreements (templates, company signature, countersigning, audit trail). */
(function () {
  'use strict';
  const VG = window.VG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const STATUS = {
    not_sent: ['Not sent yet', ''],
    pending: ['Waiting for member', 'warn'],
    member_signed: ['Countersign needed', 'bad'],
    executed: ['Executed', 'ok'],
  };
  const FIELD_LABELS = [['name', 'Name'], ['relation', 'S/o / D/o / W/o'], ['address', 'Address'], ['pan', 'PAN'], ['email', 'Email'], ['phone', 'Phone'], ['residence', 'Residential status'], ['ticket', 'Ticket size']];

  let ctx = null;   // { refreshStats, openMember }

  async function render(el, context) {
    ctx = context;
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div></div>';
    let d;
    try { d = await VG.api('/api/admin/agreements'); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const toSign = d.rows.filter((r) => r.status === 'member_signed').length;
    el.innerHTML = `<div class="section-title"><div><h2>Onboarding agreements</h2>
        <p>Advisors sign the Advisory Agreement <b>and</b> the Investor Term Sheet; investors sign the Investor Term Sheet. Once everything required is signed by both sides, the member becomes permanent automatically.</p></div></div>
      <div class="grid grid-2" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Documents</h3></div>
          <p class="muted small" style="margin-top:-6px">Upload each PDF once. It is stored privately on the server and shown to members to fill in and sign.</p>
          <div class="grid" style="gap:12px">${d.templates.map(templateCard).join('')}</div></div>
        <div class="card" id="company-card">${companyCard(d.company)}</div>
      </div>
      <div class="card" id="custom-card"><div class="card-head"><h3>Other agreements</h3><button type="button" class="btn btn-primary btn-sm" id="custom-new">${VG.icon.plus} Upload an agreement</button></div>
        <p class="muted small" style="margin-top:-6px">Any PDF: an NDA, a side letter, an addendum. Blanks drawn with underscores are found automatically and you choose what each one is for. Both signatures, with date, time and place, go on a signature page added at the end.</p>
        <form id="custom-form" class="custom-form" hidden>
          <div class="form-row"><label class="field"><span>Title</span><input class="input" name="title" maxlength="120" required placeholder="e.g. Non-Disclosure Agreement"></label>
            <label class="drop" style="min-height:0;padding:14px">${VG.icon.upload}<b>Choose the PDF</b><span class="file-name"></span><input type="file" name="file" accept="application/pdf,.pdf"></label></div>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" name="required" value="1"> Required for permanent membership</label>
          <p class="form-error" id="custom-err"></p>
          <div class="btn-row"><button class="btn btn-primary btn-sm" type="submit">Upload and set up blanks</button><button class="btn btn-soft btn-sm" type="button" id="custom-cancel">Cancel</button></div>
        </form>
        <div id="custom-list">${customList(d.custom)}</div></div>
      <div class="card"><div class="card-head"><h3>Agreements ${toSign ? `<span class="chip bad">${toSign} to countersign</span>` : ''}</h3>
          <div class="filters"><button class="filter" aria-pressed="true" data-f="">All</button><button class="filter" aria-pressed="false" data-f="member_signed">Countersign</button><button class="filter" aria-pressed="false" data-f="pending">Waiting</button><button class="filter" aria-pressed="false" data-f="executed">Executed</button></div></div>
        <div id="agr-table"></div></div>`;

    // Templates
    $$('[data-upload]', el).forEach((inp) => inp.addEventListener('change', async () => {
      if (!inp.files.length) return;
      const fd = new FormData(); fd.append('file', inp.files[0]);
      const card = inp.closest('.tpl');
      card.classList.add('busy');
      try {
        const t = await VG.api(`/api/admin/agreements/templates/${inp.dataset.upload}`, { method: 'POST', form: fd });
        VG.toast(`${t.title} uploaded.${t.matches_layout ? '' : ' Note: this file differs from the version the blanks were measured on; check a preview after the first signing.'}`, t.matches_layout ? 'ok' : 'bad');
        render(el, ctx);
      } catch (e) { VG.toast(e.message, 'bad'); card.classList.remove('busy'); }
    }));
    $$('[data-view-tpl]', el).forEach((b) => b.addEventListener('click', () => VG.viewer.open({ kind: 'pdf', title: b.dataset.title, src: `/api/admin/agreements/templates/${b.dataset.viewTpl}/raw` })));

    bindCompany(el, d.company);
    bindCustom(el, d);

    const paint = (f) => {
      const rows = d.rows.filter((r) => !f || r.status === f);
      $('#agr-table').innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Document</th><th>Status</th><th>Member signed</th><th>VINC signed</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td><b>${VG.esc(r.user.name || '—')}</b><div class="muted small mono">${VG.esc(r.user.uid)} · ${r.user.role === 'investor' ? 'Investor' : 'Advisor'}${r.user.access_type === 'permanent' ? ' · permanent' : ''}</div></td>
          <td>${VG.esc(r.title)} ${r.mandatory ? '' : '<span class="chip" style="font-size:.68rem">Optional</span>'}${r.ref ? `<div class="muted small mono">${VG.esc(r.ref)}</div>` : ''}</td>
          <td><span class="chip ${STATUS[r.status][1]}"><span class="dot"></span>${STATUS[r.status][0]}</span></td>
          <td class="small">${r.member_signed_at ? `${VG.dateTime(r.member_signed_at)}<div class="muted">${VG.esc(r.member_place || '')}</div>` : '—'}</td>
          <td class="small">${r.company_signed_at ? `${VG.dateTime(r.company_signed_at)}<div class="muted">${VG.esc(r.company_place || '')}${r.company_method === 'auto' ? ' · auto' : ''}</div>` : '—'}</td>
          <td><div class="actions">${actions(r)}</div></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${VG.icon.file}<p>${d.rows.length ? 'Nothing here.' : 'Members appear here once they sign up with their VINC ID.'}</p></div>`;
      bindRows(el, d);
    };
    $$('[data-f]', el).forEach((b) => b.addEventListener('click', () => { $$('[data-f]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(b.dataset.f); }));
    paint('');
  }

  function templateCard(t) {
    return `<div class="tpl ${t.uploaded ? 'ok' : ''}">
      <span class="kind pdf" style="width:38px;height:46px;font-size:.6rem;padding-bottom:5px">PDF</span>
      <div style="flex:1;min-width:0"><b>${VG.esc(t.title)}</b> <span class="chip" style="font-size:.7rem">Required: ${VG.esc(t.required_for)}</span>
        <div class="muted small">${t.uploaded ? `${VG.esc(t.original_name || '')} · ${t.pages} pages · ${VG.date(t.uploaded_at)}` : 'Not uploaded yet'}</div>
        ${t.uploaded ? (t.matches_layout ? '<div class="small" style="color:var(--ok)">✓ Blanks positioned for this exact file</div>' : '<div class="small" style="color:var(--warn)">Different file from the one the blanks were measured on</div>') : ''}</div>
      <div class="btn-row">${t.uploaded ? `<button class="btn btn-soft btn-xs" data-view-tpl="${t.kind}" data-title="${VG.esc(t.title)}">View</button>` : ''}
        <label class="btn ${t.uploaded ? 'btn-soft' : 'btn-primary'} btn-xs">${t.uploaded ? 'Replace' : `${VG.icon.upload} Upload`}<input type="file" accept="application/pdf,.pdf" data-upload="${t.kind}" hidden></label></div>
    </div>`;
  }

  function companyCard(c) {
    return `<div class="card-head"><h3>Company signature</h3>${c.has_signature ? '<span class="chip ok"><span class="dot"></span>Saved</span>' : '<span class="chip warn"><span class="dot"></span>Not set</span>'}</div>
      <p class="muted small" style="margin-top:-6px">Signs for VINC DEEPTECH PRIVATE LIMITED on every agreement.</p>
      <div class="form-row">
        <label class="field"><span>Signatory</span><input class="input" id="cs-name" value="${VG.esc(c.signer_name)}"></label>
        <label class="field"><span>Designation</span><input class="input" id="cs-title" value="${VG.esc(c.signer_title)}"></label>
      </div>
      <label class="field"><span>Default place of signing</span><input class="input" id="cs-place" value="${VG.esc(c.place)}"></label>
      ${c.has_signature ? `<div class="cs-sig"><img alt="Saved company signature" src="/api/admin/agreements/company/signature?t=${c.signature_set_at || ''}"><span class="muted small">Saved ${VG.date(c.signature_set_at)}</span><button type="button" class="btn btn-soft btn-xs" id="cs-redo">Change signature</button></div>` : ''}
      <div id="cs-pad-wrap" ${c.has_signature ? 'hidden' : ''}><div id="cs-pad"></div></div>
      <label class="switch" style="margin:16px 0 14px"><input type="checkbox" id="cs-auto" ${c.auto ? 'checked' : ''} ${c.has_signature ? '' : 'disabled'}><span class="track" aria-hidden="true"></span>
        <span><b>Countersign automatically</b><br><span class="muted small">When a member signs, apply this signature straight away with the date, time and default place, so they become permanent at once. When off, you review and countersign each one.</span></span></label>
      <button class="btn btn-primary btn-sm" id="cs-save" type="button">Save</button>`;
  }

  function bindCompany(el, c) {
    const card = $('#company-card', el);
    let pad = null;
    const ensurePad = () => { if (!pad) pad = VG.SignaturePad($('#cs-pad', card), { name: c.signer_name }); };
    if (!c.has_signature) ensurePad();
    const redo = $('#cs-redo', card);
    if (redo) redo.addEventListener('click', () => { $('#cs-pad-wrap', card).hidden = false; ensurePad(); redo.disabled = true; });
    $('#cs-auto', card).addEventListener('change', async (e) => {
      try { await VG.api('/api/admin/agreements/company', { method: 'PUT', body: { auto: e.target.checked } }); VG.toast(e.target.checked ? 'Agreements will be countersigned automatically.' : 'You will countersign each agreement.', 'ok'); }
      catch (ex) { e.target.checked = !e.target.checked; VG.toast(ex.message, 'bad'); }
    });
    $('#cs-save', card).addEventListener('click', () => VG.busy($('#cs-save', card), async () => {
      const body = { signer_name: $('#cs-name', card).value, signer_title: $('#cs-title', card).value, place: $('#cs-place', card).value };
      if (pad && !$('#cs-pad-wrap', card).hidden) {
        if (pad.isEmpty()) { VG.toast('Draw or type the signature first.', 'bad'); return; }
        body.signature = await pad.toDataURL();
      }
      try { await VG.api('/api/admin/agreements/company', { method: 'PUT', body }); VG.toast('Company signature saved.', 'ok'); render(el.closest('.view'), ctx); }
      catch (ex) { VG.toast(ex.message, 'bad'); }
    }));
  }

  function actions(r) {
    if (r.status === 'not_sent') return `<button class="btn btn-soft btn-xs" data-send="${r.user.id}" data-kind="${r.kind}">${VG.icon.send.replace('<svg', '<svg width="13" height="13"')} Send for signature</button>`;
    const parts = [];
    if (r.status === 'member_signed') parts.push(`<button class="btn btn-amber btn-xs" data-cs="${r.id}">${VG.icon.spark.replace('<svg', '<svg width="13" height="13"')} Review & countersign</button>`);
    if (r.status === 'pending') parts.push(`<button class="btn btn-soft btn-xs" data-send="${r.user.id}" data-kind="${r.kind}" data-tpl="${r.template_id || ''}">Remind</button>`);
    if (r.status === 'executed') parts.push(`<button class="btn btn-soft btn-xs" data-pdf="${r.id}" data-title="${VG.esc(r.title + ' · ' + r.ref)}">View</button><a class="btn btn-soft btn-xs" href="/api/admin/agreements/${r.id}/pdf?download=1">${VG.icon.download.replace('<svg', '<svg width="13" height="13"')} PDF</a>`);
    parts.push(`<button class="btn btn-soft btn-xs" data-audit="${r.id}">Details</button>`);
    if (r.status !== 'pending') parts.push(`<button class="btn btn-danger btn-xs" data-void="${r.id}">Void</button>`);
    return parts.join('');
  }

  function bindRows(el, d) {
    $$('[data-send]', el).forEach((b) => b.addEventListener('click', () => VG.busy(b, async () => {
      try { const r = await VG.api('/api/admin/agreements/send', { body: { user_ids: [Number(b.dataset.send)], kind: b.dataset.kind, template_id: b.dataset.tpl ? Number(b.dataset.tpl) : undefined } }); VG.toast(r.emailed ? 'Sent. They have an email with a link to sign.' : 'Ready in their portal. (No email address on file.)', 'ok'); render(el, ctx); }
      catch (e) { VG.toast(e.message, 'bad'); }
    })));
    $$('[data-pdf]', el).forEach((b) => b.addEventListener('click', () => VG.viewer.open({ kind: 'pdf', title: b.dataset.title, src: `/api/admin/agreements/${b.dataset.pdf}/pdf` })));
    $$('[data-cs]', el).forEach((b) => b.addEventListener('click', () => countersign(Number(b.dataset.cs), () => render(el, ctx))));
    $$('[data-audit]', el).forEach((b) => b.addEventListener('click', () => audit(Number(b.dataset.audit))));
    $$('[data-void]', el).forEach((b) => b.addEventListener('click', async () => {
      const reason = await VG.confirm('The member will be asked to sign a fresh copy. The voided copy stays in the records.', { title: 'Void this agreement?', ok: 'Void', danger: true, input: { label: 'Reason (shown to the member)', value: '' } });
      if (reason === false) return;
      try { await VG.api(`/api/admin/agreements/${b.dataset.void}/void`, { body: { reason } }); VG.toast('Voided. A fresh copy is ready for the member.', 'ok'); render(el, ctx); }
      catch (e) { VG.toast(e.message, 'bad'); }
    }));
  }

  function fieldRows(a, labels) {
    const f = a.fields || {};
    if (a.kind === 'custom') return Object.entries(f).filter(([, v]) => v).map(([k, v]) => `<tr><th>${VG.esc((labels && labels[k]) || k)}</th><td>${VG.esc(v)}</td></tr>`).join('');
    const val = { ...f, relation: f.relation_type ? `${f.relation_type} ${f.relation_name}` : '', address: [f.address1, f.address2].filter(Boolean).join(', '),
      residence: f.residence ? (f.residence === 'resident' ? 'Resident Indian' : 'Non-Resident') : '', ticket: f.ticket ? (f.ticket === '2' ? 'Option 2 · Rs. 12,00,000' : 'Option 1 · Rs. 6,00,000') : '' };
    return FIELD_LABELS.filter(([k]) => val[k]).map(([k, l]) => `<tr><th>${l}</th><td>${VG.esc(val[k])}</td></tr>`).join('');
  }

  async function countersign(id, after) {
    let d;
    try { d = await VG.api(`/api/admin/agreements/${id}`); } catch (e) { VG.toast(e.message, 'bad'); return; }
    const a = d.agreement, u = d.user, c = d.company;
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg cs-dlg';
    dlg.innerHTML = `<div class="dlg-body">
        <div class="card-head"><div><p class="label" style="margin:0">${VG.esc(a.ref)}</p><h3 style="margin:0">Countersign: ${VG.esc(a.title)}</h3></div>
          <button class="viewer-close" type="button" data-x>${VG.icon.x}<span>Close</span></button></div>
        <div class="cs-grid">
          <div><h4 class="label">${u.role === 'investor' ? 'Investor' : 'Advisor'}: ${VG.esc(u.name || u.uid)} (${VG.esc(u.uid)})</h4>
            <div class="table-wrap"><table class="t"><tbody>${fieldRows(a, d.labels)}
              <tr><th>Signed at</th><td>${VG.dateTime(a.member_signed_at)}</td></tr>
              <tr><th>Place</th><td>${VG.esc(a.member_place || '')}</td></tr>
              <tr><th>Location</th><td>${a.member_geo ? `${a.member_geo.lat.toFixed(4)}, ${a.member_geo.lon.toFixed(4)} (±${Math.round(a.member_geo.acc || 0)} m)` : 'Not shared'}</td></tr>
              <tr><th>IP address</th><td class="mono small">${VG.esc(a.member_ip || '')}</td></tr></tbody></table></div>
            <div class="cs-membersig"><img alt="Member signature" src="/api/admin/agreements/${a.id}/member-signature"></div>
            <button type="button" class="btn btn-soft btn-sm" data-preview>${VG.icon.eye} Preview the filled document</button></div>
          <div><h4 class="label">For VINC DEEPTECH PRIVATE LIMITED</h4>
            <p class="small" style="margin:0 0 10px">${VG.esc(c.signer_name)}, ${VG.esc(c.signer_title)}</p>
            ${c.has_signature ? `<div class="seg" id="cs-mode" style="margin-bottom:10px"><button type="button" aria-pressed="true" data-value="saved">Use saved signature</button><button type="button" aria-pressed="false" data-value="new">Sign now</button></div>
              <div class="cs-sig" id="cs-saved"><img alt="Company signature" src="/api/admin/agreements/company/signature"></div>` : ''}
            <div id="cs-new" ${c.has_signature ? 'hidden' : ''}><div id="cs-pad2"></div>
              <label class="check" style="margin-top:8px"><input type="checkbox" id="cs-keep" ${c.has_signature ? '' : 'checked'}> Save as the company signature</label></div>
            <label class="field" style="margin-top:12px"><span>Place of signing</span><input class="input" id="cs-place2" value="${VG.esc(c.place)}"></label>
            <p class="muted small">Date and time are recorded when you click Countersign (IST).</p>
            <p class="form-error" id="cs-err"></p>
            <button type="button" class="btn btn-amber" id="cs-go" style="width:100%">${VG.icon.check} Countersign and execute</button>
            <p class="muted small" style="margin:8px 0 0">The signed PDF is emailed to the member and to you${u.access_type === 'permanent' ? '.' : ', and the member becomes permanent.'}</p></div>
        </div></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => dlg.remove());
    $('[data-x]', dlg).addEventListener('click', () => dlg.close());
    $('[data-preview]', dlg).addEventListener('click', () => VG.viewer.open({ kind: 'pdf', title: `${a.title} · ${a.ref} (preview)`, src: `/api/admin/agreements/${a.id}/pdf` }));
    let mode = c.has_signature ? 'saved' : 'new';
    let pad = null;
    const ensurePad = () => { if (!pad) pad = VG.SignaturePad($('#cs-pad2', dlg), { name: c.signer_name }); };
    if (mode === 'new') ensurePad();
    const segEl = $('#cs-mode', dlg);
    if (segEl) VG.seg(segEl, (v) => { mode = v; $('#cs-saved', dlg).hidden = v !== 'saved'; $('#cs-new', dlg).hidden = v !== 'new'; if (v === 'new') ensurePad(); });
    $('#cs-go', dlg).addEventListener('click', () => VG.busy($('#cs-go', dlg), async () => {
      const body = { place: $('#cs-place2', dlg).value };
      if (mode === 'new') {
        if (!pad || pad.isEmpty()) { $('#cs-err', dlg).textContent = 'Draw or type the signature first.'; return; }
        body.signature = await pad.toDataURL();
        body.save_signature = $('#cs-keep', dlg).checked;
      }
      try {
        const r = await VG.api(`/api/admin/agreements/${id}/countersign`, { body });
        dlg.close();
        VG.toast(r.upgraded ? `Executed. ${u.name || u.uid} is now a permanent member.` : 'Executed. The signed PDF has been emailed.', 'ok');
        ctx && ctx.refreshStats && ctx.refreshStats();
        after && after();
      } catch (e) { $('#cs-err', dlg).textContent = e.message; }
    }));
  }

  async function audit(id) {
    let d;
    try { d = await VG.api(`/api/admin/agreements/${id}`); } catch (e) { VG.toast(e.message, 'bad'); return; }
    const a = d.agreement;
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.style.width = 'min(720px, calc(100vw - 32px))';
    dlg.innerHTML = `<div class="dlg-body"><div class="card-head"><div><p class="label" style="margin:0">${VG.esc(a.ref)}</p><h3 style="margin:0">${VG.esc(a.title)} · ${VG.esc(d.user.name || d.user.uid)}</h3></div>
        <button class="viewer-close" type="button" data-x>${VG.icon.x}<span>Close</span></button></div>
      ${a.fields ? `<div class="table-wrap" style="margin-bottom:14px"><table class="t"><tbody>${fieldRows(a, d.labels)}</tbody></table></div>` : ''}
      ${a.member_ua ? `<p class="small muted" style="word-break:break-word">Device: ${VG.esc(a.member_ua)}</p>` : ''}
      ${a.executed_sha256 ? `<p class="small">Executed PDF SHA-256: <span class="mono" style="word-break:break-all">${VG.esc(a.executed_sha256)}</span></p>` : ''}
      <h4 class="label">Audit trail</h4>
      <ul class="log">${d.events.map((e) => `<li><b>${VG.esc(e.actor)}</b>: ${VG.esc(e.action)}${e.detail ? ' · ' + VG.esc(e.detail) : ''}<time>${VG.dateTime(e.at)}${e.ip ? ' · IP ' + VG.esc(e.ip) : ''}</time></li>`).join('')}</ul></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => dlg.remove());
    $('[data-x]', dlg).addEventListener('click', () => dlg.close());
  }

  // ------------------------------------------------------------------ other agreements
  function customList(list) {
    if (!list.length) return '<p class="muted small" style="margin:0">None yet.</p>';
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Agreement</th><th>Blanks</th><th>Sent</th><th>Signed</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${VG.esc(c.title)}</b> ${c.required ? '<span class="chip warn" style="font-size:.68rem">Required</span>' : '<span class="chip" style="font-size:.68rem">Optional</span>'}
          <div class="muted small">${VG.esc(c.original_name || '')} · ${c.pages} page${c.pages === 1 ? '' : 's'} · ${VG.date(c.uploaded_at)}</div></td>
        <td class="small">${c.used_blanks} of ${c.blanks} in use</td><td class="num">${c.sent}</td><td class="num">${c.executed}</td>
        <td><div class="actions"><button class="btn btn-soft btn-xs" data-cfg="${c.id}">Set up blanks</button><button class="btn btn-amber btn-xs" data-csend="${c.id}">${VG.icon.send.replace('<svg', '<svg width="13" height="13"')} Send</button>
          <button class="btn btn-soft btn-xs" data-cview="${c.id}" data-title="${VG.esc(c.title)}">View</button><button class="btn btn-danger btn-xs" data-cdel="${c.id}">Withdraw</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function bindCustom(el, d) {
    const form = $('#custom-form', el);
    $('#custom-new', el).addEventListener('click', () => { form.hidden = false; form.title.focus(); });
    $('#custom-cancel', el).addEventListener('click', () => { form.hidden = true; form.reset(); });
    const drop = form.querySelector('.drop'), input = drop.querySelector('input'), name = drop.querySelector('.file-name');
    input.addEventListener('change', () => { name.textContent = input.files[0] ? input.files[0].name : ''; if (input.files[0] && !form.title.value) form.title.value = input.files[0].name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#custom-err', el).textContent = '';
      if (!input.files.length) { $('#custom-err', el).textContent = 'Choose the PDF.'; return; }
      const fd = new FormData();
      fd.append('title', form.title.value); fd.append('required', form.required.checked ? '1' : '0'); fd.append('file', input.files[0]);
      await VG.busy(form.querySelector('[type=submit]'), async () => {
        try {
          const t = await VG.api('/api/admin/agreements/custom', { method: 'POST', form: fd });
          VG.toast(t.blanks ? `Uploaded. Found ${t.blanks} blank${t.blanks === 1 ? '' : 's'}.` : 'Uploaded. No underscore blanks were found, so members will only sign.', 'ok');
          form.hidden = true; form.reset(); name.textContent = '';
          configure(t.id, d, () => render(el, ctx));
        } catch (ex) { $('#custom-err', el).textContent = ex.message; }
      });
    });
    $$('[data-cfg]', el).forEach((b) => b.addEventListener('click', () => configure(Number(b.dataset.cfg), d, () => render(el, ctx))));
    $$('[data-csend]', el).forEach((b) => b.addEventListener('click', () => sendDialog(d.custom.find((c) => c.id === Number(b.dataset.csend)), d.members, () => render(el, ctx))));
    $$('[data-cview]', el).forEach((b) => b.addEventListener('click', () => VG.viewer.open({ kind: 'pdf', title: b.dataset.title, src: `/api/admin/agreements/templates/${b.dataset.cview}/raw` })));
    $$('[data-cdel]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('It will no longer be offered. Copies nobody has signed yet are withdrawn; signed ones are kept.', { title: 'Withdraw this agreement?', ok: 'Withdraw', danger: true }))) return;
      try { const r = await VG.api(`/api/admin/agreements/custom/${b.dataset.cdel}`, { method: 'DELETE' }); VG.toast(`Withdrawn${r.withdrawn ? `, along with ${r.withdrawn} unsigned cop${r.withdrawn === 1 ? 'y' : 'ies'}` : ''}.`, 'ok'); render(el, ctx); }
      catch (e) { VG.toast(e.message, 'bad'); }
    }));
  }

  // Set up the blanks of a custom agreement, with the document beside the list.
  async function configure(id, d, after) {
    let t;
    try { t = await VG.api(`/api/admin/agreements/custom/${id}`); } catch (e) { VG.toast(e.message, 'bad'); return; }
    const modeOptions = (sel) => Object.entries(t.modes).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${VG.esc(v)}</option>`).join('');
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg cfg-dlg';
    dlg.innerHTML = `<div class="dlg-body">
      <div class="card-head"><div><p class="label" style="margin:0">Set up blanks</p><h3 style="margin:0">${VG.esc(t.title)}</h3></div>
        <button class="viewer-close" type="button" data-x>${VG.icon.x}<span>Close</span></button></div>
      <div class="cfg-grid">
        <div class="cfg-doc" id="cfg-doc"><div class="viewer-loading"><div class="spinner"></div></div></div>
        <div class="cfg-side">
          <label class="field"><span>Title</span><input class="input" id="cfg-title" value="${VG.esc(t.title)}" maxlength="120"></label>
          <label class="check" style="margin-bottom:12px"><input type="checkbox" id="cfg-req" ${t.required ? 'checked' : ''}> Required for permanent membership</label>
          ${t.blanks_list.length ? `<p class="muted small">Each numbered box on the document is a blank. Say what it is for; anything you leave blank stays empty.</p>
          <div class="cfg-list">${t.blanks_list.map((b) => `<div class="cfg-row" data-id="${b.id}">
              <span class="cfg-n">${b.id}</span>
              <div style="flex:1;min-width:0"><div class="muted small" title="Text near the blank">p.${b.page} · ${VG.esc(b.hint || '—')}</div>
                <select class="input" data-mode>${modeOptions(b.mode)}</select>
                <input class="input" data-label placeholder="What the member sees, e.g. Full name" value="${VG.esc(b.label || '')}" maxlength="60">
                <input class="input" data-value placeholder="The fixed text to print" value="${VG.esc(b.value || '')}" maxlength="120" ${b.mode === 'company' ? '' : 'hidden'}></div></div>`).join('')}</div>`
            : '<p class="muted">No underscore blanks were found in this PDF. Members will read it and sign; both signatures go on the signature page added at the end.</p>'}
          <p class="form-error" id="cfg-err"></p>
          <div class="btn-row"><button class="btn btn-primary" type="button" id="cfg-save">Save</button><button class="btn btn-amber" type="button" id="cfg-save-send">Save and send…</button></div>
        </div></div></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => { dlg.remove(); after && after(); });
    $('[data-x]', dlg).addEventListener('click', () => dlg.close());
    const spec = { fields: t.blanks_list.map((b) => ({ key: 'n' + b.id, page: b.page, x: b.x, w: b.w, line: b.line, src: 'auto', label: `Blank ${b.id}` })) };
    VG.FieldDoc($('#cfg-doc', dlg), { url: `/api/admin/agreements/templates/${t.id}/raw`, spec, state: { fields: {} }, preview: (key) => '#' + key.slice(1), editable: false })
      .catch(() => { $('#cfg-doc', dlg).innerHTML = '<p class="muted">Could not show the document.</p>'; });
    const paintRow = (row) => {
      const mode = row.querySelector('[data-mode]').value;
      row.querySelector('[data-value]').hidden = mode !== 'company';
      row.querySelector('[data-label]').hidden = !['member', 'optional'].includes(mode);
      row.classList.toggle('off', mode === 'skip');
      const box = $(`#cfg-doc [data-key="n${row.dataset.id}"]`, dlg);
      if (box) box.classList.toggle('off', mode === 'skip');
    };
    $$('.cfg-row', dlg).forEach((row) => {
      paintRow(row);
      row.querySelector('[data-mode]').addEventListener('change', () => paintRow(row));
      row.addEventListener('focusin', () => {
        const box = $(`#cfg-doc [data-key="n${row.dataset.id}"]`, dlg);
        if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.classList.remove('nudge'); void box.offsetWidth; box.classList.add('nudge'); }
      });
    });
    setTimeout(() => $$('.cfg-row', dlg).forEach(paintRow), 1500);
    const save = async (thenSend) => {
      const body = { title: $('#cfg-title', dlg).value, required: $('#cfg-req', dlg).checked,
        blanks: $$('.cfg-row', dlg).map((row) => ({ id: Number(row.dataset.id), mode: row.querySelector('[data-mode]').value, label: row.querySelector('[data-label]').value, value: row.querySelector('[data-value]').value })) };
      if (!t.blanks_list.length) delete body.blanks;
      try {
        const saved = await VG.api(`/api/admin/agreements/custom/${id}`, { method: 'PUT', body });
        VG.toast('Saved.', 'ok');
        dlg.close();
        if (thenSend) sendDialog(saved, d.members, after);
      } catch (e) { $('#cfg-err', dlg).textContent = e.message; }
    };
    $('#cfg-save', dlg).addEventListener('click', () => VG.busy($('#cfg-save', dlg), () => save(false)));
    $('#cfg-save-send', dlg).addEventListener('click', () => VG.busy($('#cfg-save-send', dlg), () => save(true)));
  }

  // Choose who signs it: a whole group, or selected members.
  async function sendDialog(t, _members, after) {
    let members = _members || [];
    try { members = (await VG.api('/api/admin/agreements')).members; } catch { /* use what we have */ }
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.style.width = 'min(620px, calc(100vw - 32px))';
    const eligible = members.filter((m) => !['rejected', 'revoked', 'invited'].includes(m.state));
    dlg.innerHTML = `<div class="dlg-body">
      <div class="card-head"><div><p class="label" style="margin:0">Send for signature</p><h3 style="margin:0">${VG.esc(t.title)}</h3></div>
        <button class="viewer-close" type="button" data-x>${VG.icon.x}<span>Close</span></button></div>
      <div class="choice-row col" id="aud">
        <button type="button" data-v="advisors" aria-pressed="false"><b>All advisors</b> · ${eligible.filter((m) => m.role === 'advisor').length}</button>
        <button type="button" data-v="investors" aria-pressed="false"><b>All investors</b> · ${eligible.filter((m) => m.role === 'investor').length}</button>
        <button type="button" data-v="all" aria-pressed="false"><b>Everyone</b> · ${eligible.length}</button>
        <button type="button" data-v="pick" aria-pressed="true"><b>Selected members</b></button>
      </div>
      <div id="pick" style="margin-top:12px">
        <input class="input" id="pick-q" placeholder="Search a name or VINC ID" style="min-height:38px;margin-bottom:8px">
        <div class="pick-list">${eligible.map((m) => `<label class="check pick-row" data-q="${VG.esc(((m.name || '') + ' ' + m.uid).toLowerCase())}"><input type="checkbox" value="${m.id}"> <span><b>${VG.esc(m.name || '—')}</b> <span class="muted small mono">${VG.esc(m.uid)} · ${m.role === 'investor' ? 'Investor' : 'Advisor'}</span></span></label>`).join('') || '<p class="muted">No members yet.</p>'}</div>
      </div>
      <p class="muted small" style="margin:12px 0 0">Each person gets an email with a link to sign. Anyone who already has it waiting gets a reminder instead.</p>
      <p class="form-error" id="send-err"></p>
      <button class="btn btn-amber" type="button" id="send-go" style="width:100%">${VG.icon.send} Send</button></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => { dlg.remove(); after && after(); });
    $('[data-x]', dlg).addEventListener('click', () => dlg.close());
    let audience = 'pick';
    $$('#aud button', dlg).forEach((b) => b.addEventListener('click', () => {
      audience = b.dataset.v;
      $$('#aud button', dlg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('#pick', dlg).hidden = audience !== 'pick';
    }));
    $('#pick-q', dlg).addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('.pick-row', dlg).forEach((r) => { r.hidden = q && !r.dataset.q.includes(q); }); });
    $('#send-go', dlg).addEventListener('click', () => VG.busy($('#send-go', dlg), async () => {
      const body = { template_id: t.id };
      if (audience === 'pick') {
        body.user_ids = $$('.pick-row input:checked', dlg).map((i) => Number(i.value));
        if (!body.user_ids.length) { $('#send-err', dlg).textContent = 'Tick at least one member.'; return; }
      } else body.audience = audience;
      try {
        const r = await VG.api('/api/admin/agreements/send', { body });
        VG.toast(`Sent to ${r.sent}${r.reminded ? `, reminded ${r.reminded}` : ''}${r.skipped ? `, ${r.skipped} had already signed` : ''}.`, 'ok');
        dlg.close();
      } catch (e) { $('#send-err', dlg).textContent = e.message; }
    }));
  }

  VG.adminAgreements = { render };
})();
