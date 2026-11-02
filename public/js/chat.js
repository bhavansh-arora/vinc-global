/* "Ask the Founder": the floating button and chat panel for advisors and investors.
   The whole conversation is stored on the server, so it resumes on every login when the button is clicked. */
(function () {
  'use strict';
  const VG = window.VG;

  VG.chatThread = function (log, msgs, mySide, { theirName = '' } = {}) {
    // Renders messages into `log`, adding day separators. Returns the last id rendered.
    let lastDay = log.dataset.lastDay || '';
    let lastId = Number(log.dataset.lastId || 0);
    const empty = log.querySelector('.chat-empty');
    if (msgs.length && empty) empty.remove();
    for (const m of msgs) {
      if (m.id <= lastId) continue;
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) {
        const sep = document.createElement('div');
        sep.className = 'msg-day';
        sep.textContent = day === new Date().toDateString() ? 'Today' : VG.date(m.created_at);
        log.appendChild(sep);
        lastDay = day;
      }
      const el = document.createElement('div');
      el.className = 'msg ' + (m.sender === mySide ? 'me' : 'them');
      el.innerHTML = `${VG.esc(m.body)}<time>${m.sender !== mySide && theirName ? VG.esc(theirName) + ' · ' : ''}${VG.time(m.created_at)}</time>`;
      log.appendChild(el);
      lastId = m.id;
    }
    log.dataset.lastDay = lastDay;
    log.dataset.lastId = String(lastId);
    return lastId;
  };

  VG.askFounder = function ({ founderName = 'the Founder' } = {}) {
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'ask-fab';
    fab.setAttribute('aria-label', 'Ask the Founder');
    fab.innerHTML = `<span class="face">${VG.icon.chat}</span><span class="txt"><small>Have a question?</small><span><b class="typed"></b><i class="cursor"></i></span></span>`;
    document.body.appendChild(fab);
    const typed = fab.querySelector('.typed');

    // Typing animation on the button label.
    const phrases = ['Ask the Founder', 'Talk to us anytime', 'Ask the Founder'];
    let pi = 0;
    const type = async (text) => {
      if (VG.reducedMotion()) { typed.textContent = text; return; }
      for (let i = typed.textContent.length; i >= 0; i--) { typed.textContent = typed.textContent.slice(0, i); await new Promise((r) => setTimeout(r, 25)); }
      for (let i = 1; i <= text.length; i++) { typed.textContent = text.slice(0, i); await new Promise((r) => setTimeout(r, 55 + Math.random() * 40)); }
    };
    setTimeout(() => type(phrases[0]), 900);
    setInterval(() => { if (!panel) { pi = (pi + 1) % phrases.length; type(phrases[pi]); } }, 16000);

    let panel = null, poll = null, unreadTimer = null;
    const badge = (n) => {
      let b = fab.querySelector('.unread');
      if (!n) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = 'unread'; fab.appendChild(b); }
      b.textContent = n > 9 ? '9+' : n;
    };
    const checkUnread = async () => { try { const r = await VG.api('/api/chat/unread'); badge(r.unread); } catch { /* ignore */ } };
    checkUnread();
    unreadTimer = setInterval(() => { if (!panel) checkUnread(); }, 25000);

    const close = () => {
      if (!panel) return;
      clearInterval(poll);
      const p = panel; panel = null;
      p.classList.add('closing');
      setTimeout(() => p.remove(), 220);
      fab.classList.remove('open');
      fab.focus();
    };

    const open = async () => {
      if (panel) return;
      fab.classList.add('open');
      badge(0);
      panel = document.createElement('section');
      panel.className = 'chat-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Ask the Founder');
      panel.innerHTML = `<header class="chat-head">
          <span class="avatar">${VG.icon.chat.replace('<svg', '<svg width="20" height="20"')}</span>
          <div class="who"><b>Ask the Founder</b><span>Messages go straight to ${VG.esc(founderName)}</span></div>
          <button class="x" type="button" aria-label="Close chat">${VG.icon.x.replace('<svg', '<svg width="18" height="18"')}</button>
        </header>
        <div class="chat-log" aria-live="polite"><div class="viewer-loading" style="min-height:200px"><div class="spinner"></div><span>Loading your conversation…</span></div></div>
        <div class="chat-status" hidden></div>
        <form class="chat-form"><label class="sr-only" for="chat-text">Message</label>
          <textarea id="chat-text" rows="1" placeholder="Type your question…" maxlength="4000"></textarea>
          <button type="submit" aria-label="Send">${VG.icon.send}</button></form>`;
      document.body.appendChild(panel);
      const log = panel.querySelector('.chat-log');
      const form = panel.querySelector('form');
      const ta = panel.querySelector('textarea');
      panel.querySelector('.x').addEventListener('click', close);
      panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });

      const scroll = () => { log.scrollTop = log.scrollHeight; };
      let lastId = 0;
      try {
        const msgs = await VG.api('/api/chat?read=1');
        log.innerHTML = '';
        if (!msgs.length) {
          log.innerHTML = `<div class="chat-empty"><div class="bubbles"><i></i><i></i><i></i></div>
            <b style="font-family:var(--display);font-size:1.2rem">Start a conversation</b>
            <p class="small">Ask anything about VINC, the centre, the numbers or the plan. Your messages are saved, so you can come back to them any time.</p>
            <div class="chat-suggest">
              <button type="button">What are the plans for the first quarter?</button>
              <button type="button">How will the funds be used?</button>
              <button type="button">Can I visit the centre?</button>
            </div></div>`;
          log.querySelectorAll('.chat-suggest button').forEach((b) => b.addEventListener('click', () => { ta.value = b.textContent; ta.focus(); }));
        } else {
          lastId = VG.chatThread(log, msgs, 'advisor', { theirName: founderName });
          const resumed = document.createElement('div');
          resumed.className = 'msg-day';
          resumed.textContent = 'Conversation resumed';
          log.appendChild(resumed);
        }
        scroll();
      } catch (e) { log.innerHTML = `<div class="chat-empty"><p>${VG.esc(e.message)}</p></div>`; }
      ta.focus();

      poll = setInterval(async () => {
        try {
          const msgs = await VG.api(`/api/chat?read=1&after=${lastId}`);
          if (msgs.length) {
            const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
            lastId = VG.chatThread(log, msgs, 'advisor', { theirName: founderName });
            if (near) scroll();
          }
        } catch { /* keep polling */ }
      }, 4000);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body) return;
        ta.value = ''; ta.style.height = 'auto';
        try {
          const m = await VG.api('/api/chat', { body: { body } });
          lastId = VG.chatThread(log, [m], 'advisor', { theirName: founderName });
          scroll();
        } catch (ex) { VG.toast(ex.message, 'bad'); ta.value = body; }
      });
    };

    fab.addEventListener('click', open);
    return { open, close, destroy() { clearInterval(unreadTimer); close(); fab.remove(); } };
  };
})();
