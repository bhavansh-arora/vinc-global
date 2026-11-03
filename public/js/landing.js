(function () {
  'use strict';
  const VG = window.VG;

  const reduce = () => VG.reducedMotion();
  const finePointer = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
  const onceVisible = (els, fn, threshold = 0.35) => {
    const ob = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { ob.unobserve(en.target); fn(en.target); } }), { threshold });
    els.forEach((el) => ob.observe(el));
  };

  // Section 2: the cards unfold in 3D, tilt toward the cursor with a moving sheen, a light runs around
  // the border once as they arrive, and the figures count up.
  function sectionPlatforms() {
    const cards = [...document.querySelectorAll('.platform')];
    onceVisible(document.querySelectorAll('.facts [data-count]'), (el) => {
      const to = Number(el.dataset.count), pre = el.dataset.prefix || '';
      setTimeout(() => VG.countUp(el, to, { dur: 1600, format: (v) => pre + Math.round(v).toLocaleString('en-IN') }), 450);
    }, 0.6);
    if (reduce()) return;
    onceVisible(cards, (card) => {
      setTimeout(() => card.classList.add('glint'), 900);
      setTimeout(() => card.classList.remove('glint'), 4500);
    }, 0.3);
    if (!finePointer()) return;
    cards.forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
        card.classList.add('tilting');
        card.style.setProperty('--ry', (px * 7).toFixed(2) + 'deg');
        card.style.setProperty('--rx', (-py * 5).toFixed(2) + 'deg');
        card.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
      });
      card.addEventListener('pointerleave', () => {
        card.classList.remove('tilting');
        ['--rx', '--ry', '--mx', '--my'].forEach((k) => card.style.removeProperty(k));
      });
    });
  }

  // Section 4: the cards cascade in out of a blur, each icon draws itself line by line, and a spotlight
  // follows the cursor across the whole grid, lighting the borders of neighbouring cards too.
  function sectionFeatures() {
    const grid = document.querySelector('.features');
    if (!grid || reduce()) return;
    const cards = [...grid.querySelectorAll('.feature')];
    cards.forEach((c) => {
      c.classList.add('armed');
      c.querySelectorAll('.fi svg path, .fi svg circle, .fi svg rect, .fi svg line, .fi svg polyline').forEach((el) => el.setAttribute('pathLength', '1'));
    });
    onceVisible(cards, (c) => {
      c.classList.add('draw');
      const delay = parseInt(getComputedStyle(c).getPropertyValue('--rd'), 10) || 0;
      setTimeout(() => c.classList.add('drawn'), delay + 1900);
    }, 0.4);
    if (!finePointer()) return;
    grid.addEventListener('pointermove', (e) => {
      grid.classList.add('lit');
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        c.style.setProperty('--mx', (e.clientX - r.left).toFixed(0) + 'px');
        c.style.setProperty('--my', (e.clientY - r.top).toFixed(0) + 'px');
      }
    });
    grid.addEventListener('pointerleave', () => grid.classList.remove('lit'));
  }

  // Section 5: a comet travels along the onboarding line and lights each step as it passes.
  // It plays every time the section scrolls into view.
  function sectionSteps() {
    const wrap = document.getElementById('steps-wrap');
    const list = document.getElementById('steps');
    if (!wrap || !list) return;
    const items = [...list.children];
    const comet = wrap.querySelector('.comet');
    if (reduce()) { list.style.setProperty('--sp', 1); return; }
    list.classList.add('armed');
    const DUR = 2600;
    let timers = [], playing = false;
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const reset = () => {
      clear(); playing = false;
      items.forEach((li) => li.classList.remove('lit'));
      list.classList.remove('done');
      list.style.setProperty('--line-dur', '0s');
      list.style.setProperty('--sp', 0);
    };
    const play = () => {
      if (playing) return;
      reset();
      playing = true;
      const wide = matchMedia('(min-width: 861px)').matches;
      if (wide) {
        void getComputedStyle(list, '::before').transform;   // apply the reset before starting again
        requestAnimationFrame(() => {
          list.style.setProperty('--line-dur', DUR + 'ms');
          list.style.setProperty('--sp', 1);
          comet.animate([{ left: '6%', opacity: 0 }, { opacity: 1, offset: 0.05 }, { left: '94%', opacity: 1, offset: 0.95 }, { left: '94%', opacity: 0 }], { duration: DUR, easing: 'linear' });
        });
        items.forEach((li, i) => {
          const centre = ((i + 0.5) / items.length) * 100;
          timers.push(setTimeout(() => li.classList.add('lit'), ((centre - 6) / 88) * DUR));
        });
      } else {
        list.style.setProperty('--sp', 1);
        items.forEach((li, i) => timers.push(setTimeout(() => li.classList.add('lit'), 200 + i * 420)));
      }
      timers.push(setTimeout(() => { list.classList.add('done'); playing = false; }, DUR + 500));
    };
    const ob = new IntersectionObserver(([en]) => {
      if (en.isIntersecting && en.intersectionRatio >= 0.55) play();
      else if (!en.isIntersecting) reset();
    }, { threshold: [0, 0.55] });
    ob.observe(wrap);
  }

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
    }), { threshold: 0.4 });
    document.querySelectorAll('.count').forEach((el) => io.observe(el));

    sectionPlatforms();
    sectionFeatures();
    sectionSteps();

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
