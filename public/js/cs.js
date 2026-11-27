/* View-only accounts (e.g. the Company Secretary): every published document, and every signed agreement.
   Everything opens in the portal's view-only viewer, watermarked with the viewer's ID. */
(function () {
  'use strict';
  const VG = window.VG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const CATS = {
    board_resolutions: 'Board resolutions (BRs)', registration: 'Registration docs', financials: 'Financials',
    reports: 'Reports & decks', legal: 'Legal', general: 'General',
  };
  const VIEWS = {
    documents: ['Documents', 'Everything published in the data room · view only'],
    agreements: ['To sign', 'Agreements VINC has asked you to sign'],
    signed: ['Signed agreements', 'Every agreement signed in the portal · view only'],
    account: ['Account', 'Your login'],
  };
  const STATUS = { executed: ['Signed by both parties', 'ok'], member_signed: ['Signed by the member · awaiting VINC', 'warn'], others: ['Shared copy · waiting for other signers', 'teal'] };
  const statusOf = (a) => (a.status === 'member_signed' && a.joint && !a.joint.complete ? STATUS.others : STATUS[a.status]);
  let me = null, docs = [], signed = [];

  document.addEventListener('DOMContentLoaded', async () => {
    try { me = (await VG.loadMe()).user; } catch { me = null; }
    if (!me) return location.replace('/login');
    if (me.role !== 'viewer') return location.replace(me.role === 'admin' ? '/admin' : '/advisor');
    $$('[data-ic]').forEach((el) => { el.outerHTML = (VG.icon[el.dataset.ic] || '').replace('<svg', el.closest('.chip') ? '<svg width="14" height="14" style="vertical-align:-2px"' : '<svg'); });
    $('#me-name').textContent = me.name || me.uid;
    $('#me-role').textContent = `${me.uid} · view only`;
    $('#me-avatar').textContent = VG.initials(me.name || 'CS');
    $('#app').hidden = false;
    $('#menu-toggle').onclick = () => $('#app').classList.add('nav-open');
    $('#side-scrim').onclick = () => $('#app').classList.remove('nav-open');
    [docs, signed] = await Promise.all([VG.api('/api/cs/documents').catch(() => []), VG.api('/api/cs/agreements').catch(() => [])]);
    $('[data-count=documents]').textContent = docs.length || '';
    $('[data-count=signed]').textContent = signed.length || '';
    countToSign();
    window.addEventListener('hashchange', show);
    show();
  });

  async function countToSign() {
    try {
      const d = await VG.api('/api/member/agreements');
      const n = d.agreements.filter((a) => a.status === 'pending' && !a.updating).length;
      $('[data-count=tosign]').textContent = n || '';
    } catch { /* not asked to sign anything */ }
  }

  function show() {
    const [name, sub] = (location.hash || '#documents').slice(1).split('/');
    const view = VIEWS[name] ? name : 'documents';
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('.side nav a').forEach((a) => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#view-title').textContent = VIEWS[view][0];
    $('#view-sub').textContent = VIEWS[view][1];
    $('#app').classList.remove('nav-open');
    document.title = `${VIEWS[view][0]} · VINC Global`;
    if (view === 'agreements') {
      VG.memberAgreements.render($('.view[data-view=agreements]'), sub, { onChanged: async () => { countToSign(); signed = await VG.api('/api/cs/agreements').catch(() => signed); $('[data-count=signed]').textContent = signed.length || ''; } });
    } else ({ documents: renderDocs, signed: renderSigned, account: renderAccount })[view]();
    window.scrollTo({ top: 0 });
  }
  const empty = (icon, text) => `<div class="empty">${VG.icon[icon] || VG.icon.inbox}<p>${VG.esc(text)}</p></div>`;

  // ---------------------------------------------------------------- documents
  function renderDocs() {
    const el = $('.view[data-view=documents]');
    const cats = [...new Set(docs.map((d) => d.category))];
    el.innerHTML = `<div class="section-title"><div><h2>Data room documents</h2><p>Every document the VINC team has published, including those shared with one member only. Each opens here, view only and watermarked with your ID.</p></div></div>
      ${docs.length ? `<div class="cs-bar"><input class="input" id="doc-q" type="search" placeholder="Search titles and descriptions" style="min-height:40px">
        <div class="filters" id="doc-filters"><button class="filter" type="button" aria-pressed="true" data-cat="">All <span class="muted">${docs.length}</span></button>
        ${cats.map((c) => `<button class="filter" type="button" aria-pressed="false" data-cat="${c}">${VG.esc(CATS[c] || c)}</button>`).join('')}</div></div>` : ''}
      <div class="docs" id="doc-grid"></div>`;
    let cat = '';
    const paint = () => {
      const q = ($('#doc-q') ? $('#doc-q').value : '').toLowerCase();
      const list = docs.filter((d) => (!cat || d.category === cat) && (!q || `${d.title} ${d.description || ''}`.toLowerCase().includes(q)));
      $('#doc-grid').innerHTML = list.map((d, i) => `<button type="button" class="doc" data-doc="${d.id}" style="--i:${i}">
          <span class="kind ${d.kind}">${{ pdf: 'PDF', excel: 'XLS', link: 'LINK' }[d.kind]}</span>
          <span class="dm"><b>${VG.esc(d.title)}</b>${d.description ? `<p>${VG.esc(d.description)}</p>` : ''}
            <span class="meta"><span class="chip">${VG.esc(CATS[d.category] || 'General')}</span>${d.audience_uid ? `<span class="chip plum" title="Shared with one member">For ${VG.esc(d.audience_name || d.audience_uid)}</span>` : ''}<span class="muted small">${VG.date(d.created_at)}</span></span></span>
        </button>`).join('') || `<div class="card">${empty('vault', docs.length ? 'Nothing matches that search.' : 'No documents have been published yet.')}</div>`;
      $$('[data-doc]', el).forEach((b) => b.addEventListener('click', () => VG.openDocument(docs.find((x) => String(x.id) === b.dataset.doc))));
    };
    $$('[data-cat]', el).forEach((b) => b.addEventListener('click', () => { cat = b.dataset.cat; $$('[data-cat]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(); }));
    if ($('#doc-q')) $('#doc-q').addEventListener('input', paint);
    paint();
  }

  // ---------------------------------------------------------------- signed agreements
  function renderSigned() {
    const el = $('.view[data-view=signed]');
    el.innerHTML = `<div class="section-title"><div><h2>Signed agreements</h2><p>Every agreement a member has signed. Executed ones carry both signatures and the signature certificate; the others are waiting for VINC to countersign.</p></div></div>
      <div class="card">
        <div class="card-head"><input class="input" id="ag-q" type="search" placeholder="Search a name, VINC ID, document or reference" style="min-height:40px;max-width:360px">
          <div class="filters"><button class="filter" aria-pressed="true" data-f="">All <span class="muted">${signed.length}</span></button><button class="filter" aria-pressed="false" data-f="executed">Executed</button><button class="filter" aria-pressed="false" data-f="member_signed">Awaiting VINC</button></div></div>
        <div id="ag-table"></div></div>`;
    let f = '';
    const paint = () => {
      const q = $('#ag-q').value.toLowerCase();
      const rows = signed.filter((a) => (!f || a.status === f) && (!q || `${a.member.name} ${a.member.uid} ${a.title} ${a.ref}`.toLowerCase().includes(q)));
      $('#ag-table').innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Agreement</th><th>Status</th><th>Member signed</th><th>VINC signed</th><th></th></tr></thead><tbody>
        ${rows.map((a) => `<tr><td><b>${VG.esc(a.member.name || '—')}</b><div class="muted small mono">${VG.esc(a.member.uid)} · ${VG.esc(a.member.label)}</div></td>
          <td>${VG.esc(a.title)}<div class="muted small mono">${VG.esc(a.ref)}</div></td>
          <td><span class="chip ${statusOf(a)[1]}"><span class="dot"></span>${statusOf(a)[0]}</span>${a.joint ? `<div class="muted small">${a.joint.signed} of ${a.joint.total} signed</div>` : ''}</td>
          <td class="small">${a.member_signed_at ? `${VG.dateTime(a.member_signed_at)}<div class="muted">${VG.esc(a.member_place || '')}</div>` : '—'}</td>
          <td class="small">${a.company_signed_at ? `${VG.dateTime(a.company_signed_at)}<div class="muted">${VG.esc(a.company_place || '')}</div>` : '—'}</td>
          <td><button class="btn btn-soft btn-xs" data-view-ag="${a.id}">${VG.icon.eye.replace('<svg', '<svg width="14" height="14"')} View</button></td></tr>`).join('')}
        </tbody></table></div>` : empty('file', signed.length ? 'Nothing matches that search.' : 'No agreements have been signed yet.');
      $$('[data-view-ag]', el).forEach((b) => b.addEventListener('click', () => {
        const a = signed.find((x) => String(x.id) === b.dataset.viewAg);
        VG.viewer.open({ kind: 'pdf', title: `${a.title} · ${a.ref}`, subtitle: `${a.member.name || a.member.uid} · ${statusOf(a)[0]}`, src: `/api/cs/agreements/${a.id}/pdf` });
      }));
    };
    $$('[data-f]', el).forEach((b) => b.addEventListener('click', () => { f = b.dataset.f; $$('[data-f]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(); }));
    $('#ag-q').addEventListener('input', paint);
    paint();
  }

  // ---------------------------------------------------------------- account
  function renderAccount() {
    const el = $('.view[data-view=account]');
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
      <div class="card"><h3>Your access</h3>
        <div class="table-wrap"><table class="t"><tbody>
          <tr><th>Name</th><td>${VG.esc(me.name || '—')}</td></tr>
          <tr><th>VINC ID</th><td class="mono">${VG.esc(me.uid)}</td></tr>
          <tr><th>Designation</th><td>${VG.esc(me.organisation || '—')}</td></tr>
          <tr><th>Access</th><td>View only: documents and signed agreements; you sign the agreements VINC sends you</td></tr></tbody></table></div>
        <p class="muted small" style="margin:12px 0 0">You can read everything here but cannot change, download or send anything. Each document you open is recorded.</p></div>
      <form class="card" id="pwd-form"><h3>Change password</h3>
        <label class="field"><span>Current password</span><div class="pwd-wrap"><input class="input" type="password" name="current" autocomplete="current-password" required><button type="button"></button></div></label>
        <label class="field"><span>New password</span><div class="pwd-wrap"><input class="input" type="password" name="next" autocomplete="new-password" required><button type="button"></button></div></label>
        <label class="field"><span>Confirm new password</span><div class="pwd-wrap"><input class="input" type="password" name="confirm" autocomplete="new-password" required><button type="button"></button></div></label>
        <p class="form-error" id="pwd-err"></p>
        <button class="btn btn-primary" type="submit">Change password</button></form></div>`;
    VG.bindPasswords(el);
    $('#pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      $('#pwd-err').textContent = '';
      if (f.next !== f.confirm) { $('#pwd-err').textContent = 'The new passwords do not match.'; return; }
      await VG.busy(e.currentTarget.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/auth/password', { body: { current: f.current, next: f.next } }); VG.toast('Password changed.', 'ok'); e.target.reset(); }
        catch (ex) { $('#pwd-err').textContent = ex.message; }
      });
    });
  }
})();
