/* "Joining VINC": little people walk up in a queue and step through the glowing VINC doorway.
   Used as the welcome sequence right after login, and on the waiting-for-approval screen,
   where you stand at a closed door that opens when the team approves you. */
(function () {
  'use strict';
  const VG = window.VG;
  const COLORS = ['var(--teal)', 'var(--plum)', 'var(--olive)', 'var(--rust)', 'var(--teal-2)', 'var(--amber-ink)'];
  const SKIN = ['#E8B98F', '#C68E62', '#8D5A3B', '#F1C9A5', '#A86E4A', '#D9A27A'];
  const HAIR = ['#2B1A10', '#4A2E1C', '#1B130D', '#6B4226', '#3A2416'];
  const pick = (arr, i) => arr[i % arr.length];

  function personSvg(i, you) {
    const hair = pick(HAIR, i * 3 + 1);
    const long = i % 3 === 1;
    return `<svg class="pp-svg" viewBox="0 0 40 72" aria-hidden="true">
      <g class="leg l"><rect x="13" y="44" width="6.5" height="24" rx="3.2"/></g>
      <g class="leg r"><rect x="20.5" y="44" width="6.5" height="24" rx="3.2"/></g>
      <g class="arm l"><rect x="5" y="25" width="5.5" height="19" rx="2.7"/></g>
      <rect class="torso" x="9" y="22" width="22" height="27" rx="10"/>
      <g class="arm r"><rect x="29.5" y="25" width="5.5" height="19" rx="2.7"/></g>
      ${long ? `<path d="M10.5 14 q0 -11 9.5 -11 q9.5 0 9.5 11 v8 h-4 v-8 h-11 v8 h-4z" fill="${hair}"/>` : ''}
      <circle cx="20" cy="12.5" r="8.6" fill="${pick(SKIN, i * 5 + 2)}"/>
      <path d="M11.4 11.5 q1 -8.5 8.6 -8.5 q7.6 0 8.6 8.5 q-4 -3.4 -8.6 -3.2 q-4.6 -.2 -8.6 3.2z" fill="${hair}"/>
      ${you ? '<circle cx="20" cy="35" r="3.2" fill="var(--paper)" opacity=".9"/>' : ''}
    </svg>`;
  }

  /**
   * opts: { others, you: { label } | null, waitAtDoor: n (people left standing in line), mode: 'parade' | 'waiting',
   *         onEnter(fig), onYou() }
   */
  VG.queueScene = function (host, opts = {}) {
    const o = Object.assign({ others: 6, you: null, waitAtDoor: 0, mode: 'parade', speed: 460, stepPause: 90 }, opts);
    host.classList.add('qs');
    host.innerHTML = `<div class="qs-floor"></div><div class="qs-spill"></div>
      <div class="qs-door ${o.mode === 'waiting' ? '' : 'open'}">
        <div class="qs-sign"><img src="/img/vinc-mark.svg" alt=""><span>VINC</span></div>
        <div class="qs-inside"><span class="qs-rays"></span></div>
        <div class="qs-panel"><i class="knob"></i>${o.mode === 'waiting' ? `<span class="qs-wait">${VG.icon.clock}</span>` : ''}</div>
      </div>`;
    const door = host.querySelector('.qs-door');
    const figs = [];
    let W = host.clientWidth, doorX = 0, gap = 48, raf = 0, last = 0, alive = true;
    const layout = () => {
      W = host.clientWidth;
      doorX = Math.round(W * (W < 520 ? 0.78 : 0.7));
      gap = W < 520 ? 38 : 50;
      door.style.left = doorX + 'px';
    };
    layout();
    const slotX = (k) => doorX - (W < 520 ? 80 : 96) - k * gap;

    const total = o.others + (o.you ? 1 : 0);
    for (let i = 0; i < total; i++) {
      const isYou = o.you && i === total - 1;
      const el = document.createElement('div');
      el.className = 'pp' + (isYou ? ' you' : '');
      el.style.setProperty('--c', isYou ? 'var(--amber)' : pick(COLORS, i));
      el.style.setProperty('--d', `${(i % 4) * -0.11}s`);
      el.innerHTML = `<span class="pp-shadow"></span>${personSvg(i + 2, isYou)}${isYou ? `<span class="pp-tag">${VG.esc(o.you.label || 'You')}</span>` : ''}`;
      host.appendChild(el);
      const startX = o.mode === 'waiting' ? slotX(i) : -40 - i * (gap + 8);
      figs.push({ el, x: startX, target: o.mode === 'waiting' ? slotX(i) : slotX(i), you: !!isYou, state: 'walk', enterDone: null });
    }
    let queue = figs.slice();

    const draw = (f) => { f.el.style.transform = `translate3d(${f.x.toFixed(1)}px,0,0)`; };
    figs.forEach(draw);

    const burst = (n, spread) => {
      for (let k = 0; k < n; k++) {
        const b = document.createElement('i');
        b.className = 'qs-bit';
        b.style.left = doorX + 'px';
        b.style.background = pick(['var(--amber)', 'var(--teal-2)', 'var(--plum)', 'var(--olive)', 'var(--band-accent)'], k);
        if (k % 3 === 0) b.style.borderRadius = '50%';
        host.appendChild(b);
        const ang = (-Math.PI / 2) + (Math.random() - 0.5) * spread;
        const dist = 50 + Math.random() * (spread > 2 ? 140 : 60);
        b.animate([
          { transform: 'translate(-50%,0) scale(.4) rotate(0deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), ${Math.sin(ang) * dist}px) scale(1) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.6 },
          { transform: `translate(calc(-50% + ${Math.cos(ang) * dist * 1.2}px), ${Math.sin(ang) * dist + 60}px) scale(.8) rotate(${Math.random() * 720}deg)`, opacity: 0 },
        ], { duration: 1100 + Math.random() * 600, easing: 'cubic-bezier(.22,1,.36,1)' }).onfinish = () => b.remove();
      }
    };

    const enter = (f) => new Promise((resolve) => {
      f.state = 'entering';
      f.el.classList.remove('walking');
      door.classList.remove('pulse'); void door.offsetWidth; door.classList.add('pulse');
      burst(f.you ? 4 : 5, 1.2);
      const a = f.el.animate([
        { opacity: 1, scale: '1', translate: '0 0', filter: 'brightness(1)' },
        { opacity: 0, scale: '.55', translate: '0 -14px', filter: 'brightness(1.8)' },
      ], { duration: 440, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
      a.onfinish = () => { f.state = 'in'; o.onEnter && o.onEnter(f); resolve(); };
    });

    const tick = (t) => {
      if (!alive) return;
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      for (const f of figs) {
        if (f.state !== 'walk') continue;
        const dx = f.target - f.x;
        const step = o.speed * dt;
        if (Math.abs(dx) <= step) {
          f.x = f.target;
          f.el.classList.remove('walking');
          if (f.arrive) { const cb = f.arrive; f.arrive = null; cb(); }
        } else {
          f.x += Math.sign(dx) * step;
          f.el.classList.add('walking');
        }
        draw(f);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const walkTo = (f, x) => new Promise((resolve) => { f.target = x; f.state = 'walk'; f.arrive = resolve; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Front of the queue walks through the door; everyone behind shuffles up one place.
    async function advance() {
      const f = queue.shift();
      queue.forEach((g, k) => { g.target = slotX(k); });
      await walkTo(f, doorX);
      const entering = enter(f);
      if (f.you) { await entering; o.onYou && o.onYou(); } else await sleep(200);
    }

    async function run() {
      if (!figs.length) return;
      // Wait until the front person reaches the head of the queue.
      await new Promise((r) => { figs[0].arrive = r; });
      while (alive && queue.length > o.waitAtDoor) {
        await advance();
        await sleep(o.stepPause);
      }
      // Anyone still waiting gets a little hourglass.
      queue.forEach((g, k) => { if (k === 0) g.el.insertAdjacentHTML('beforeend', '<span class="pp-tag wait">Waiting</span>'); });
    }

    const resize = () => { layout(); queue.forEach((g, k) => { g.target = slotX(k); if (g.state !== 'walk') { g.state = 'walk'; } }); };
    window.addEventListener('resize', resize);

    return {
      done: o.mode === 'parade' ? run() : Promise.resolve(),
      // Waiting mode: the door opens and you walk in.
      async admit() {
        door.classList.add('open');
        door.querySelector('.qs-wait') && door.querySelector('.qs-wait').remove();
        await sleep(650);
        burst(10, 1.6);
        while (queue.length) await advance();
        burst(26, Math.PI * 1.6);
      },
      celebrate() { burst(28, Math.PI * 1.7); },
      destroy() { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); },
    };
  };

  /** Full-screen welcome after login. Resolves when it has finished (or was skipped). */
  VG.welcomeIntro = function ({ label, title, doneTitle, sub, doneSub, others = 6, you = null, waitAtDoor = 0, extra = '' } = {}) {
    return new Promise((resolve) => {
      if (VG.reducedMotion()) return resolve();
      const ov = document.createElement('div');
      ov.className = 'intro';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-label', 'Welcome');
      ov.innerHTML = `<canvas class="intro-bg" aria-hidden="true"></canvas>
        <div class="intro-box">
          <p class="label">${VG.esc(label)}</p>
          <h1 class="intro-title">${VG.esc(title)}</h1>
          <p class="intro-sub">${VG.esc(sub)}</p>
          <div class="intro-scene"></div>
          <div class="intro-extra">${extra}</div>
        </div>
        <button class="btn btn-soft btn-sm intro-skip" type="button">Skip ${VG.icon.arrow}</button>`;
      document.body.appendChild(ov);
      document.documentElement.style.overflow = 'hidden';
      VG.bubbles(ov.querySelector('.intro-bg'), { density: 0.6 });
      const titleEl = ov.querySelector('.intro-title'), subEl = ov.querySelector('.intro-sub');
      let finished = false;
      const swap = (el, text) => {
        el.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 -10px' }], { duration: 220, easing: 'ease-in' }).onfinish = () => {
          el.textContent = text;
          el.animate([{ opacity: 0, translate: '0 12px', filter: 'blur(4px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }], { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)' });
        };
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        scene.destroy();
        const a = ov.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '1.06' }], { duration: 520, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
        a.onfinish = () => { ov.remove(); document.documentElement.style.overflow = ''; resolve(); };
      };
      const end = () => {
        swap(titleEl, doneTitle);
        if (doneSub) swap(subEl, doneSub);
        ov.querySelector('.intro-extra').classList.add('show');
        setTimeout(finish, 2100);
      };
      const scene = VG.queueScene(ov.querySelector('.intro-scene'), {
        others, you, waitAtDoor,
        onYou: () => scene.celebrate(),
      });
      scene.done.then(() => { if (!finished) { if (!you) scene.celebrate(); end(); } });
      ov.querySelector('.intro-skip').addEventListener('click', finish);
      ov.querySelector('.intro-extra').addEventListener('click', (e) => { if (e.target.closest('a')) finish(); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(); });
      ov.tabIndex = -1;
      ov.focus({ preventScroll: true });
    });
  };

  /** Should this page load play the post-login welcome? (Set by the log-in page, used once.) */
  VG.takeIntroFlag = function () {
    try { const v = sessionStorage.getItem('vg:intro'); sessionStorage.removeItem('vg:intro'); return v === '1'; } catch { return false; }
  };

  /** Dashboard content rises into place, card by card. */
  VG.riseIn = function (root) {
    if (!root || VG.reducedMotion()) return;
    [...root.children].forEach((el, i) => el.animate(
      [{ opacity: 0, translate: '0 28px', scale: '.98' }, { opacity: 1, translate: '0 0', scale: '1' }],
      { duration: 700, delay: i * 90, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' },
    ));
  };
})();
