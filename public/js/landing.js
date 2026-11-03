(function () {
  'use strict';
  const VG = window.VG;

  document.addEventListener('DOMContentLoaded', () => {
    // Mobile menu
    const menuBtn = document.getElementById('menu-btn');
    const nav = document.getElementById('nav');
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') !== 'true';
      menuBtn.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('open', open);
    });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) { menuBtn.setAttribute('aria-expanded', 'false'); nav.classList.remove('open'); } });

    // Header shadow and reading progress
    const header = document.querySelector('.site-header');
    const bar = document.getElementById('progress-bar');
    const timeline = document.getElementById('timeline');
    const onScroll = () => {
      const y = window.scrollY;
      header.classList.toggle('scrolled', y > 8);
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
      if (timeline) {
        const r = timeline.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (innerHeight * 0.75 - r.top) / r.height));
        timeline.style.setProperty('--tp', p.toFixed(3));
      }
    };
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    VG.bubbles(document.getElementById('bg-canvas'));

    // Orbit: three planets circle the core; they slow to a stop while the pointer is over the orbit.
    const orbit = document.getElementById('orbit');
    const planets = [...orbit.querySelectorAll('.planet')];
    let angle = 0, speed = 0.0022, target = 0.0022;
    orbit.addEventListener('pointerenter', () => { target = 0; });
    orbit.addEventListener('pointerleave', () => { target = 0.0022; });
    const place = () => {
      const size = orbit.clientWidth;
      planets.forEach((p) => {
        const a = angle + Number(p.dataset.orbit);
        const r = size * Number(p.dataset.radius);
        p.style.translate = `calc(-50% + ${Math.cos(a) * r}px) calc(-50% + ${Math.sin(a) * r * 0.92}px)`;
      });
    };
    const spin = () => {
      speed += (target - speed) * 0.05;
      angle += speed;
      place();
      requestAnimationFrame(spin);
    };
    if (VG.reducedMotion()) place(); else requestAnimationFrame(spin);

    // Count-up stats, the onboarding line, when they come into view
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      if (en.target.classList.contains('count')) VG.countUp(en.target, Number(en.target.dataset.to), { dur: 1400 });
      if (en.target.id === 'steps') setTimeout(() => en.target.style.setProperty('--sp', 1), 300);
    }), { threshold: 0.4 });
    document.querySelectorAll('.count').forEach((el) => io.observe(el));
    io.observe(document.getElementById('steps'));

    // Request a VINC ID
    const rq = document.getElementById('request-form');
    if (rq) {
      const opened = Date.now();
      let role = 'advisor';
      VG.seg(document.getElementById('rq-role'), (v) => { role = v; });
      rq.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = document.getElementById('rq-err');
        err.textContent = '';
        const f = Object.fromEntries(new FormData(rq));
        if (!f.name.trim()) { err.textContent = 'Please enter your name.'; return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) { err.textContent = 'Please enter a valid email address.'; return; }
        await VG.busy(rq.querySelector('[type=submit]'), async () => {
          try {
            await VG.api('/api/auth/request-id', { body: { ...f, role, elapsed: Date.now() - opened } });
            const card = rq.parentElement;
            card.innerHTML = `<div class="request-done"><svg class="tick" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45"/><path d="M30 52l13 13 27-29"/></svg>
              <p class="label">Request received</p><h3 style="font-size:1.6rem">Thank you, ${VG.esc(f.name.trim().split(/\s+/)[0])}</h3>
              <p class="muted">We've sent a confirmation to <b>${VG.esc(f.email.trim())}</b>. Once the team approves your request, your VINC ID will arrive in the same inbox.</p></div>`;
            card.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }], { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)' });
          } catch (ex) { err.textContent = ex.message; }
        });
      });
    }

    // Public news
    VG.api('/api/auth/news').then((items) => {
      if (!items || !items.length) return;
      document.getElementById('news').hidden = false;
      document.getElementById('nav-news').hidden = false;
      document.getElementById('news-list').innerHTML = items.map((n, i) => `
        <article class="news-item reveal ${n.pinned ? 'pinned' : ''}" style="--rd:${i * 70}ms">
          <div class="nm">${n.tag ? `<span class="chip warn">${VG.esc(n.tag)}</span>` : ''}<span>${VG.date(n.created_at)}</span>${n.pinned ? '<span class="chip teal">Pinned</span>' : ''}</div>
          <h3>${VG.esc(n.title)}</h3><p>${VG.esc(n.body)}</p>
        </article>`).join('');
      VG.reveal(document.getElementById('news'));
    }).catch(() => { /* news is optional */ });

    // If already signed in, point the header button at the right dashboard.
    VG.loadMe().then(({ user }) => {
      if (!user) return;
      const dest = user.role === 'admin' ? '/admin' : '/advisor';
      document.querySelectorAll('a[href="/login"]').forEach((a) => { a.href = dest; if (a.closest('.nav-auth')) a.textContent = 'Open portal'; });
    }).catch(() => {});
  });
})();
