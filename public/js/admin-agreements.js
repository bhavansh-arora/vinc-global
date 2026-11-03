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
        <p>Advisors sign the Advisory Agreement and investors the Investor Term Sheet. Once all of a member's agreements are signed by both sides, they become permanent automatically.</p></div></div>
      <div class="grid grid-2" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Documents</h3></div>
          <p class="muted small" style="margin-top:-6px">Upload each PDF once. It is stored privately on the server and shown to members to fill in and sign.</p>
          <div class="grid" style="gap:12px">${d.templates.map(templateCard).join('')}</div></div>
        <div class="card" id="company-card">${companyCard(d.company)}</div>
      </div>
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

    const paint = (f) => {
      const rows = d.rows.filter((r) => !f || r.status === f);
      $('#agr-table').innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Document</th><th>Status</th><th>Member signed</th><th>VINC signed</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td><b>${VG.esc(r.user.name || '—')}</b><div class="muted small mono">${VG.esc(r.user.uid)} · ${r.user.role === 'investor' ? 'Investor' : 'Advisor'}${r.user.access_type === 'permanent' ? ' · permanent' : ''}</div></td>
          <td>${VG.esc(r.title)}${r.ref ? `<div class="muted small mono">${VG.esc(r.ref)}</div>` : ''}</td>
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
      <div style="flex:1;min-width:0"><b>${VG.esc(t.title)}</b>
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
    if (r.status === 'pending') parts.push(`<button class="btn btn-soft btn-xs" data-send="${r.user.id}" data-kind="${r.kind}">Remind</button>`);
    if (r.status === 'executed') parts.push(`<button class="btn btn-soft btn-xs" data-pdf="${r.id}" data-title="${VG.esc(r.title + ' · ' + r.ref)}">View</button><a class="btn btn-soft btn-xs" href="/api/admin/agreements/${r.id}/pdf?download=1">${VG.icon.download.replace('<svg', '<svg width="13" height="13"')} PDF</a>`);
    parts.push(`<button class="btn btn-soft btn-xs" data-audit="${r.id}">Details</button>`);
    if (r.status !== 'pending') parts.push(`<button class="btn btn-danger btn-xs" data-void="${r.id}">Void</button>`);
    return parts.join('');
  }

  function bindRows(el, d) {
    $$('[data-send]', el).forEach((b) => b.addEventListener('click', () => VG.busy(b, async () => {
      try { const r = await VG.api('/api/admin/agreements/send', { body: { user_id: Number(b.dataset.send), kind: b.dataset.kind } }); VG.toast(r.emailed ? 'Sent. They have an email with a link to sign.' : 'Ready in their portal. (No email address on file.)', 'ok'); render(el, ctx); }
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

  function fieldRows(a) {
    const f = a.fields || {};
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
            <div class="table-wrap"><table class="t"><tbody>${fieldRows(a)}
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
      ${a.fields ? `<div class="table-wrap" style="margin-bottom:14px"><table class="t"><tbody>${fieldRows(a)}</tbody></table></div>` : ''}
      ${a.member_ua ? `<p class="small muted" style="word-break:break-word">Device: ${VG.esc(a.member_ua)}</p>` : ''}
      ${a.executed_sha256 ? `<p class="small">Executed PDF SHA-256: <span class="mono" style="word-break:break-all">${VG.esc(a.executed_sha256)}</span></p>` : ''}
      <h4 class="label">Audit trail</h4>
      <ul class="log">${d.events.map((e) => `<li><b>${VG.esc(e.actor)}</b>: ${VG.esc(e.action)}${e.detail ? ' · ' + VG.esc(e.detail) : ''}<time>${VG.dateTime(e.at)}${e.ip ? ' · IP ' + VG.esc(e.ip) : ''}</time></li>`).join('')}</ul></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => dlg.remove());
    $('[data-x]', dlg).addEventListener('click', () => dlg.close());
  }

  VG.adminAgreements = { render };
})();
