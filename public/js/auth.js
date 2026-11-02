/* Log-in and sign-up pages. */
(function () {
  'use strict';
  const VG = window.VG;

  document.addEventListener('DOMContentLoaded', async () => {
    VG.bubbles(document.getElementById('art-canvas'), { density: 0.8, dark: true });

    // Already signed in? Go straight to the right place.
    try {
      const { user } = await VG.loadMe();
      if (user) { location.replace(user.role === 'admin' ? '/admin' : '/advisor'); return; }
    } catch { /* stay */ }

    const login = document.getElementById('login-form');
    if (login) initLogin(login);
    const signup = document.getElementById('signup-form');
    if (signup) initSignup(signup);
  });

  function initLogin(form) {
    const err = document.getElementById('err');
    const uid = document.getElementById('uid');
    const label = document.getElementById('uid-label');
    const params = new URLSearchParams(location.search);
    if (params.get('uid')) uid.value = params.get('uid');
    VG.seg(document.getElementById('who'), (v) => {
      label.textContent = v === 'admin' ? 'Admin ID' : 'VINC ID';
      uid.placeholder = v === 'admin' ? 'admin' : 'VG-ADV-XXXXXX';
      uid.classList.toggle('mono', v !== 'admin');
      document.getElementById('alt').hidden = v === 'admin';
      uid.focus();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const btn = form.querySelector('[type=submit]');
      const fd = new FormData(form);
      if (!fd.get('uid') || !fd.get('password')) { err.textContent = 'Enter your ID and password.'; return; }
      await VG.busy(btn, async () => {
        try {
          const { user } = await VG.api('/api/auth/login', { body: { uid: fd.get('uid').trim(), password: fd.get('password') } });
          btn.textContent = 'Welcome ✓';
          try { sessionStorage.setItem('vg:intro', '1'); } catch { /* the intro is optional */ }
          setTimeout(() => location.assign(user.role === 'admin' ? '/admin' : '/advisor'), 250);
        } catch (ex) {
          err.textContent = ex.message;
          if (ex.data && ex.data.code === 'signup') err.innerHTML = `${VG.esc(ex.message)} <a href="/signup?uid=${encodeURIComponent(fd.get('uid'))}">Sign up now</a>`;
          form.animate([{ translate: '0' }, { translate: '-8px' }, { translate: '8px' }, { translate: '-4px' }, { translate: '0' }], { duration: 360, easing: 'ease-out' });
        }
      });
    });
  }

  function initSignup(form) {
    const err = document.getElementById('err');
    const pwd = document.getElementById('pwd');
    const meter = document.getElementById('meter');
    const meterLabel = document.getElementById('meter-label');
    const params = new URLSearchParams(location.search);
    if (params.get('uid')) form.uid.value = params.get('uid');
    pwd.addEventListener('input', () => {
      const s = VG.strength(pwd.value);
      meter.style.setProperty('--p', (pwd.value ? Math.max(8, s.score * 20) : 0) + '%');
      meter.style.setProperty('--c', s.color);
      meterLabel.textContent = pwd.value ? s.label : '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const fd = Object.fromEntries(new FormData(form));
      if (fd.password !== fd.confirm) { err.textContent = 'The two passwords do not match.'; return; }
      const btn = form.querySelector('[type=submit]');
      await VG.busy(btn, async () => {
        try {
          await VG.api('/api/auth/signup', { body: { uid: fd.uid.trim(), name: fd.name, email: fd.email, phone: fd.phone, organisation: fd.organisation, password: fd.password } });
          const card = document.getElementById('signup-card');
          card.innerHTML = `<div class="success-burst">
              <svg class="tick" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45"/><path d="M30 52l13 13 27-29"/></svg>
              <p class="label">Request sent</p>
              <h1>Thank you, ${VG.esc(fd.name.split(' ')[0])}</h1>
              <p class="sub">The VINC team has your sign-up. You will be able to step inside as soon as they approve it, usually within a day.</p>
              <a class="btn btn-primary" href="/advisor">See your status ${VG.icon.arrow}</a>
            </div>`;
          card.animate([{ opacity: 0, translate: '0 18px' }, { opacity: 1, translate: '0 0' }], { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)' });
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });
  }
})();
