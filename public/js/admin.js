/* Admin console: IDs, approvals, documents, news, KYC, investments, share price, founder chats, settings. */
(function () {
  'use strict';
  const VG = window.VG;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const HOUR = 3600 * 1000;

  const CATS = {
    board_resolutions: 'Board resolutions (BRs)',
    registration: 'Registration docs',
    financials: 'Financials',
    reports: 'Reports & decks',
    legal: 'Legal',
    general: 'General',
  };
  const VIEWS = {
    overview: ['Overview', 'The founder’s desk'],
    approvals: ['Approvals', 'New sign-ups and renewal requests'],
    members: ['Members & IDs', 'Generate IDs for advisors and investors'],
    documents: ['Documents', 'Publish PDFs, Excel sheets and links · view only for members'],
    news: ['News', 'Publish updates to members or the public site'],
    kyc: ['KYC review', 'Verify member documents'],
    investments: ['Investments', 'Record investments and issue share certificates'],
    prices: ['Share price', 'Publish the live and projected price'],
    chats: ['Founder chats', 'Answer “Ask the Founder” questions'],
    settings: ['Settings', 'Portal settings and your password'],
  };
  const LOG_LABELS = { login: 'Logged in', signup: 'Signed up', approved_temporary: 'Temporary access approved', approved_permanent: 'Permanent access approved', renewal_requested: 'Asked for access again', kyc_uploaded: 'Uploaded KYC', kyc_verified: 'KYC verified', kyc_rejected: 'KYC rejected', kyc_submitted: 'KYC reopened', viewed_document: 'Viewed', downloaded_certificate: 'Downloaded certificate', investment_recorded: 'Investment recorded', certificate_issued: 'Certificate issued', password_changed: 'Password changed', id_generated: 'ID generated', rejected: 'Sign-up rejected', revoked: 'Access revoked', reset: 'ID reset' };

  let users = [];
  let stats = null;
  let settings = {};
  let current = 'overview';
  const timers = {};

  document.addEventListener('DOMContentLoaded', async () => {
    let me;
    try { me = (await VG.loadMe()).user; } catch { me = null; }
    if (!me) return location.replace('/login');
    if (me.role !== 'admin') return location.replace('/advisor');
    $$('[data-ic]').forEach((el) => { el.outerHTML = VG.icon[el.dataset.ic] || ''; });
    $('#app').hidden = false;
    $('#menu-toggle').onclick = () => $('#app').classList.add('nav-open');
    $('#side-scrim').onclick = () => $('#app').classList.remove('nav-open');
    settings = await VG.api('/api/admin/settings').catch(() => ({}));
    if (settings.currency) VG.currency = settings.currency;
    await Promise.all([loadUsers(), loadStats()]);
    window.addEventListener('hashchange', show);
    show();
    if (VG.takeIntroFlag()) {
      // People arrive and step through the door; anyone still awaiting approval waits in line.
      const waiting = Math.min(stats.pending, 3);
      const members = stats.members;
      await VG.welcomeIntro({
        label: 'VINC Global · Admin',
        title: 'Opening the founder’s desk…',
        sub: 'Your advisors and investors are arriving.',
        doneTitle: 'Welcome back, founder.',
        doneSub: members ? `${members} ${members === 1 ? 'member' : 'members'} in the VINC circle${stats.pending ? ` · ${stats.pending} waiting at the door` : ''}.` : 'Your VINC circle starts here. Generate the first ID to invite someone.',
        others: Math.max(4, Math.min(7, members + waiting)),
        waitAtDoor: waiting,
        extra: stats.pending ? `<a class="btn btn-amber btn-sm" href="#approvals">${VG.icon.clock} Review ${stats.pending} approval${stats.pending === 1 ? '' : 's'}</a>` : '',
      });
    }
    VG.riseIn($('.view:not([hidden])'));
    setInterval(async () => {
      const before = stats ? stats.pending + stats.unread + stats.kyc_pending : 0;
      await loadStats();
      const after = stats.pending + stats.unread + stats.kyc_pending;
      if (after > before) {
        VG.toast('Something new needs your attention.', 'ok');
        if (current === 'overview') renderOverview();
        if (current === 'approvals') { await loadUsers(); renderApprovals(); }
      }
    }, 20000);
  });

  async function loadUsers() { users = await VG.api('/api/admin/users'); }
  async function loadStats() {
    stats = await VG.api('/api/admin/stats');
    $$('[data-badge]').forEach((b) => { const n = stats[b.dataset.badge] || 0; b.textContent = n || ''; b.dataset.n = n; });
  }

  const RENDER = {
    overview: renderOverview, approvals: renderApprovals, members: renderMembers, documents: renderDocuments,
    news: renderNews, kyc: renderKyc, investments: renderInvestments, prices: renderPrices, chats: renderChats, settings: renderSettings,
  };

  function show() {
    const name = (location.hash || '#overview').slice(1).split('/')[0];
    const view = VIEWS[name] ? name : 'overview';
    Object.values(timers).forEach(clearInterval);
    current = view;
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('.side nav a').forEach((a) => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#view-title').textContent = VIEWS[view][0];
    $('#view-sub').textContent = VIEWS[view][1];
    $('#app').classList.remove('nav-open');
    document.title = `${VIEWS[view][0]} · Admin · VINC Global`;
    RENDER[view]();
    window.scrollTo({ top: 0 });
  }
  const viewEl = (v) => $(`[data-view=${v}].view`);
  const empty = (icon, text) => `<div class="empty">${VG.icon[icon] || VG.icon.inbox}<p>${VG.esc(text)}</p></div>`;
  const fail = (e) => VG.toast(e.message, 'bad');

  function stateChip(u) {
    const s = u.state;
    if (s === 'active' && u.access_type === 'permanent') return '<span class="chip ok"><span class="dot"></span>Permanent</span>';
    if (s === 'active') return `<span class="chip teal"><span class="dot"></span>Temporary · ${timeLeft(u.access_expires_at)} left</span>`;
    if (s === 'expired') return '<span class="chip"><span class="dot"></span>Window ended</span>';
    if (s === 'pending') return `<span class="chip warn"><span class="dot"></span>${u.renewal_requested ? 'Renewal request' : 'Awaiting approval'}</span>`;
    if (s === 'invited') return '<span class="chip plum"><span class="dot"></span>ID issued · not signed up</span>';
    if (s === 'rejected') return '<span class="chip bad"><span class="dot"></span>Rejected</span>';
    if (s === 'revoked') return '<span class="chip bad"><span class="dot"></span>Revoked</span>';
    return `<span class="chip">${VG.esc(s)}</span>`;
  }
  function timeLeft(t) {
    const ms = t - Date.now();
    if (ms <= 0) return '0m';
    const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / 60000);
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  const roleLabel = (r) => (r === 'investor' ? 'Investor' : 'Advisor');
  const memberOptions = (sel) => users
    .map((u) => `<option value="${u.id}" ${String(sel) === String(u.id) ? 'selected' : ''}>${VG.esc(u.name || '(no name yet)')} · ${VG.esc(u.uid)}</option>`).join('');

  // ================================================================ overview
  function renderOverview() {
    const s = stats;
    const el = viewEl('overview');
    el.innerHTML = `
      <div class="hello"><canvas id="hello-canvas" aria-hidden="true"></canvas>
        <div class="hello-row"><div><p class="label">Admin · all rights</p><h2>${VG.greeting()}, founder</h2>
          <p>${s.pending ? `${s.pending} ${s.pending === 1 ? 'person is' : 'people are'} waiting for approval.` : 'Nobody is waiting for approval.'} ${s.unread ? `${s.unread} unread message${s.unread === 1 ? '' : 's'} in Ask the Founder.` : ''}</p></div>
          <div class="btn-row"><a class="btn btn-amber btn-sm" href="#members">${VG.icon.plus} Generate an ID</a><a class="btn btn-ghost btn-sm" style="border-color:var(--on-band);color:var(--on-band)" href="#documents">${VG.icon.upload} Publish a document</a></div></div>
      </div>
      <div class="grid grid-4">
        ${tile('Members', s.members, `${s.advisors} advisors · ${s.investors} investors`, '--plum', '#members')}
        ${tile('Waiting for approval', s.pending, `${s.invited} IDs not yet activated`, '--amber', '#approvals')}
        ${tile('Active access', s.active_temp + s.active_perm, `${s.active_temp} temporary · ${s.active_perm} permanent`, '--teal', '#members')}
        ${tile('Unread questions', s.unread, 'in Ask the Founder', '--rust', '#chats')}
        ${tile('KYC to review', s.kyc_pending, 'documents submitted', '--olive', '#kyc')}
        ${tile('Documents', s.documents, 'in the data room', '--amber', '#documents')}
        ${tile('News posts', s.news, 'published', '--plum', '#news')}
        ${tile('Invested', null, 'recorded across members', '--teal', '#investments', VG.money(s.invested))}
      </div>
      <div class="grid grid-2" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Recent member activity</h3></div>
          ${s.recent.length ? `<ul class="log">${s.recent.map((l) => `<li><b>${VG.esc(l.name || l.uid)}</b> · ${VG.esc(LOG_LABELS[l.action] || l.action)}${l.detail ? ' · ' + VG.esc(l.detail) : ''}<time>${VG.dateTime(l.at)}</time></li>`).join('')}</ul>` : empty('clock', 'Activity shows up here as members sign up and look around.')}
        </div>
        <div class="card"><div class="card-head"><h3>Temporary windows</h3><a class="btn btn-soft btn-xs" href="#approvals">Approvals</a></div>
          ${tempList()}
        </div>
      </div>`;
    VG.bubbles($('#hello-canvas'), { density: 0.6, dark: true });
    $$('[data-count]', el).forEach((n) => VG.countUp(n, Number(n.dataset.count)));
  }
  function tile(k, v, s, color, href, text) {
    return `<a class="card glowy stat stat-tile" style="--c:var(${color});text-decoration:none" href="${href}"><span class="k">${k}</span><span class="v" ${text ? '' : `data-count="${v}"`}>${text || 0}</span><span class="s">${s}</span></a>`;
  }
  function tempList() {
    const list = users.filter((u) => u.state === 'active' && u.access_type === 'temporary').sort((a, b) => a.access_expires_at - b.access_expires_at);
    if (!list.length) return empty('clock', 'No temporary windows are open right now.');
    return `<div class="grid" style="gap:10px">${list.map((u) => {
      const total = u.access_expires_at - u.approved_at;
      const p = Math.min(100, Math.max(0, ((Date.now() - u.approved_at) / total) * 100));
      return `<div><div style="display:flex;justify-content:space-between;gap:8px;font-size:.92rem"><b>${VG.esc(u.name || u.uid)}</b><span class="muted">${timeLeft(u.access_expires_at)} left</span></div>
        <div class="meter" style="height:8px"><i style="--p:${p}%;--c:${p > 80 ? 'var(--rust)' : 'var(--teal)'}"></i></div></div>`;
    }).join('')}</div>`;
  }

  // ================================================================ approvals
  function renderApprovals() {
    const el = viewEl('approvals');
    const pending = users.filter((u) => u.state === 'pending');
    const hours = Number(settings.temp_access_hours) || 72;
    el.innerHTML = `<div class="section-title"><div><h2>Waiting for you</h2><p>Approve a ${hours}-hour preview to let someone look around, or permanent access once they are on board.</p></div></div>
      ${pending.length ? `<div class="grid grid-2">${pending.map((u, i) => `
        <article class="card glowy" style="animation:vg-rise .6s var(--ease-out) ${i * 60}ms backwards">
          <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px"><span class="avatar">${VG.initials(u.name)}</span>
            <div style="min-width:0;flex:1"><b style="font-family:var(--display);font-size:1.15rem">${VG.esc(u.name || '—')}</b><div class="muted small mono">${VG.esc(u.uid)} · ${roleLabel(u.role)}</div></div>${stateChip(u)}</div>
          <div class="small" style="display:grid;gap:2px;margin-bottom:14px;color:var(--ink-2)">
            <span>${VG.esc(u.email || '')}${u.phone ? ' · ' + VG.esc(u.phone) : ''}</span>
            ${u.organisation ? `<span>${VG.esc(u.organisation)}</span>` : ''}
            <span class="muted">Signed up ${VG.ago(u.signup_at)}${u.renewal_requested && u.approved_at ? ' · previous approval ' + VG.date(u.approved_at) : ''}</span></div>
          <div class="btn-row">
            <button class="btn btn-amber btn-sm" data-approve="temporary" data-id="${u.id}">${VG.icon.clock} ${hours} h preview</button>
            <button class="btn btn-teal btn-sm" data-approve="permanent" data-id="${u.id}">${VG.icon.shield} Permanent</button>
            <button class="btn btn-soft btn-sm" data-custom="${u.id}">Custom…</button>
            <button class="btn btn-danger btn-sm" data-reject="${u.id}">Reject</button>
          </div>
        </article>`).join('')}</div>` : `<div class="card">${empty('check', 'All caught up. New sign-ups and renewal requests will appear here.')}</div>`}
      <div class="card"><div class="card-head"><h3>Open temporary windows</h3></div>${tempList()}</div>`;
    bindApprovalButtons(el, renderApprovals);
  }

  function bindApprovalButtons(el, after) {
    $$('[data-approve]', el).forEach((b) => b.addEventListener('click', () => VG.busy(b, async () => {
      try { await VG.api(`/api/admin/users/${b.dataset.id}/approve`, { body: { type: b.dataset.approve } }); VG.toast(b.dataset.approve === 'permanent' ? 'Permanent access granted.' : 'Temporary access granted.', 'ok'); await refresh(after); }
      catch (e) { fail(e); }
    })));
    $$('[data-custom]', el).forEach((b) => b.addEventListener('click', async () => {
      const h = await VG.confirm('Grant a temporary window of a custom length.', { title: 'Custom access window', ok: 'Approve', input: { label: 'Hours', type: 'number', value: settings.temp_access_hours || 72, attrs: 'min="1" max="8760"' } });
      if (!h) return;
      try { await VG.api(`/api/admin/users/${b.dataset.custom}/approve`, { body: { type: 'temporary', hours: Number(h) } }); VG.toast(`Access granted for ${h} hours.`, 'ok'); await refresh(after); } catch (e) { fail(e); }
    }));
    $$('[data-reject]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('They will not be able to log in. You can reset the ID later to let them sign up again.', { title: 'Reject this sign-up?', ok: 'Reject', danger: true }))) return;
      try { await VG.api(`/api/admin/users/${b.dataset.reject}/reject`, { method: 'POST' }); await refresh(after); } catch (e) { fail(e); }
    }));
  }
  async function refresh(after) { await Promise.all([loadUsers(), loadStats()]); after && after(); }

  // ================================================================ members
  function renderMembers() {
    const el = viewEl('members');
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
        <form class="card" id="gen-form"><h3>Generate a new ID</h3>
          <p class="muted small" style="margin-top:-4px">Share the ID with the person. They sign up with it and choose a password, then you approve them.</p>
          <div class="seg" id="gen-role" style="margin-bottom:14px"><button type="button" aria-pressed="true" data-value="advisor">Advisor</button><button type="button" aria-pressed="false" data-value="investor">Investor</button></div>
          <div class="form-row">
            <label class="field"><span>Name <span class="hint">optional</span></span><input class="input" name="name"></label>
            <label class="field"><span>Email <span class="hint">optional</span></span><input class="input" type="email" name="email"></label>
          </div>
          <details style="margin-bottom:14px"><summary class="small" style="cursor:pointer;font-weight:700">More options: custom ID, starting password, pre-approval</summary>
            <div style="padding-top:12px">
              <label class="field"><span>Custom ID <span class="hint">leave empty to generate one</span></span><input class="input mono" name="uid" placeholder="VG-ADV-XXXXXX"></label>
              <label class="field"><span>Starting password <span class="hint">skip sign-up and set one for them</span></span><div class="pwd-wrap"><input class="input" type="password" name="password" autocomplete="new-password"><button type="button"></button></div></label>
              <label class="field"><span>Access</span><select class="input" name="access"><option value="">They sign up, then I approve</option><option value="temporary">Pre-approve a temporary window</option><option value="permanent">Pre-approve permanent access</option></select></label>
              <label class="field"><span>Notes <span class="hint">only you see these</span></span><input class="input" name="notes"></label>
            </div></details>
          <p class="form-error" id="gen-err"></p>
          <button class="btn btn-primary" type="submit">${VG.icon.spark} Generate ID</button>
        </form>
        <div id="gen-result"><div class="card" style="display:grid;place-items:center;min-height:100%;text-align:center">${empty('id', 'The new ID appears here, ready to copy and share.')}</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>All members <span class="muted small" style="font-family:var(--body)">${users.length}</span></h3>
          <div class="btn-row"><input class="input" id="m-search" placeholder="Search name, ID or email" style="min-height:38px;width:240px">
            <select class="input" id="m-filter" style="min-height:38px;width:auto"><option value="">Everyone</option><option value="pending">Awaiting approval</option><option value="active">Active</option><option value="expired">Window ended</option><option value="invited">Not signed up</option><option value="revoked">Revoked / rejected</option></select></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>ID</th><th>Status</th><th>KYC</th><th class="num">Invested</th><th></th></tr></thead><tbody id="m-body"></tbody></table></div>
      </div>`;
    let role = 'advisor';
    VG.seg($('#gen-role'), (v) => { role = v; });
    VG.bindPasswords(el);
    $('#gen-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      $('#gen-err').textContent = '';
      await VG.busy(e.currentTarget.querySelector('[type=submit]'), async () => {
        try {
          const u = await VG.api('/api/admin/users', { body: { ...f, role } });
          e.target.reset();
          showGenerated(u, !!f.password);
          await refresh(paintMembers);
        } catch (ex) { $('#gen-err').textContent = ex.message; }
      });
    });
    $('#m-search').addEventListener('input', paintMembers);
    $('#m-filter').addEventListener('change', paintMembers);
    paintMembers();
  }

  function showGenerated(u, hasPassword) {
    const link = `${location.origin}/signup?uid=${encodeURIComponent(u.uid)}`;
    const msg = hasPassword
      ? `Hello${u.name ? ' ' + u.name.split(' ')[0] : ''}, your VINC Global login is ready.\nID: ${u.uid}\nLog in at ${location.origin}/login with the password I shared separately.`
      : `Hello${u.name ? ' ' + u.name.split(' ')[0] : ''}, welcome to VINC Global, the portal for VINC's advisors and investors.\nYour VINC ID: ${u.uid}\nActivate it here: ${link}`;
    $('#gen-result').innerHTML = `<div class="id-card"><p class="label">New ${roleLabel(u.role).toLowerCase()} ID</p>
      <div class="uid">${VG.esc(u.uid)}</div>
      <p style="margin:0 0 16px;opacity:.85">${VG.esc(u.name || 'No name yet')} · ${hasPassword ? (u.state === 'active' ? 'pre-approved' : 'password set') : 'waiting for sign-up'}</p>
      <div class="btn-row"><button class="btn btn-amber btn-sm" data-copy="${VG.esc(u.uid)}">${VG.icon.copy} Copy ID</button>
        <button class="btn btn-sm" style="background:color-mix(in srgb,var(--on-band) 14%,transparent);color:var(--on-band)" id="copy-msg">${VG.icon.copy} Copy invitation</button></div></div>`;
    $('#gen-result [data-copy]').addEventListener('click', (e) => copy(e.currentTarget.dataset.copy));
    $('#copy-msg').addEventListener('click', () => copy(msg));
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); VG.toast('Copied to the clipboard.', 'ok'); }
    catch { VG.confirm(text, { title: 'Copy this', ok: 'Done' }); }
  }

  function paintMembers() {
    const q = ($('#m-search').value || '').toLowerCase();
    const f = $('#m-filter').value;
    const list = users.filter((u) => {
      if (q && ![u.name, u.uid, u.email, u.organisation].some((x) => (x || '').toLowerCase().includes(q))) return false;
      if (f === 'revoked') return u.state === 'revoked' || u.state === 'rejected';
      return !f || u.state === f;
    });
    $('#m-body').innerHTML = list.map((u) => `<tr>
        <td><div style="display:flex;gap:10px;align-items:center"><span class="avatar" style="width:34px;height:34px;font-size:.85rem${u.role === 'investor' ? ';background:var(--teal);color:#fff' : ''}">${VG.initials(u.name)}</span>
          <div><b>${VG.esc(u.name || '—')}</b><div class="muted small">${roleLabel(u.role)}${u.email ? ' · ' + VG.esc(u.email) : ''}</div></div></div></td>
        <td class="mono small">${VG.esc(u.uid)}</td>
        <td>${stateChip(u)}</td>
        <td>${u.kyc_count ? `${u.kyc_count} file${u.kyc_count > 1 ? 's' : ''}${u.kyc_pending ? ` <span class="chip warn">${u.kyc_pending} to review</span>` : ''}` : '<span class="muted">—</span>'}</td>
        <td class="num">${u.invested ? VG.money(u.invested) : '—'}</td>
        <td><div class="actions"><button class="btn btn-soft btn-xs" data-open="${u.id}">Manage</button></div></td></tr>`).join('')
      || `<tr><td colspan="6">${empty('users', users.length ? 'No one matches that search.' : 'No members yet. Generate the first ID above.')}</td></tr>`;
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => openMember(Number(b.dataset.open))));
  }

  // ---------------------------------------------------------------- member drawer
  async function openMember(id) {
    const dlg = $('#drawer');
    const inner = $('#drawer-inner');
    inner.innerHTML = '<div class="viewer-loading"><div class="spinner"></div></div>';
    if (!dlg.open) dlg.showModal();
    let d;
    try { d = await VG.api(`/api/admin/users/${id}`); } catch (e) { fail(e); dlg.close(); return; }
    const u = d.user;
    const hours = Number(settings.temp_access_hours) || 72;
    inner.innerHTML = `
      <div class="drawer-head"><div style="display:flex;gap:12px;align-items:center"><span class="avatar" style="width:52px;height:52px;font-size:1.2rem">${VG.initials(u.name)}</span>
        <div><h2>${VG.esc(u.name || 'No name yet')}</h2><div class="btn-row" style="gap:6px"><span class="chip mono">${VG.esc(u.uid)}</span>${stateChip(u)}</div></div></div>
        <button class="viewer-close" type="button" id="drawer-close">${VG.icon.x}<span>Close</span></button></div>

      <div class="card"><h3>Access</h3>
        <p class="muted small" style="margin-top:-4px">${u.state === 'active' ? (u.access_type === 'permanent' ? `Permanent since ${VG.date(u.approved_at)}.` : `Temporary until ${VG.dateTime(u.access_expires_at)} (${timeLeft(u.access_expires_at)} left).`) : u.state === 'invited' ? 'Has not signed up yet.' : u.state === 'expired' ? `Window ended ${VG.dateTime(u.access_expires_at)}.` : ''}
          ${u.last_login_at ? ` Last login ${VG.ago(u.last_login_at)}.` : ''}</p>
        <div class="btn-row">
          ${u.state !== 'invited' ? `<button class="btn btn-amber btn-sm" data-approve="temporary" data-id="${u.id}">${VG.icon.clock} ${u.state === 'active' && u.access_type === 'temporary' ? 'Restart' : 'Grant'} ${hours} h</button>
          <button class="btn btn-teal btn-sm" data-approve="permanent" data-id="${u.id}">${VG.icon.shield} Make permanent</button>
          <button class="btn btn-soft btn-sm" data-custom="${u.id}">Custom hours…</button>` : ''}
          ${u.state === 'active' ? `<button class="btn btn-danger btn-sm" id="m-revoke">Revoke access</button>` : ''}
          ${u.state === 'pending' ? `<button class="btn btn-danger btn-sm" data-reject="${u.id}">Reject</button>` : ''}
          <button class="btn btn-soft btn-sm" id="m-reset" title="Clears the password so they sign up again with the same ID">Reset sign-up</button>
          <a class="btn btn-soft btn-sm" href="#chats/${u.id}" id="m-chat">${VG.icon.chat} Chat</a>
        </div></div>

      <form class="card" id="m-edit"><h3>Details</h3>
        <div class="form-row">
          <label class="field"><span>Name</span><input class="input" name="name" value="${VG.esc(u.name || '')}"></label>
          <label class="field"><span>Role</span><select class="input" name="role"><option value="advisor" ${u.role === 'advisor' ? 'selected' : ''}>Advisor</option><option value="investor" ${u.role === 'investor' ? 'selected' : ''}>Investor</option></select></label>
          <label class="field"><span>Email</span><input class="input" name="email" value="${VG.esc(u.email || '')}"></label>
          <label class="field"><span>Phone</span><input class="input" name="phone" value="${VG.esc(u.phone || '')}"></label>
        </div>
        <label class="field"><span>Organisation</span><input class="input" name="organisation" value="${VG.esc(u.organisation || '')}"></label>
        <label class="field"><span>Private notes</span><textarea class="input" name="notes" style="min-height:70px">${VG.esc(u.notes || '')}</textarea></label>
        <button class="btn btn-primary btn-sm" type="submit">Save details</button></form>

      <div class="card"><h3>KYC documents</h3>${kycTable(d.kyc, false)}</div>

      <div class="card"><h3>Investments</h3>
        ${d.investments.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Round</th><th class="num">Amount</th><th class="num">Shares</th><th></th></tr></thead><tbody>
          ${d.investments.map((i) => `<tr><td>${VG.date(i.invested_on)}</td><td>${VG.esc(i.round || '—')}</td><td class="num">${VG.money(i.amount)}</td><td class="num">${VG.num(i.shares, 2)}</td><td><div class="actions"><button class="btn btn-danger btn-xs" data-del-inv="${i.id}">Delete</button></div></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">None recorded.</p>'}
        ${investmentForm(u.id)}</div>

      <div class="card"><h3>Share certificates</h3>
        <div class="grid" style="gap:10px;margin-bottom:14px">${d.certificates.map((c) => `<div class="cert"><span class="seal">${VG.icon.seal}</span><div class="cm"><b>${VG.esc(c.title)}</b><span class="muted small">${c.certificate_no ? 'No. ' + VG.esc(c.certificate_no) + ' · ' : ''}${VG.date(c.created_at)}</span></div>
          <div class="btn-row"><button class="btn btn-soft btn-xs" data-view-cert="${c.id}" data-mime="${VG.esc(c.mime)}" data-title="${VG.esc(c.title)}">View</button><button class="btn btn-danger btn-xs" data-del-cert="${c.id}">Delete</button></div></div>`).join('') || '<p class="muted" style="margin:0">None issued yet.</p>'}</div>
        ${certificateForm(u.id)}</div>

      <div class="card"><h3>Activity</h3>${d.log.length ? `<ul class="log">${d.log.map((l) => `<li><b>${VG.esc(LOG_LABELS[l.action] || l.action)}</b>${l.detail ? ' · ' + VG.esc(l.detail) : ''}<time>${VG.dateTime(l.at)}</time></li>`).join('')}</ul>` : '<p class="muted">No activity yet.</p>'}</div>

      <div class="card" style="border-color:color-mix(in srgb,var(--bad) 40%,var(--line))"><h3>Delete member</h3><p class="muted small">Removes the ID, KYC files, investments, certificates and chat history. This cannot be undone.</p><button class="btn btn-danger btn-sm" id="m-delete">${VG.icon.trash} Delete ${VG.esc(u.uid)}</button></div>`;

    const repaint = () => { if (current === 'members') paintMembers(); else if (['overview', 'approvals', 'investments'].includes(current)) RENDER[current](); };
    const reopen = async () => { await Promise.all([loadUsers(), loadStats()]); repaint(); openMember(id); };
    $('#drawer-close').onclick = () => dlg.close();
    $('#m-chat').addEventListener('click', () => dlg.close());
    bindApprovalButtons(inner, () => { repaint(); openMember(id); });
    const revoke = $('#m-revoke');
    if (revoke) revoke.addEventListener('click', async () => {
      if (!(await VG.confirm('They are logged out at once and cannot log in until you approve them again.', { title: 'Revoke access?', ok: 'Revoke', danger: true }))) return;
      try { await VG.api(`/api/admin/users/${id}/revoke`, { method: 'POST' }); await reopen(); } catch (e) { fail(e); }
    });
    $('#m-reset').addEventListener('click', async () => {
      if (!(await VG.confirm('Their password is cleared and they sign up again with the same ID. Their files and investments stay.', { title: 'Reset sign-up?', ok: 'Reset' }))) return;
      try { await VG.api(`/api/admin/users/${id}/reset`, { method: 'POST' }); await reopen(); } catch (e) { fail(e); }
    });
    $('#m-edit').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await VG.api(`/api/admin/users/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.currentTarget)) }); VG.toast('Saved.', 'ok'); await reopen(); } catch (ex) { fail(ex); }
    });
    $('#m-delete').addEventListener('click', async () => {
      const typed = await VG.confirm(`Type ${u.uid} to confirm.`, { title: 'Delete this member?', ok: 'Delete forever', danger: true, input: { label: 'Member ID' } });
      if (typed === false) return;
      if (String(typed).trim().toUpperCase() !== u.uid.toUpperCase()) { VG.toast('The ID did not match, so nothing was deleted.', 'bad'); return; }
      try { await VG.api(`/api/admin/users/${id}`, { method: 'DELETE' }); dlg.close(); VG.toast('Member deleted.', 'ok'); await Promise.all([loadUsers(), loadStats()]); repaint(); } catch (ex) { fail(ex); }
    });
    bindKycActions(inner, d.kyc, reopen);
    bindInvestmentForm(inner, reopen);
    bindCertificateForm(inner, reopen);
    $$('[data-del-inv]', inner).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('Remove this investment record?', { title: 'Delete investment', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/investments/${b.dataset.delInv}`, { method: 'DELETE' }); await reopen(); } catch (e) { fail(e); }
    }));
    $$('[data-del-cert]', inner).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('The member will no longer see or download it.', { title: 'Delete certificate?', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/certificates/${b.dataset.delCert}`, { method: 'DELETE' }); await reopen(); } catch (e) { fail(e); }
    }));
    $$('[data-view-cert]', inner).forEach((b) => b.addEventListener('click', () => VG.openStored(b.dataset.title, b.dataset.mime, `/api/files/cert/${b.dataset.viewCert}/raw`)));
  }

  // ---------------------------------------------------------------- KYC helpers
  function kycTable(list, withMember) {
    if (!list.length) return empty('id', withMember ? 'No KYC documents yet.' : 'Nothing uploaded yet.');
    const chip = (s) => s === 'verified' ? '<span class="chip ok"><span class="dot"></span>Verified</span>' : s === 'rejected' ? '<span class="chip bad"><span class="dot"></span>Rejected</span>' : '<span class="chip warn"><span class="dot"></span>To review</span>';
    return `<div class="table-wrap"><table class="t"><thead><tr>${withMember ? '<th>Member</th>' : ''}<th>Document</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((k) => `<tr>${withMember ? `<td><b>${VG.esc(k.name || '—')}</b><div class="muted small mono">${VG.esc(k.uid)}</div></td>` : ''}
        <td><b>${VG.esc(k.doc_type)}</b><div class="muted small">${VG.esc(k.original_name || '')} · ${VG.date(k.uploaded_at)}</div>${k.remark ? `<div class="small" style="color:var(--bad)">${VG.esc(k.remark)}</div>` : ''}</td>
        <td>${chip(k.status)}</td>
        <td><div class="actions"><button class="btn btn-soft btn-xs" data-kv="${k.id}">View</button>
          ${k.status !== 'verified' ? `<button class="btn btn-teal btn-xs" data-kok="${k.id}">Verify</button>` : ''}
          ${k.status !== 'rejected' ? `<button class="btn btn-danger btn-xs" data-kno="${k.id}">Reject</button>` : ''}</div></td></tr>`).join('')}
    </tbody></table></div>`;
  }
  function bindKycActions(root, list, after) {
    $$('[data-kv]', root).forEach((b) => b.addEventListener('click', () => {
      const k = list.find((x) => String(x.id) === b.dataset.kv);
      VG.openStored(`${k.doc_type}${k.name ? ' · ' + k.name : ''}`, k.mime, `/api/files/kyc/${k.id}/raw`, k.original_name);
    }));
    $$('[data-kok]', root).forEach((b) => b.addEventListener('click', () => VG.busy(b, async () => {
      try { await VG.api(`/api/admin/kyc/${b.dataset.kok}/review`, { body: { status: 'verified' } }); VG.toast('Marked as verified.', 'ok'); await loadStats(); after(); } catch (e) { fail(e); }
    })));
    $$('[data-kno]', root).forEach((b) => b.addEventListener('click', async () => {
      const remark = await VG.confirm('Tell the member what to fix. They will see this note.', { title: 'Reject this document', ok: 'Reject', danger: true, input: { label: 'Reason', value: 'The copy is not clear. Please upload a sharper scan.' } });
      if (remark === false) return;
      try { await VG.api(`/api/admin/kyc/${b.dataset.kno}/review`, { body: { status: 'rejected', remark } }); await loadStats(); after(); } catch (e) { fail(e); }
    }));
  }

  function renderKyc() {
    const el = viewEl('kyc');
    el.innerHTML = '<div class="viewer-loading"><div class="spinner"></div></div>';
    VG.api('/api/admin/kyc').then((list) => {
      el.innerHTML = `<div class="section-title"><div><h2>KYC review</h2><p>Documents waiting for review are listed first. Open any file in the viewer.</p></div>
        <div class="filters"><button class="filter" aria-pressed="true" data-f="submitted">To review</button><button class="filter" aria-pressed="false" data-f="">All</button></div></div>
        <div class="card" id="kyc-list"></div>`;
      const paint = (f) => { const l = list.filter((k) => !f || k.status === f); $('#kyc-list').innerHTML = kycTable(l, true); bindKycActions($('#kyc-list'), l, renderKyc); };
      $$('[data-f]', el).forEach((b) => b.addEventListener('click', () => { $$('[data-f]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); paint(b.dataset.f); }));
      paint('submitted');
    }).catch(fail);
  }

  // ================================================================ documents
  function renderDocuments() {
    const el = viewEl('documents');
    el.innerHTML = `<div class="section-title"><div><h2>Publish to the data room</h2><p>Choose what to add. Members see it straight away, in view-only mode inside the portal.</p></div></div>
      <div class="choices" role="group" aria-label="Type of document">
        <button type="button" class="choice pdf" data-kind="pdf" aria-pressed="false"><span class="kind pdf">PDF</span><span><b>Upload PDF</b><span>Board resolutions, registration papers, reports</span></span></button>
        <button type="button" class="choice excel" data-kind="excel" aria-pressed="false"><span class="kind excel">XLS</span><span><b>Upload Excel</b><span>Cap table, financial model, MIS (.xlsx or .csv)</span></span></button>
        <button type="button" class="choice link" data-kind="link" aria-pressed="false"><span class="kind link">LINK</span><span><b>Add a link</b><span>A deck, video or page on the web</span></span></button>
      </div>
      <form class="card" id="doc-form" hidden>
        <input type="hidden" name="kind">
        <div class="form-row">
          <label class="field"><span>Title</span><input class="input" name="title" required maxlength="200"></label>
          <label class="field"><span>Category</span><select class="input" name="category">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field"><span>Who can see it</span><select class="input" name="audience_user_id"><option value="">All approved members</option>${memberOptions()}</select></label>
        </div>
        <label class="field"><span>Short description <span class="hint">optional</span></span><input class="input" name="description" maxlength="1000"></label>
        <div id="doc-file"><label class="drop" id="doc-drop">${VG.icon.upload}<b>Drop the file here or click to choose</b><span class="muted small" id="doc-accept"></span><span class="file-name"></span><input type="file" name="file"></label></div>
        <label class="field" id="doc-url" hidden><span>Web address</span><input class="input" name="url" type="url" placeholder="https://"></label>
        <p class="form-error" id="doc-err"></p>
        <div class="btn-row"><button class="btn btn-primary" type="submit">${VG.icon.upload} Publish</button><button class="btn btn-soft" type="button" id="doc-cancel">Cancel</button></div>
      </form>
      <div class="card"><div class="card-head"><h3>Published documents</h3></div><div id="doc-list"><div class="viewer-loading"><div class="spinner"></div></div></div></div>`;
    const form = $('#doc-form');
    bindDrop($('#doc-drop'));
    $$('.choice', el).forEach((c) => c.addEventListener('click', () => {
      $$('.choice', el).forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      const kind = c.dataset.kind;
      form.hidden = false;
      form.kind.value = kind;
      $('#doc-file').hidden = kind === 'link';
      $('#doc-url').hidden = kind !== 'link';
      form.file.accept = kind === 'pdf' ? '.pdf,application/pdf' : '.xlsx,.xlsm,.csv';
      $('#doc-accept').textContent = kind === 'pdf' ? 'PDF, up to 25 MB' : 'Excel .xlsx or .csv, up to 25 MB';
      form.file.value = ''; $('#doc-drop .file-name').textContent = '';
      form.animate([{ opacity: 0, translate: '0 12px' }, { opacity: 1, translate: '0 0' }], { duration: 400, easing: 'cubic-bezier(.22,1,.36,1)' });
      form.title.focus();
    }));
    $('#doc-cancel').addEventListener('click', () => { form.hidden = true; form.reset(); $$('.choice', el).forEach((x) => x.setAttribute('aria-pressed', 'false')); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#doc-err').textContent = '';
      if (form.kind.value !== 'link' && !form.file.files.length) { $('#doc-err').textContent = 'Choose a file to upload.'; return; }
      const fd = new FormData(form);
      if (form.kind.value === 'link') fd.delete('file');
      await VG.busy(form.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/admin/documents', { method: 'POST', form: fd }); VG.toast('Published to the data room.', 'ok'); form.reset(); form.hidden = true; $$('.choice', el).forEach((x) => x.setAttribute('aria-pressed', 'false')); paintDocs(); loadStats(); }
        catch (ex) { $('#doc-err').textContent = ex.message; }
      });
    });
    paintDocs();
  }
  async function paintDocs() {
    let docs;
    try { docs = await VG.api('/api/admin/documents'); } catch (e) { return fail(e); }
    const box = $('#doc-list');
    if (!box) return;
    box.innerHTML = docs.length ? `<div class="table-wrap"><table class="t"><thead><tr><th></th><th>Title</th><th>Category</th><th>Visible to</th><th>Added</th><th></th></tr></thead><tbody>
      ${docs.map((d) => `<tr><td style="width:56px"><span class="kind ${d.kind}" style="width:34px;height:40px;font-size:.58rem;padding-bottom:4px">${{ pdf: 'PDF', excel: 'XLS', link: 'LINK' }[d.kind]}</span></td>
        <td><b>${VG.esc(d.title)}</b>${d.description ? `<div class="muted small">${VG.esc(d.description)}</div>` : ''}<div class="muted small">${d.kind === 'link' ? VG.esc(d.url) : VG.esc(d.original_name || '') + ' · ' + VG.size(d.size)}</div></td>
        <td>${VG.esc(CATS[d.category] || d.category)}</td>
        <td>${d.audience_user_id ? `<span class="chip plum">${VG.esc(d.audience_name || d.audience_uid)}</span>` : '<span class="chip">All members</span>'}</td>
        <td class="small">${VG.date(d.created_at)}</td>
        <td><div class="actions"><button class="btn btn-soft btn-xs" data-dv="${d.id}">${VG.icon.eye.replace('<svg', '<svg width="14" height="14"')} View</button><button class="btn btn-danger btn-xs" data-dd="${d.id}">Delete</button></div></td></tr>`).join('')}
      </tbody></table></div>` : empty('vault', 'Nothing published yet. Choose PDF, Excel or link above.');
    $$('[data-dv]', box).forEach((b) => b.addEventListener('click', () => VG.openDocument(docs.find((d) => String(d.id) === b.dataset.dv))));
    $$('[data-dd]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('Members will no longer see it.', { title: 'Delete this document?', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/documents/${b.dataset.dd}`, { method: 'DELETE' }); paintDocs(); loadStats(); } catch (e) { fail(e); }
    }));
  }

  function bindDrop(drop) {
    const input = drop.querySelector('input');
    const name = drop.querySelector('.file-name');
    input.addEventListener('change', () => { name.textContent = input.files[0] ? `${input.files[0].name} · ${VG.size(input.files[0].size)}` : ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; input.dispatchEvent(new Event('change')); } });
  }

  // ================================================================ news
  function renderNews() {
    const el = viewEl('news');
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
        <form class="card" id="news-form"><h3>Post an update</h3>
          <label class="field"><span>Headline</span><input class="input" name="title" required maxlength="200"></label>
          <div class="form-row">
            <label class="field"><span>Tag <span class="hint">optional</span></span><input class="input" name="tag" placeholder="Milestone, Partnership…" maxlength="40"></label>
            <label class="field"><span>Show to</span><select class="input" name="visibility"><option value="members">Members only</option><option value="public">Members and the public site</option></select></label>
          </div>
          <label class="field"><span>Update</span><textarea class="input" name="body" required maxlength="8000" style="min-height:150px"></textarea></label>
          <label class="check" style="margin-bottom:14px"><input type="checkbox" name="pinned" value="1"> Pin to the top</label>
          <p class="form-error" id="news-err"></p>
          <button class="btn btn-primary" type="submit">${VG.icon.send} Publish</button>
        </form>
        <div class="card"><h3>Published</h3><div class="news-list" id="news-list"></div></div></div>`;
    $('#news-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      f.pinned = !!f.pinned;
      await VG.busy(e.currentTarget.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/admin/news', { body: f }); VG.toast('Published.', 'ok'); e.target.reset(); paintNews(); loadStats(); } catch (ex) { $('#news-err').textContent = ex.message; }
      });
    });
    paintNews();
  }
  async function paintNews() {
    const list = await VG.api('/api/admin/news').catch(fail);
    if (!list) return;
    const box = $('#news-list');
    box.innerHTML = list.map((n) => `<article class="news-item ${n.pinned ? 'pinned' : ''}">
        <div class="nm">${n.tag ? `<span class="chip warn">${VG.esc(n.tag)}</span>` : ''}<span>${VG.date(n.created_at)}</span><span class="chip ${n.visibility === 'public' ? 'teal' : ''}">${n.visibility === 'public' ? 'Public' : 'Members'}</span></div>
        <h3>${VG.esc(n.title)}</h3><p>${VG.esc(n.body)}</p>
        <div class="btn-row"><button class="btn btn-soft btn-xs" data-pin="${n.id}" data-on="${n.pinned ? 0 : 1}">${n.pinned ? 'Unpin' : 'Pin'}</button><button class="btn btn-soft btn-xs" data-vis="${n.id}" data-to="${n.visibility === 'public' ? 'members' : 'public'}">${n.visibility === 'public' ? 'Members only' : 'Make public'}</button><button class="btn btn-danger btn-xs" data-nd="${n.id}">Delete</button></div>
      </article>`).join('') || empty('news', 'No news yet.');
    $$('[data-pin]', box).forEach((b) => b.addEventListener('click', async () => { await VG.api(`/api/admin/news/${b.dataset.pin}`, { method: 'PATCH', body: { pinned: b.dataset.on === '1' } }).catch(fail); paintNews(); }));
    $$('[data-vis]', box).forEach((b) => b.addEventListener('click', async () => { await VG.api(`/api/admin/news/${b.dataset.vis}`, { method: 'PATCH', body: { visibility: b.dataset.to } }).catch(fail); paintNews(); }));
    $$('[data-nd]', box).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('This removes the post for everyone.', { title: 'Delete this post?', ok: 'Delete', danger: true }))) return;
      await VG.api(`/api/admin/news/${b.dataset.nd}`, { method: 'DELETE' }).catch(fail); paintNews(); loadStats();
    }));
  }

  // ================================================================ investments
  function investmentForm(userId) {
    return `<form class="inv-form" style="margin-top:14px"><h4 class="label" style="margin-bottom:10px">Record an investment</h4>
      ${userId ? `<input type="hidden" name="user_id" value="${userId}">` : `<label class="field"><span>Member</span><select class="input" name="user_id" required><option value="">Choose…</option>${memberOptions()}</select></label>`}
      <div class="form-row">
        <label class="field"><span>Date</span><input class="input" type="date" name="invested_on" required value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="field"><span>Amount (${VG.esc(VG.currency)})</span><input class="input" type="number" name="amount" min="0" step="any" required></label>
        <label class="field"><span>Shares</span><input class="input" type="number" name="shares" min="0" step="any" required></label>
        <label class="field"><span>Round <span class="hint">optional</span></span><input class="input" name="round" placeholder="Seed, Pre-Series A…"></label>
      </div>
      <label class="field"><span>Note <span class="hint">optional</span></span><input class="input" name="note"></label>
      <p class="form-error"></p><button class="btn btn-primary btn-sm" type="submit">${VG.icon.plus} Add investment</button></form>`;
  }
  function bindInvestmentForm(root, after) {
    $$('.inv-form', root).forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      await VG.busy(f.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/admin/investments', { body: Object.fromEntries(new FormData(f)) }); VG.toast('Investment recorded.', 'ok'); f.reset(); after(); }
        catch (ex) { f.querySelector('.form-error').textContent = ex.message; }
      });
    }));
  }
  function certificateForm(userId) {
    return `<form class="cert-form"><h4 class="label" style="margin-bottom:10px">Issue a share certificate</h4>
      ${userId ? `<input type="hidden" name="user_id" value="${userId}">` : `<label class="field"><span>Member</span><select class="input" name="user_id" required><option value="">Choose…</option>${memberOptions()}</select></label>`}
      <div class="form-row"><label class="field"><span>Title</span><input class="input" name="title" value="Share certificate"></label>
        <label class="field"><span>Certificate no. <span class="hint">optional</span></span><input class="input" name="certificate_no"></label></div>
      <label class="drop">${VG.icon.upload}<b>Certificate file</b><span class="muted small">PDF, JPG or PNG · members can download this</span><span class="file-name"></span><input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png"></label>
      <p class="form-error"></p><button class="btn btn-amber btn-sm" type="submit" style="margin-top:4px">${VG.icon.seal} Issue certificate</button></form>`;
  }
  function bindCertificateForm(root, after) {
    $$('.cert-form', root).forEach((f) => {
      bindDrop(f.querySelector('.drop'));
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!f.file.files.length) { f.querySelector('.form-error').textContent = 'Choose the certificate file.'; return; }
        await VG.busy(f.querySelector('[type=submit]'), async () => {
          try { await VG.api('/api/admin/certificates', { method: 'POST', form: new FormData(f) }); VG.toast('Certificate issued.', 'ok'); f.reset(); after(); }
          catch (ex) { f.querySelector('.form-error').textContent = ex.message; }
        });
      });
    });
  }
  async function renderInvestments() {
    const el = viewEl('investments');
    let d;
    try { d = await VG.api('/api/admin/investments'); } catch (e) { return fail(e); }
    const total = d.investments.reduce((a, i) => a + i.amount, 0);
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
        <div class="card">${users.length ? investmentForm() : empty('users', 'Generate a member ID first.')}</div>
        <div class="card">${users.length ? certificateForm() : empty('seal', 'Generate a member ID first.')}</div></div>
      <div class="card"><div class="card-head"><h3>All investments</h3><span class="chip ok">${VG.money(total)} total</span></div>
        ${d.investments.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Date</th><th>Round</th><th class="num">Amount</th><th class="num">Shares</th><th></th></tr></thead><tbody>
          ${d.investments.map((i) => `<tr><td><b>${VG.esc(i.name || '—')}</b><div class="muted small mono">${VG.esc(i.uid)}</div></td><td>${VG.date(i.invested_on)}</td><td>${VG.esc(i.round || '—')}</td><td class="num">${VG.money(i.amount)}</td><td class="num">${VG.num(i.shares, 2)}</td>
            <td><div class="actions"><button class="btn btn-soft btn-xs" data-open="${i.user_id}">Member</button><button class="btn btn-danger btn-xs" data-del-inv="${i.id}">Delete</button></div></td></tr>`).join('')}
        </tbody></table></div>` : empty('chart', 'No investments recorded yet.')}</div>
      <div class="card"><h3>Certificates issued</h3>
        ${d.certificates.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Member</th><th>Certificate</th><th>Issued</th><th></th></tr></thead><tbody>
          ${d.certificates.map((c) => `<tr><td><b>${VG.esc(c.name || '—')}</b><div class="muted small mono">${VG.esc(c.uid)}</div></td><td>${VG.esc(c.title)}${c.certificate_no ? ' · No. ' + VG.esc(c.certificate_no) : ''}</td><td>${VG.date(c.created_at)}</td>
            <td><div class="actions"><button class="btn btn-soft btn-xs" data-view-cert="${c.id}" data-mime="${VG.esc(c.mime)}" data-title="${VG.esc(c.title)}">View</button><button class="btn btn-danger btn-xs" data-del-cert="${c.id}">Delete</button></div></td></tr>`).join('')}
        </tbody></table></div>` : empty('seal', 'No certificates issued yet.')}</div>`;
    bindInvestmentForm(el, renderInvestments);
    bindCertificateForm(el, renderInvestments);
    $$('[data-open]', el).forEach((b) => b.addEventListener('click', () => openMember(Number(b.dataset.open))));
    $$('[data-del-inv]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('Remove this investment record?', { title: 'Delete investment', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/investments/${b.dataset.delInv}`, { method: 'DELETE' }); renderInvestments(); } catch (e) { fail(e); }
    }));
    $$('[data-del-cert]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('The member will no longer see or download it.', { title: 'Delete certificate?', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/certificates/${b.dataset.delCert}`, { method: 'DELETE' }); renderInvestments(); } catch (e) { fail(e); }
    }));
    $$('[data-view-cert]', el).forEach((b) => b.addEventListener('click', () => VG.openStored(b.dataset.title, b.dataset.mime, `/api/files/cert/${b.dataset.viewCert}/raw`)));
  }

  // ================================================================ prices
  let priceChart = null;
  async function renderPrices() {
    const el = viewEl('prices');
    let list;
    try { list = await VG.api('/api/admin/prices'); } catch (e) { return fail(e); }
    const actual = list.filter((p) => p.kind === 'actual'), proj = list.filter((p) => p.kind === 'projected');
    const latest = actual[actual.length - 1];
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
        <form class="card" id="price-form"><h3>Publish a price</h3>
          <p class="muted small" style="margin-top:-4px">The newest <b>actual</b> price is what members see as the live price, and it values their holdings. <b>Projected</b> prices draw the dotted path ahead.</p>
          <div class="seg" id="price-kind" style="margin-bottom:14px"><button type="button" aria-pressed="true" data-value="actual">Actual (live)</button><button type="button" aria-pressed="false" data-value="projected">Projected</button></div>
          <div class="form-row">
            <label class="field"><span>Date</span><input class="input" type="date" name="on_date" required value="${new Date().toISOString().slice(0, 10)}"></label>
            <label class="field"><span>Price per share (${VG.esc(VG.currency)})</span><input class="input" type="number" name="price" min="0" step="any" required></label>
          </div>
          <label class="field"><span>Note <span class="hint">optional, e.g. "Seed round valuation"</span></span><input class="input" name="note" maxlength="200"></label>
          <p class="form-error" id="price-err"></p>
          <button class="btn btn-primary" type="submit">${VG.icon.chart} Publish price</button>
        </form>
        <div class="card glowy"><p class="label" style="margin:0">Live price members see</p>
          <div class="price-live" style="margin:6px 0 10px"><span class="pv">${latest ? VG.money(latest.price) : '—'}</span>${latest ? `<span class="chip">${VG.date(latest.on_date)}</span>` : ''}</div>
          <div class="chart-box" style="height:240px"><canvas id="admin-price-chart"></canvas></div></div>
      </div>
      <div class="card"><h3>Price history</h3>
        ${list.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Type</th><th class="num">Price</th><th>Note</th><th></th></tr></thead><tbody>
          ${[...list].reverse().map((p) => `<tr><td>${VG.date(p.on_date)}</td><td>${p.kind === 'actual' ? '<span class="chip warn">Actual</span>' : '<span class="chip teal">Projected</span>'}</td><td class="num">${VG.money(p.price)}</td><td class="small">${VG.esc(p.note || '')}</td><td><div class="actions"><button class="btn btn-danger btn-xs" data-pd="${p.id}">Delete</button></div></td></tr>`).join('')}
        </tbody></table></div>` : empty('chart', 'No prices yet. Publish the first one above.')}</div>`;
    let kind = 'actual';
    VG.seg($('#price-kind'), (v) => { kind = v; });
    $('#price-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      await VG.busy(e.currentTarget.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/admin/prices', { body: { ...f, kind } }); VG.toast(kind === 'actual' ? 'Live price published. Members see it within 30 seconds.' : 'Projection added.', 'ok'); renderPrices(); }
        catch (ex) { $('#price-err').textContent = ex.message; }
      });
    });
    $$('[data-pd]', el).forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('Remove this price point?', { title: 'Delete price', ok: 'Delete', danger: true }))) return;
      try { await VG.api(`/api/admin/prices/${b.dataset.pd}`, { method: 'DELETE' }); renderPrices(); } catch (e) { fail(e); }
    }));
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    if (window.Chart && list.length) {
      const css = VG.cssVar, parse = (d) => new Date(d + 'T00:00:00').getTime();
      const a = actual.map((p) => ({ x: parse(p.on_date), y: p.price }));
      const last = a[a.length - 1];
      const pr = proj.map((p) => ({ x: parse(p.on_date), y: p.price })).filter((p) => !last || p.x >= last.x);
      if (last && pr.length) pr.unshift(last);
      priceChart = new Chart($('#admin-price-chart'), {
        type: 'line',
        data: { datasets: [
          { label: 'Actual', data: a, borderColor: css('--amber'), backgroundColor: css('--amber'), tension: 0.35, borderWidth: 3, pointRadius: 3 },
          { label: 'Projected', data: pr, borderColor: css('--teal'), backgroundColor: css('--teal'), borderDash: [7, 6], tension: 0.3, borderWidth: 2.5, pointRadius: 3 },
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: css('--muted'), usePointStyle: true, boxWidth: 8 } } },
          scales: { x: { type: 'linear', grid: { display: false }, ticks: { color: css('--muted'), maxTicksLimit: 5, callback: (v) => new Date(v).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) } },
            y: { grid: { color: css('--line') + '80' }, ticks: { color: css('--muted'), callback: (v) => VG.money(v) } } } },
      });
    }
  }

  // ================================================================ chats
  async function renderChats() {
    const el = viewEl('chats');
    const wanted = Number((location.hash.split('/')[1]) || 0);
    let convos;
    try { convos = await VG.api('/api/admin/chats'); } catch (e) { return fail(e); }
    el.innerHTML = `<div class="section-title"><div><h2>Ask the Founder</h2><p>Questions from members. Replies appear in their chat within a few seconds.</p></div>
        <div class="btn-row"><select class="input" id="chat-start" style="min-height:38px;width:auto"><option value="">Message a member…</option>${memberOptions()}</select></div></div>
      <div class="inbox"><div class="inbox-list" id="inbox-list"></div>
        <div class="inbox-thread" id="inbox-thread"><div class="chat-log"><div class="chat-empty"><div class="bubbles"><i></i><i></i><i></i></div><p>Choose a conversation.</p></div></div></div></div>`;
    const paintList = (sel) => {
      const box = $('#inbox-list');
      box.innerHTML = convos.map((c) => `<button type="button" data-c="${c.id}" aria-pressed="${c.id === sel}"><span class="avatar" style="width:38px;height:38px;font-size:.9rem">${VG.initials(c.name)}</span>
          <span class="meta"><b>${VG.esc(c.name || c.uid)}</b><span>${c.last_sender === 'founder' ? 'You: ' : ''}${VG.esc(c.last_body || '')}</span></span>
          ${c.unread ? `<span class="n">${c.unread}</span>` : `<span class="muted small">${VG.ago(c.last_at)}</span>`}</button>`).join('') || `<div class="empty" style="padding:24px">${VG.icon.chat}<p>No questions yet.</p></div>`;
      $$('[data-c]', box).forEach((b) => b.addEventListener('click', () => openThread(Number(b.dataset.c))));
    };
    const openThread = async (id) => {
      clearInterval(timers.chat);
      history.replaceState(null, '', `#chats/${id}`);
      const c = convos.find((x) => x.id === id) || users.find((u) => u.id === id);
      const conv = convos.find((x) => x.id === id);
      if (conv) conv.unread = 0;
      paintList(id);
      const th = $('#inbox-thread');
      th.innerHTML = `<header class="chat-head"><span class="avatar">${VG.initials(c && c.name)}</span><div class="who"><b>${VG.esc((c && c.name) || 'Member')}</b><span>${VG.esc((c && c.uid) || '')}</span></div>
          <button class="x" type="button" data-open-member="${id}" title="Member details" aria-label="Member details">${VG.icon.user.replace('<svg', '<svg width="18" height="18"')}</button></header>
        <div class="chat-log" aria-live="polite"></div>
        <form class="chat-form"><textarea rows="1" placeholder="Write a reply…" maxlength="4000" aria-label="Reply"></textarea><button type="submit" aria-label="Send">${VG.icon.send}</button></form>`;
      $('[data-open-member]', th).addEventListener('click', () => openMember(id));
      const log = $('.chat-log', th), ta = $('textarea', th), form = $('form', th);
      let lastId = 0;
      try {
        const msgs = await VG.api(`/api/admin/chats/${id}`);
        if (!msgs.length) log.innerHTML = '<div class="chat-empty"><p>No messages yet. Say hello.</p></div>';
        lastId = VG.chatThread(log, msgs, 'founder', { theirName: (c && c.name) || '' });
        log.scrollTop = log.scrollHeight;
        loadStats();
      } catch (e) { fail(e); }
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body) return;
        ta.value = ''; ta.style.height = 'auto';
        try {
          const m = await VG.api(`/api/admin/chats/${id}`, { body: { body } });
          lastId = VG.chatThread(log, [m], 'founder');
          log.scrollTop = log.scrollHeight;
          const conv2 = convos.find((x) => x.id === id);
          if (conv2) { conv2.last_body = body; conv2.last_sender = 'founder'; conv2.last_at = Date.now(); }
          else convos.unshift({ id, uid: c.uid, name: c.name, last_body: body, last_sender: 'founder', last_at: Date.now(), unread: 0 });
          paintList(id);
        } catch (ex) { fail(ex); ta.value = body; }
      });
      ta.focus();
      timers.chat = setInterval(async () => {
        try {
          const msgs = await VG.api(`/api/admin/chats/${id}?after=${lastId}`);
          if (msgs.length) { lastId = VG.chatThread(log, msgs, 'founder', { theirName: (c && c.name) || '' }); log.scrollTop = log.scrollHeight; }
        } catch { /* keep polling */ }
      }, 4000);
    };
    $('#chat-start').addEventListener('change', (e) => { if (e.target.value) openThread(Number(e.target.value)); e.target.value = ''; });
    paintList(wanted);
    if (wanted) openThread(wanted);
    // Refresh the conversation list every 15 s so new questions show up.
    timers.chatList = setInterval(async () => {
      try {
        const fresh = await VG.api('/api/admin/chats');
        const sel = Number((location.hash.split('/')[1]) || 0);
        fresh.forEach((f) => { if (f.id === sel) f.unread = 0; });
        convos = fresh;
        paintList(sel);
      } catch { /* ignore */ }
    }, 15000);
  }

  // ================================================================ settings
  function renderSettings() {
    const el = viewEl('settings');
    const s = settings;
    el.innerHTML = `<div class="grid grid-2" style="align-items:start">
      <form class="card" id="set-form"><h3>Portal settings</h3>
        <label class="field"><span>Company name</span><input class="input" name="company_name" value="${VG.esc(s.company_name || '')}"></label>
        <label class="field"><span>Founder name <span class="hint">shown in Ask the Founder</span></span><input class="input" name="founder_name" value="${VG.esc(s.founder_name || '')}"></label>
        <div class="form-row">
          <label class="field"><span>Currency symbol</span><input class="input" name="currency" value="${VG.esc(s.currency || '₹')}" maxlength="4"></label>
          <label class="field"><span>Temporary window (hours)</span><input class="input" type="number" min="1" max="720" name="temp_access_hours" value="${VG.esc(s.temp_access_hours || 72)}"></label>
        </div>
        <label class="field"><span>Contact email</span><input class="input" type="email" name="contact_email" value="${VG.esc(s.contact_email || '')}"></label>
        <button class="btn btn-primary" type="submit">Save settings</button></form>
      <form class="card" id="admin-pwd"><h3>Admin password</h3>
        <p class="muted small" style="margin-top:-4px">The portal starts with the default admin password. Change it before you share the portal.</p>
        <label class="field"><span>Current password</span><div class="pwd-wrap"><input class="input" type="password" name="current" autocomplete="current-password" required><button type="button"></button></div></label>
        <label class="field"><span>New password</span><div class="pwd-wrap"><input class="input" type="password" name="next" autocomplete="new-password" required><button type="button"></button></div></label>
        <label class="field"><span>Confirm new password</span><div class="pwd-wrap"><input class="input" type="password" name="confirm" autocomplete="new-password" required><button type="button"></button></div></label>
        <p class="form-error" id="ap-err"></p>
        <button class="btn btn-primary" type="submit">Change password</button></form></div>`;
    VG.bindPasswords(el);
    $('#set-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { settings = await VG.api('/api/admin/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.currentTarget)) }); VG.currency = settings.currency || '₹'; VG.toast('Settings saved.', 'ok'); } catch (ex) { fail(ex); }
    });
    $('#admin-pwd').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      $('#ap-err').textContent = '';
      if (f.next !== f.confirm) { $('#ap-err').textContent = 'The new passwords do not match.'; return; }
      try { await VG.api('/api/auth/password', { body: { current: f.current, next: f.next } }); VG.toast('Admin password changed.', 'ok'); e.target.reset(); } catch (ex) { $('#ap-err').textContent = ex.message; }
    });
  }
})();
