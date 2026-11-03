/* Advisor / investor portal. */
(function () {
  'use strict';
  const VG = window.VG;
  const $ = (s, r = document) => r.querySelector(s);
  const HOUR = 3600 * 1000;

  const CATS = {
    board_resolutions: 'Board resolutions',
    registration: 'Registration docs',
    financials: 'Financials',
    reports: 'Reports & decks',
    legal: 'Legal',
    general: 'General',
  };
  const REQUIRED_KYC = ['PAN card', 'Aadhaar card', 'Address proof', 'Bank proof / cancelled cheque', 'Photograph'];
  const VIEWS = {
    home: ['Home', 'Your VINC Global dashboard'],
    agreements: ['Agreements', 'Sign your onboarding documents'],
    news: ['News', 'Updates from the VINC team'],
    vault: ['Data room', 'Confidential company documents · view only'],
    kyc: ['KYC documents', 'Upload and track your verification'],
    portfolio: ['My investment', 'Holdings, live share price and certificates'],
    account: ['Account', 'Your details and password'],
  };

  let data = null;
  let countdownTimer = null;
  let priceTimer = null;
  let chart = null;
  let chat = null;
  let playIntro = false;
  let gateScene = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    let me;
    try { me = (await VG.loadMe()).user; } catch { me = null; }
    if (!me) return location.replace('/login');
    if (me.role === 'admin') return location.replace('/admin');
    playIntro = VG.takeIntroFlag();
    route(me);
  }

  function route(me) {
    clearInterval(countdownTimer);
    if (me.state === 'active') return startApp();
    showGate(me);
  }

  // ---------------------------------------------------------------- gates
  function showGate(me) {
    $('#app').hidden = true;
    if (chat) { chat.destroy(); chat = null; }
    if (gateScene) { gateScene.destroy(); gateScene = null; }
    const gate = $('#gate');
    gate.hidden = false;
    const first = VG.esc((me.name || '').split(' ')[0] || 'there');
    const tools = `<div style="position:absolute;top:16px;right:16px;display:flex;gap:8px">
        <button class="icon-btn sound-btn" type="button" data-sound-toggle></button>
        <button class="btn btn-soft btn-sm" type="button" id="gate-logout">${VG.icon.logout} Log out</button></div>
      <a class="brand" href="/" data-brand style="position:absolute;top:18px;left:18px"></a>`;
    let html;
    if (me.state === 'expired') {
      const hours = me.access_expires_at && me.approved_at ? Math.round((me.access_expires_at - me.approved_at) / HOUR) : 72;
      html = `<div class="gate"><canvas id="gate-canvas" aria-hidden="true"></canvas>${tools}
        <div class="gate-card card" style="padding:clamp(24px,4vw,40px)">
          <p class="label">Your preview window has closed</p>
          <h1>Thanks for looking around, ${first}</h1>
          <p class="lead" style="margin-inline:auto">Your ${hours}-hour access ended on ${VG.dateTime(me.access_expires_at)}. If you would like to continue the conversation, ask the team to open the doors again.</p>
          <div class="access" style="text-align:left;margin:24px 0">${timelineHtml(me, true)}</div>
          <button class="btn btn-amber" type="button" id="renew">${VG.icon.refresh} Request access again</button>
        </div></div>`;
    } else {
      const renewal = me.renewal_requested;
      html = `<div class="gate"><canvas id="gate-canvas" aria-hidden="true"></canvas>${tools}
        <div class="gate-card">
          <div class="gate-queue" id="gate-queue" aria-hidden="true"></div>
          <p class="label">${renewal ? 'Renewal requested' : 'Waiting for approval'}</p>
          <h1>${renewal ? `We have your request, ${first}` : `Almost there, ${first}`}</h1>
          <p class="lead" style="margin-inline:auto">${renewal ? 'The VINC team will review your request to continue. This page opens by itself the moment they approve it.' : 'Your sign-up is with the VINC team. The portal opens by itself as soon as they approve it, either a 72-hour preview or permanent access.'}</p>
          <div class="steps-mini">
            <div class="done"><b>✓ Step 1</b>VINC ID issued</div>
            <div class="done"><b>✓ Step 2</b>${renewal ? 'Preview completed' : 'Signed up'}</div>
            <div class="now"><b>⧗ Step 3</b>Approval by the team</div>
          </div>
          <p class="muted small">Signed in as <span class="mono">${VG.esc(me.uid)}</span> · checking every 20 seconds</p>
        </div></div>`;
    }
    gate.innerHTML = html;
    VG.bubbles($('#gate-canvas'), { density: 0.7 });
    gate.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = VG.wordmark + '<span class="global">Global</span>'; });
    const sb = gate.querySelector('[data-sound-toggle]');
    sb.innerHTML = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
    sb.classList.toggle('on', !!(window.VGAmbient && window.VGAmbient.playing));
    sb.addEventListener('click', async () => { const on = await window.VGAmbient.toggle(); sb.classList.toggle('on', on); });
    $('#gate-logout').addEventListener('click', VG.logout);
    // You, standing at the VINC door until the team lets you in.
    if ($('#gate-queue')) gateScene = VG.queueScene($('#gate-queue'), { others: 0, you: { label: 'You' }, mode: 'waiting' });
    const renew = $('#renew');
    if (renew) {
      animateTimeline(gate);
      renew.addEventListener('click', () => VG.busy(renew, async () => {
        try { const { user } = await VG.api('/api/auth/request-renewal', { method: 'POST' }); VG.toast('Request sent to the VINC team.', 'ok'); showGate(user); }
        catch (e) { VG.toast(e.message, 'bad'); }
      }));
    } else {
      // Poll until approved
      const timer = setInterval(async () => {
        try {
          const { user } = await VG.loadMe();
          if (!user) { clearInterval(timer); return location.replace('/login'); }
          if (user.state === 'active') { clearInterval(timer); await celebrate(user); route(user); }
        } catch { /* keep trying */ }
      }, 20000);
    }
  }

  // Approved while waiting: the door swings open, you walk in, then the portal rises into place.
  async function celebrate(user) {
    const card = document.querySelector('.gate-card');
    if (!card) return;
    const swap = (sel, text) => { const el = card.querySelector(sel); if (el) { el.textContent = text; el.animate([{ opacity: 0, translate: '0 10px' }, { opacity: 1, translate: '0 0' }], { duration: 500, easing: 'cubic-bezier(.22,1,.36,1)' }); } };
    swap('.label', 'Approved');
    swap('h1', `The door is open, ${(user.name || '').split(' ')[0] || 'friend'}`);
    swap('.lead', 'Welcome to the VINC circle. Taking you inside…');
    card.querySelectorAll('.steps-mini .now').forEach((el) => { el.className = 'done'; el.querySelector('b').textContent = '✓ Step 3'; });
    if (gateScene) await gateScene.admit();
    await new Promise((r) => setTimeout(r, 1300));
    if (gateScene) { gateScene.destroy(); gateScene = null; }
  }

  // ---------------------------------------------------------------- app
  async function startApp() {
    $('#gate').hidden = true;
    $('#gate').innerHTML = '';
    const app = $('#app');
    app.hidden = false;
    document.querySelectorAll('[data-ic]').forEach((el) => { el.outerHTML = VG.icon[el.dataset.ic] || ''; });
    try { data = await VG.api('/api/member/overview'); }
    catch (e) {
      if (e.data && e.data.state) { const { user } = await VG.loadMe(); return route(user); }
      VG.toast(e.message, 'bad'); return;
    }
    const me = data.user;
    VG.me = me;
    $('#me-avatar').textContent = VG.initials(me.name);
    $('#me-name').textContent = me.name || me.uid;
    $('#me-uid').textContent = me.uid;

    // Mobile menu
    $('#menu-toggle').onclick = () => app.classList.add('nav-open');
    $('#side-scrim').onclick = () => app.classList.remove('nav-open');

    renderAll();
    window.addEventListener('hashchange', show);
    show();
    if (playIntro) {
      playIntro = false;
      const first = (me.name || '').split(' ')[0] || 'friend';
      await VG.welcomeIntro({
        label: 'Welcome to VINC Global',
        title: `Opening the doors, ${first}…`,
        sub: 'Advisors and investors are joining the VINC circle.',
        doneTitle: `You're in, ${first}.`,
        doneSub: 'Thank you for backing VINC. Your dashboard is ready.',
        others: 5,
        you: { label: 'You' },
        extra: `<span class="chip mono">${VG.esc(me.uid)}</span><span class="chip ${me.access_type === 'permanent' ? 'ok' : 'teal'}">${me.access_type === 'permanent' ? 'Permanent access' : 'Temporary access'}</span>`,
      });
    }
    VG.riseIn($('.view:not([hidden])'));
    if (!chat) chat = VG.askFounder({ founderName: (VG.settings && VG.settings.founder_name) || 'the Founder' });
    startPricePolling();
  }

  function renderAll() {
    paintAgreementBadge();
    renderHome();
    renderNews();
    renderVault();
    renderKyc();
    renderPortfolio();
    renderAccount();
  }

  function show() {
    const [name, sub] = (location.hash || '#home').slice(1).split('/');
    const view = VIEWS[name] ? name : 'home';
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    document.querySelectorAll('.side nav a').forEach((a) => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#view-title').textContent = VIEWS[view][0];
    $('#view-sub').textContent = VIEWS[view][1];
    $('#app').classList.remove('nav-open');
    document.title = `${VIEWS[view][0]} · VINC Global`;
    if (view === 'home') animateTimeline($('.view[data-view=home]'));
    if (view === 'portfolio') drawChart();
    if (view === 'agreements') VG.memberAgreements.render($('.view[data-view=agreements]'), sub, { onChanged: reloadAfterSigning });
    window.scrollTo({ top: 0 });
  }

  // After signing: refresh everything quietly (the member may now be permanent).
  async function reloadAfterSigning() {
    try {
      const fresh = await VG.api('/api/member/overview');
      data = fresh; VG.me = fresh.user;
      renderHome(); renderAccount(); paintAgreementBadge();
    } catch { /* keep the current view */ }
  }
  function paintAgreementBadge() {
    const b = $('#agr-badge');
    const n = (data.agreements || []).filter((a) => a.status === 'pending').length;
    b.textContent = n || ''; b.dataset.n = n;
  }

  // ---------------------------------------------------------------- access timeline
  function timelineHtml(me, ended) {
    if (me.access_type === 'permanent') {
      return `<div class="access permanent"><div class="perm">
        <svg class="infinity" viewBox="0 0 100 50" aria-hidden="true"><path class="bg" d="M25 25c0-9 7-15 14-15 12 0 18 30 30 30 7 0 14-6 14-15S76 10 69 10C57 10 51 40 39 40c-7 0-14-6-14-15z"/><path class="fg" d="M25 25c0-9 7-15 14-15 12 0 18 30 30 30 7 0 14-6 14-15S76 10 69 10C57 10 51 40 39 40c-7 0-14-6-14-15z"/></svg>
        <div><p class="label" style="margin:0 0 4px">Permanent access</p><h3 style="margin:0">You are part of the VINC circle</h3><p class="muted small" style="margin:4px 0 0">Approved on ${VG.date(me.approved_at)}. Your access does not expire.</p></div></div></div>`;
    }
    const start = me.approved_at || Date.now();
    const end = me.access_expires_at || start + 72 * HOUR;
    const total = end - start;
    const hours = Math.round(total / HOUR);
    const marks = [0, 1 / 3, 2 / 3, 1].map((f, i) => {
      const t = start + total * f;
      const done = Date.now() >= t;
      const label = i === 0 ? 'Approved' : i === 3 ? 'Window closes' : `${Math.round(hours * f)} h`;
      return `<div class="tl-mark ${done ? 'done' : ''}" style="left:${f * 100}%"><b>${label}</b><span>${VG.dateTime(t)}</span></div>`;
    }).join('');
    return `<div class="access" data-start="${start}" data-end="${end}">
      <div class="access-top">
        <div><p class="label" style="margin:0 0 4px">${ended ? 'Preview ended' : `Temporary access · ${hours}-hour window`}</p>
          <h3 style="margin:0">${ended ? 'Your window has closed' : 'Your preview window is open'}</h3>
          <p class="muted small" style="margin:4px 0 0">${ended ? 'Request access again to continue.' : (data && (data.agreements || []).some((a) => a.status === 'pending') ? 'Sign your agreement in <a href="#agreements">Agreements</a> to become a permanent member.' : 'Want to keep going after this? Ask the founder, or request access again when the window closes.')}</p></div>
        ${ended ? '' : `<div class="countdown" aria-live="off"><div><b data-cd="h">--</b><span>hours</span></div><div><b data-cd="m">--</b><span>min</span></div><div><b data-cd="s">--</b><span>sec</span></div></div>`}
      </div>
      <div class="tl"><div class="tl-track"><div class="tl-fill"></div><div class="tl-now"><span class="tag">${ended ? 'Closed' : 'Now'}</span></div></div>
        <div class="tl-marks">${marks}</div></div>
    </div>`;
  }

  function animateTimeline(root) {
    const acc = root && root.querySelector('.access[data-start]');
    if (!acc) return;
    const start = Number(acc.dataset.start), end = Number(acc.dataset.end);
    const fill = acc.querySelector('.tl-fill'), now = acc.querySelector('.tl-now');
    const pct = () => Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
    fill.style.width = '0%'; now.style.left = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = pct() + '%'; now.style.left = pct() + '%'; }));
    const cd = { h: acc.querySelector('[data-cd=h]'), m: acc.querySelector('[data-cd=m]'), s: acc.querySelector('[data-cd=s]') };
    if (!cd.h) return;
    clearInterval(countdownTimer);
    const set = (el, v) => { const t = String(v).padStart(2, '0'); if (el.textContent !== t) { el.textContent = t; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); } };
    const tick = async () => {
      const left = end - Date.now();
      if (left <= 0) {
        clearInterval(countdownTimer);
        const { user } = await VG.loadMe();
        return route(user);
      }
      set(cd.h, Math.floor(left / HOUR)); set(cd.m, Math.floor((left % HOUR) / 60000)); set(cd.s, Math.floor((left % 60000) / 1000));
      const p = pct();
      fill.style.transition = 'none'; now.style.transition = 'none';
      if (Math.abs(parseFloat(fill.style.width) - p) > 0.05) { fill.style.width = p + '%'; now.style.left = p + '%'; }
    };
    setTimeout(() => { tick(); countdownTimer = setInterval(tick, 1000); }, 2300);
    cd.h.textContent = String(Math.floor(Math.max(0, end - Date.now()) / HOUR)).padStart(2, '0');
  }

  // ---------------------------------------------------------------- home
  function kycSummary() {
    const docs = data.kyc || [];
    const by = Object.fromEntries(docs.map((r) => [r.status, r.n]));
    return { verified: by.verified || 0, submitted: by.submitted || 0, rejected: by.rejected || 0 };
  }

  function renderHome() {
    const me = data.user;
    const p = data.portfolio;
    const k = kycSummary();
    const first = (me.name || '').split(' ')[0] || 'there';
    const el = $('.view[data-view=home]');
    const latest = p.prices.latest;
    el.innerHTML = `
      <div class="hello"><canvas id="hello-canvas" aria-hidden="true"></canvas>
        <div class="hello-row"><div>
          <p class="label">${me.role === 'investor' ? 'Investor' : 'Advisor'} · VINC Global</p>
          <h2>${VG.greeting()}, ${VG.esc(first)}</h2>
          <p>Thank you for backing VINC. Here is everything new since your last visit.</p></div>
          <div class="btn-row"><span class="chip mono">${VG.esc(me.uid)}</span><span class="chip">${me.access_type === 'permanent' ? 'Permanent access' : 'Temporary access'}</span></div>
        </div>
      </div>
      ${agreementBanner()}
      <div class="card">${timelineHtml(me, false)}</div>
      <div class="grid grid-4">
        <a class="card glowy stat stat-tile" style="--c:var(--teal);text-decoration:none" href="#portfolio"><span class="k">Share price</span><span class="v" id="home-price">${latest ? VG.money(latest.price, p.currency) : '—'}</span><span class="s">${latest ? 'as of ' + VG.date(latest.on_date) : 'Not published yet'}</span></a>
        <a class="card glowy stat stat-tile" style="--c:var(--amber);text-decoration:none" href="#portfolio"><span class="k">Your holding</span><span class="v">${p.totals.value != null && p.totals.shares ? VG.money(p.totals.value, p.currency) : p.totals.invested ? VG.money(p.totals.invested, p.currency) : '—'}</span><span class="s">${p.totals.shares ? VG.num(p.totals.shares) + ' shares' : 'No investment recorded yet'}</span></a>
        <a class="card glowy stat stat-tile" style="--c:var(--plum);text-decoration:none" href="#vault"><span class="k">Data room</span><span class="v" data-count="${data.documents.length}">0</span><span class="s">documents to view</span></a>
        <a class="card glowy stat stat-tile" style="--c:var(--olive);text-decoration:none" href="#kyc"><span class="k">KYC</span><span class="v">${k.verified}/${REQUIRED_KYC.length}</span><span class="s">${k.submitted ? k.submitted + ' waiting for review' : k.verified >= REQUIRED_KYC.length ? 'All verified' : 'documents verified'}</span></a>
      </div>
      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h3>Latest news</h3><a class="btn btn-soft btn-xs" href="#news">All news</a></div>
          <div class="news-list">${data.news.slice(0, 3).map(newsItem).join('') || emptyHtml('news', 'No news yet. The team will post updates here.')}</div></div>
        <div class="card"><div class="card-head"><h3>New in the data room</h3><a class="btn btn-soft btn-xs" href="#vault">Open data room</a></div>
          <div class="docs" style="grid-template-columns:1fr">${data.documents.slice(0, 4).map(docCard).join('') || emptyHtml('vault', 'Documents will appear here once the team shares them.')}</div></div>
      </div>`;
    VG.bubbles($('#hello-canvas'), { density: 0.6, dark: true });
    el.querySelectorAll('[data-count]').forEach((n) => VG.countUp(n, Number(n.dataset.count)));
    bindDocs(el);
  }

  function agreementBanner() {
    const list = data.agreements || [];
    const pendingAll = list.filter((a) => a.status === 'pending' && a.mandatory !== false);
    const pending = pendingAll[0] || list.find((a) => a.status === 'pending');
    const names = (pendingAll.length ? pendingAll : list.filter((a) => a.status === 'pending')).map((a) => a.title);
    const nameText = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
    const waiting = list.find((a) => a.status === 'member_signed');
    if (pending) {
      return `<a class="card agr-banner" href="#agreements">
        <span class="agr-ic">${VG.icon.file}</span>
        <div style="flex:1;min-width:0"><p class="label" style="margin:0 0 2px">One step to permanent membership</p>
          <h3 style="margin:0">Sign your ${VG.esc(nameText)}</h3>
          <p class="muted small" style="margin:2px 0 0">Fill in a few details and sign on screen. It takes about ${names.length > 1 ? 'five' : 'three'} minutes.</p></div>
        <span class="btn btn-amber btn-sm">Review and sign ${VG.icon.arrow}</span></a>`;
    }
    if (waiting) {
      return `<a class="card agr-banner waiting" href="#agreements"><span class="agr-ic">${VG.icon.clock}</span>
        <div style="flex:1"><p class="label" style="margin:0 0 2px">Thank you for signing</p><h3 style="margin:0">VINC will countersign your ${VG.esc(waiting.title)} shortly</h3></div></a>`;
    }
    return '';
  }

  function emptyHtml(icon, text) {
    return `<div class="empty">${VG.icon[icon] || VG.icon.inbox}<p>${VG.esc(text)}</p></div>`;
  }

  function newsItem(n) {
    return `<article class="news-item ${n.pinned ? 'pinned' : ''}">
      <div class="nm">${n.tag ? `<span class="chip warn">${VG.esc(n.tag)}</span>` : ''}<span>${VG.date(n.created_at)}</span>${n.pinned ? '<span class="chip teal">Pinned</span>' : ''}</div>
      <h3>${VG.esc(n.title)}</h3><p>${VG.esc(n.body)}</p></article>`;
  }

  // ---------------------------------------------------------------- news
  function renderNews() {
    $('.view[data-view=news]').innerHTML = `<div class="section-title"><div><h2>News from the lab</h2><p>Milestones, partnerships and updates, newest first.</p></div></div>
      <div class="news-list">${data.news.map(newsItem).join('') || `<div class="card">${emptyHtml('news', 'No news yet.')}</div>`}</div>`;
  }

  // ---------------------------------------------------------------- data room
  function docCard(d, i = 0) {
    const kind = d.kind === 'excel' ? 'excel' : d.kind;
    const label = { pdf: 'PDF', excel: 'XLS', link: 'LINK' }[d.kind];
    return `<button type="button" class="doc" data-doc="${d.id}" style="--i:${i}">
      <span class="kind ${kind}">${label}</span>
      <span class="dm"><b>${VG.esc(d.title)}</b>${d.description ? `<p>${VG.esc(d.description)}</p>` : ''}
        <span class="meta"><span class="chip">${VG.esc(CATS[d.category] || 'General')}</span>${d.personal ? '<span class="chip plum">Just for you</span>' : ''}<span class="muted small">${VG.date(d.created_at)}</span></span></span>
    </button>`;
  }
  function bindDocs(root) {
    root.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => {
      const d = data.documents.find((x) => String(x.id) === b.dataset.doc);
      if (d) VG.openDocument(d);
    }));
  }
  function renderVault() {
    const el = $('.view[data-view=vault]');
    const cats = [...new Set(data.documents.map((d) => d.category))];
    el.innerHTML = `<div class="section-title"><div><h2>Confidential data room</h2><p>Everything opens right here in view-only mode, watermarked with your ID. Please do not share screenshots.</p></div></div>
      ${data.documents.length ? `<div class="filters" id="doc-filters"><button class="filter" type="button" aria-pressed="true" data-cat="">All <span class="muted">${data.documents.length}</span></button>
        ${cats.map((c) => `<button class="filter" type="button" aria-pressed="false" data-cat="${c}">${VG.esc(CATS[c] || c)}</button>`).join('')}</div>` : ''}
      <div class="docs" id="doc-grid"></div>`;
    const grid = $('#doc-grid');
    const paint = (cat) => {
      const list = data.documents.filter((d) => !cat || d.category === cat);
      grid.innerHTML = list.map(docCard).join('') || `<div class="card">${emptyHtml('vault', 'Nothing here yet. Documents appear as soon as the team shares them.')}</div>`;
      bindDocs(grid);
    };
    el.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paint(b.dataset.cat);
    }));
    paint('');
  }

  // ---------------------------------------------------------------- KYC
  async function renderKyc() {
    const el = $('.view[data-view=kyc]');
    let k;
    try { k = await VG.api('/api/member/kyc'); } catch (e) { el.innerHTML = `<div class="card">${VG.esc(e.message)}</div>`; return; }
    const latestBy = {};
    k.docs.forEach((d) => { if (!latestBy[d.doc_type]) latestBy[d.doc_type] = d; });
    const verified = REQUIRED_KYC.filter((t) => latestBy[t] && latestBy[t].status === 'verified').length;
    const pctDone = Math.round((verified / REQUIRED_KYC.length) * 100);
    const pending = k.docs.filter((d) => d.status === 'submitted').length;
    const badge = $('#kyc-badge');
    const missing = REQUIRED_KYC.filter((t) => !latestBy[t] || latestBy[t].status === 'rejected').length;
    badge.textContent = missing || ''; badge.dataset.n = missing;
    const statusChip = (s) => s === 'verified' ? '<span class="chip ok"><span class="dot"></span>Verified</span>' : s === 'rejected' ? '<span class="chip bad"><span class="dot"></span>Needs a new copy</span>' : '<span class="chip warn"><span class="dot"></span>Under review</span>';
    el.innerHTML = `<div class="section-title"><div><h2>KYC documents</h2><p>Clear photos or PDFs, up to 25 MB each. Only you and the VINC team can see them.</p></div></div>
      <div class="card" style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
        <div class="ring-progress" id="kyc-ring" style="--p:0"><b>${pctDone}%</b></div>
        <div style="flex:1;min-width:240px"><h3 style="margin:0 0 4px">${verified === REQUIRED_KYC.length ? 'Your KYC is complete' : `${verified} of ${REQUIRED_KYC.length} documents verified`}</h3>
          <p class="muted" style="margin:0 0 14px">${pending ? `${pending} document${pending > 1 ? 's are' : ' is'} with the team for review.` : 'Upload each document below; the team will verify it.'}</p>
          <div class="kyc-steps">${REQUIRED_KYC.map((t) => {
            const d = latestBy[t]; const s = d ? d.status : '';
            const icon = s === 'verified' ? VG.icon.check : s === 'rejected' ? VG.icon.x : s ? VG.icon.clock : VG.icon.upload;
            return `<div class="kyc-step ${s}"><span class="ic">${icon}</span><b>${VG.esc(t)}</b>${d ? statusChip(s) : '<span class="muted small">Not uploaded</span>'}</div>`;
          }).join('')}</div></div>
      </div>
      <div class="grid grid-2" style="align-items:start">
        <form class="card" id="kyc-form"><h3>Upload a document</h3>
          <label class="field"><span>Document type</span><select class="input" name="doc_type">${k.types.map((t) => `<option ${!latestBy[t] && REQUIRED_KYC.includes(t) ? '' : ''}>${VG.esc(t)}</option>`).join('')}</select></label>
          <label class="drop" id="kyc-drop">${VG.icon.upload}<b>Drop a file here or tap to choose</b><span class="muted small">PDF, JPG or PNG</span><span class="file-name"></span>
            <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"></label>
          <p class="form-error" id="kyc-err"></p>
          <button class="btn btn-primary" type="submit">${VG.icon.upload} Upload</button>
        </form>
        <div class="card"><h3>Your uploads</h3>
          ${k.docs.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Document</th><th>Status</th><th></th></tr></thead><tbody>
            ${k.docs.map((d) => `<tr><td><b>${VG.esc(d.doc_type)}</b><div class="muted small">${VG.esc(d.original_name || '')} · ${VG.date(d.uploaded_at)}</div>${d.remark ? `<div class="small" style="color:var(--bad)">${VG.esc(d.remark)}</div>` : ''}</td>
              <td>${statusChip(d.status)}</td>
              <td><div class="actions"><button class="btn btn-soft btn-xs" data-kv="${d.id}">View</button>${d.status !== 'verified' ? `<button class="btn btn-danger btn-xs" data-kd="${d.id}">Remove</button>` : ''}</div></td></tr>`).join('')}
          </tbody></table></div>` : emptyHtml('id', 'Nothing uploaded yet.')}
        </div>
      </div>`;
    // Pre-select the first missing required document.
    const firstMissing = REQUIRED_KYC.find((t) => !latestBy[t] || latestBy[t].status === 'rejected');
    if (firstMissing) el.querySelector('select').value = firstMissing;
    requestAnimationFrame(() => setTimeout(() => $('#kyc-ring').style.setProperty('--p', pctDone), 100));
    bindDrop($('#kyc-drop'));
    $('#kyc-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget, err = $('#kyc-err');
      err.textContent = '';
      if (!form.file.files.length) { err.textContent = 'Choose a file first.'; return; }
      await VG.busy(form.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/member/kyc', { method: 'POST', form: new FormData(form) }); VG.toast('Uploaded. The team will review it shortly.', 'ok'); await renderKyc(); }
        catch (ex) { err.textContent = ex.message; }
      });
    });
    el.querySelectorAll('[data-kv]').forEach((b) => b.addEventListener('click', () => {
      const d = k.docs.find((x) => String(x.id) === b.dataset.kv);
      VG.openStored(d.doc_type, d.mime, `/api/files/kyc/${d.id}/raw`, d.original_name);
    }));
    el.querySelectorAll('[data-kd]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await VG.confirm('This removes the upload so you can send a new one.', { title: 'Remove this document?', ok: 'Remove', danger: true }))) return;
      try { await VG.api(`/api/member/kyc/${b.dataset.kd}`, { method: 'DELETE' }); await renderKyc(); } catch (ex) { VG.toast(ex.message, 'bad'); }
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

  // ---------------------------------------------------------------- portfolio
  function renderPortfolio() {
    const el = $('.view[data-view=portfolio]');
    const p = data.portfolio, t = p.totals, cur = p.currency;
    const latest = p.prices.latest, target = p.prices.target;
    const prev = p.prices.actual.length > 1 ? p.prices.actual[p.prices.actual.length - 2].price : null;
    const change = latest && prev ? ((latest.price - prev) / prev) * 100 : null;
    const gainPct = t.gain != null && t.invested ? (t.gain / t.invested) * 100 : null;
    el.innerHTML = `<div class="section-title"><div><h2>My investment</h2><p>Your holdings in ${VG.esc((VG.settings && VG.settings.company_name) || 'VINC')}, valued at the latest share price the company has published.</p></div></div>
      <div class="card glowy">
        <div class="card-head"><div><p class="label" style="margin:0">Live share price</p></div><span class="chip live"><span class="dot"></span><span id="price-updated">${p.prices.updated_at ? 'updated ' + VG.ago(p.prices.updated_at) : 'waiting for first price'}</span></span></div>
        <div class="price-live"><span class="pv" id="pv">${latest ? VG.money(latest.price, cur) : '—'}</span>
          ${change != null ? `<span class="chip ${change >= 0 ? 'ok' : 'bad'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}% since last price</span>` : ''}
          ${target ? `<span class="chip teal">Projected ${VG.money(target.price, cur)} by ${VG.date(target.on_date)}</span>` : ''}</div>
        <div class="chart-box" style="margin-top:18px"><canvas id="price-chart" aria-label="Share price history and projection" role="img"></canvas></div>
        <p class="muted small" style="margin:10px 0 0">Prices are set by the company from its latest valuation; projections are targets, not promises. This is not a market quote.</p>
      </div>
      <div class="grid grid-3">
        <div class="card stat stat-tile" style="--c:var(--amber)"><span class="k">Total invested</span><span class="v">${VG.money(t.invested, cur)}</span><span class="s">${p.investments.length} investment${p.investments.length === 1 ? '' : 's'}</span></div>
        <div class="card stat stat-tile" style="--c:var(--plum)"><span class="k">Shares held</span><span class="v">${VG.num(t.shares, 2)}</span><span class="s">${t.avg_price ? 'avg ' + VG.money(t.avg_price, cur) + ' a share' : '—'}</span></div>
        <div class="card stat stat-tile" style="--c:var(--teal)"><span class="k">Current value</span><span class="v">${VG.money(t.value, cur)}</span><span class="s ${gainPct != null ? (gainPct >= 0 ? 'up' : 'down') : ''}">${gainPct != null ? `${t.gain >= 0 ? '+' : '−'}${VG.money(Math.abs(t.gain), cur)} (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%)` : '—'}</span></div>
      </div>
      ${t.projected_value != null && t.shares ? `<div class="card" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;border-left:4px solid var(--teal)">
        <span class="avatar teal" style="width:52px;height:52px">${VG.icon.rocket}</span>
        <div style="flex:1;min-width:220px"><p class="label" style="margin:0 0 2px">Projected value</p><h3 style="margin:0">${VG.money(t.projected_value, cur)} <span class="muted small" style="font-family:var(--body)">at ${VG.money(target.price, cur)} a share by ${VG.date(target.on_date)}${target.note ? ' · ' + VG.esc(target.note) : ''}</span></h3></div>
        ${t.invested ? `<span class="chip ok" style="font-size:.9rem">${(t.projected_value / t.invested).toFixed(1)}× your investment</span>` : ''}</div>` : ''}
      <div class="grid grid-2" style="align-items:start">
        <div class="card"><h3>Investments</h3>
          ${p.investments.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Round</th><th class="num">Amount</th><th class="num">Shares</th></tr></thead><tbody>
          ${p.investments.map((i) => `<tr><td>${VG.date(i.invested_on)}</td><td>${VG.esc(i.round || '—')}${i.note ? `<div class="muted small">${VG.esc(i.note)}</div>` : ''}</td><td class="num">${VG.money(i.amount, cur)}</td><td class="num">${VG.num(i.shares, 2)}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHtml('chart', 'Your investments will show here once the team records them.')}
        </div>
        <div class="card"><h3>Share certificates</h3>
          <div class="grid" style="gap:10px">${p.certificates.map((c) => `<div class="cert"><span class="seal">${VG.icon.seal}</span>
            <div class="cm"><b>${VG.esc(c.title)}</b><span class="muted small">${c.certificate_no ? 'No. ' + VG.esc(c.certificate_no) + ' · ' : ''}issued ${VG.date(c.created_at)}</span></div>
            <div class="btn-row"><button class="btn btn-soft btn-xs" data-cv="${c.id}">View</button><a class="btn btn-amber btn-xs" href="/api/files/cert/${c.id}/raw?download=1" download>${VG.icon.download} Download</a></div></div>`).join('') || emptyHtml('seal', 'Certificates appear here when they are issued.')}</div>
        </div>
      </div>`;
    el.querySelectorAll('[data-cv]').forEach((b) => b.addEventListener('click', () => {
      const c = p.certificates.find((x) => String(x.id) === b.dataset.cv);
      VG.openStored(c.title, /\.pdf$/i.test(c.original_name || '') ? 'application/pdf' : 'image', `/api/files/cert/${c.id}/raw`, c.certificate_no ? 'No. ' + c.certificate_no : '');
    }));
    if (!$('.view[data-view=portfolio]').hidden) drawChart();
  }

  function drawChart() {
    const canvas = $('#price-chart');
    if (!canvas || !window.Chart) return;
    const p = data.portfolio;
    const actual = p.prices.actual, projected = p.prices.projected;
    if (chart) { chart.destroy(); chart = null; }
    if (!actual.length && !projected.length) {
      canvas.parentElement.innerHTML = emptyHtml('chart', 'The share price chart appears once the company publishes a price.');
      return;
    }
    const css = VG.cssVar;
    const parse = (d) => new Date(d + 'T00:00:00').getTime();
    const actualPts = actual.map((x) => ({ x: parse(x.on_date), y: x.price }));
    const lastActual = actualPts[actualPts.length - 1];
    const projPts = projected.map((x) => ({ x: parse(x.on_date), y: x.price })).filter((pt) => !lastActual || pt.x >= lastActual.x);
    if (lastActual && projPts.length) projPts.unshift(lastActual);
    const all = [...actualPts, ...projPts].map((pt) => pt.x);
    const min = Math.min(...all), max = Math.max(...all);
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 300);
    grad.addColorStop(0, css('--glow').replace(/[\d.]+\)$/, '0.35)'));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    const avg = p.totals.avg_price;
    Chart.defaults.font.family = css('--body') || 'DM Sans';
    Chart.defaults.color = css('--muted');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          { label: 'Share price', data: actualPts, borderColor: css('--amber'), backgroundColor: grad, fill: true, tension: 0.35, borderWidth: 3, pointRadius: 4, pointBackgroundColor: css('--card'), pointBorderColor: css('--amber'), pointBorderWidth: 2, pointHoverRadius: 6 },
          { label: 'Projected', data: projPts, borderColor: css('--teal'), borderDash: [7, 6], borderWidth: 2.5, tension: 0.3, pointRadius: (c) => (c.dataIndex === 0 && lastActual ? 0 : 4), pointBackgroundColor: css('--card'), pointBorderColor: css('--teal'), pointBorderWidth: 2, fill: false },
          ...(avg ? [{ label: 'Your average price', data: [{ x: min, y: avg }, { x: max, y: avg }], borderColor: css('--plum'), borderWidth: 1.5, borderDash: [2, 4], pointRadius: 0, fill: false }] : []),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: VG.reducedMotion() ? 0 : 1400, easing: 'easeOutQuart' },
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { type: 'linear', min, max: max === min ? max + 86400000 : max, grid: { display: false }, border: { color: css('--line') },
            ticks: { maxTicksLimit: 6, callback: (v) => new Date(v).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) } },
          y: { grid: { color: css('--line') + '80' }, border: { display: false }, ticks: { callback: (v) => VG.money(v, p.currency) } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 18 } },
          tooltip: { backgroundColor: css('--ink'), titleColor: css('--paper'), bodyColor: css('--paper'), padding: 12, cornerRadius: 12, displayColors: false,
            callbacks: { title: (items) => VG.date(items[0].parsed.x), label: (c) => `${c.dataset.label}: ${VG.money(c.parsed.y, p.currency)}` } },
        },
      },
    });
  }
  document.addEventListener('vg:theme', () => { if (!$('.view[data-view=portfolio]').hidden) drawChart(); });

  function startPricePolling() {
    const top = $('#top-price');
    const paintTop = (latest) => {
      if (!latest) { top.hidden = true; return; }
      top.hidden = false;
      top.querySelector('span:last-child').textContent = 'Share ' + VG.money(latest.price, data.portfolio.currency);
    };
    paintTop(data.portfolio.prices.latest);
    clearInterval(priceTimer);
    priceTimer = setInterval(async () => {
      try {
        const r = await VG.api('/api/member/price');
        const old = data.portfolio.prices.latest;
        const changed = r.latest && (!old || old.price !== r.latest.price || old.on_date !== r.latest.on_date);
        if (changed) {
          data.portfolio = await VG.api('/api/member/portfolio');
          renderPortfolio();
          renderHome();
          const pv = $('#pv'); if (pv) { pv.classList.add('flash'); }
          VG.toast(`New share price: ${VG.money(r.latest.price, r.currency)}`, 'ok');
        }
        paintTop(r.latest);
        const up = $('#price-updated'); if (up && data.portfolio.prices.updated_at) up.textContent = 'updated ' + VG.ago(data.portfolio.prices.updated_at);
      } catch (e) {
        if (e.status === 401 || e.status === 403) { clearInterval(priceTimer); const { user } = await VG.loadMe(); if (!user) location.replace('/login'); else route(user); }
      }
    }, 30000);
  }

  // ---------------------------------------------------------------- account
  function renderAccount() {
    const me = data.user;
    const labels = { login: 'Logged in', signup: 'Signed up', approved_temporary: 'Temporary access approved', approved_permanent: 'Permanent access approved', renewal_requested: 'Asked for access again', kyc_uploaded: 'Uploaded KYC', kyc_verified: 'KYC verified', kyc_rejected: 'KYC needs a new copy', viewed_document: 'Viewed', downloaded_certificate: 'Downloaded certificate', investment_recorded: 'Investment recorded', certificate_issued: 'Certificate issued', password_changed: 'Password changed', id_generated: 'VINC ID created' };
    $('.view[data-view=account]').innerHTML = `<div class="section-title"><div><h2>Your account</h2><p>To change your name, email or phone, ask the founder in the chat.</p></div></div>
      <div class="grid grid-2" style="align-items:start">
        <div class="card"><h3>Profile</h3>
          <div class="table-wrap"><table class="t"><tbody>
            <tr><th>VINC ID</th><td class="mono">${VG.esc(me.uid)}</td></tr>
            <tr><th>Name</th><td>${VG.esc(me.name || '—')}</td></tr>
            <tr><th>Email</th><td>${VG.esc(me.email || '—')}</td></tr>
            <tr><th>Phone</th><td>${VG.esc(me.phone || '—')}</td></tr>
            <tr><th>Organisation</th><td>${VG.esc(me.organisation || '—')}</td></tr>
            <tr><th>Role</th><td>${me.role === 'investor' ? 'Investor' : 'Advisor'}</td></tr>
            <tr><th>Access</th><td>${me.access_type === 'permanent' ? 'Permanent' : 'Temporary, until ' + VG.dateTime(me.access_expires_at)}</td></tr>
          </tbody></table></div>
          <h3 style="margin-top:22px">Recent activity</h3>
          <ul class="log">${data.log.map((l) => `<li><b>${VG.esc(labels[l.action] || l.action)}</b>${l.detail ? ' · ' + VG.esc(l.detail) : ''}<time>${VG.dateTime(l.at)}</time></li>`).join('')}</ul>
        </div>
        <div class="grid" style="gap:18px;align-content:start">
        <div class="card"><h3>Email notifications</h3>
          <p class="muted small" style="margin-top:-4px">We always email you about your access, KYC, investments and certificates${me.email ? ` at <b>${VG.esc(me.email)}</b>` : ''}.</p>
          <label class="switch"><input type="checkbox" id="email-updates" ${me.email_updates !== false ? 'checked' : ''}><span class="track" aria-hidden="true"></span>
            <span><b>Email me about updates</b><br><span class="muted small">News, new documents, share price changes and replies from the founder.</span></span></label>
        </div>
        <form class="card" id="pwd-form"><h3>Change password</h3>
          <label class="field"><span>Current password</span><div class="pwd-wrap"><input class="input" type="password" name="current" autocomplete="current-password" required><button type="button"></button></div></label>
          <label class="field"><span>New password <span class="hint">8+ characters, letters and numbers</span></span><div class="pwd-wrap"><input class="input" type="password" name="next" autocomplete="new-password" required><button type="button"></button></div></label>
          <label class="field"><span>Confirm new password</span><div class="pwd-wrap"><input class="input" type="password" name="confirm" autocomplete="new-password" required><button type="button"></button></div></label>
          <p class="form-error" id="pwd-err"></p>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
        </div>
      </div>`;
    $('#email-updates').addEventListener('change', async (e) => {
      try {
        const u = await VG.api('/api/member/prefs', { method: 'PATCH', body: { email_updates: e.target.checked } });
        data.user.email_updates = u.email_updates;
        VG.toast(u.email_updates ? 'You will get update emails.' : 'Update emails turned off.', 'ok');
      } catch (ex) { e.target.checked = !e.target.checked; VG.toast(ex.message, 'bad'); }
    });
    VG.bindPasswords($('.view[data-view=account]'));
    $('#pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const err = $('#pwd-err'); err.textContent = '';
      if (f.next !== f.confirm) { err.textContent = 'The new passwords do not match.'; return; }
      await VG.busy(e.currentTarget.querySelector('[type=submit]'), async () => {
        try { await VG.api('/api/auth/password', { body: { current: f.current, next: f.next } }); VG.toast('Password updated.', 'ok'); e.target.reset(); }
        catch (ex) { err.textContent = ex.message; }
      });
    });
  }
})();
