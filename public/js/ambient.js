/* Calm background ambience, generated live with the Web Audio API (no audio files, nothing to license).
   Slow major-seventh pads drift from chord to chord under a soft reverb, with the odd high bell
   and a faint breath of air. Browsers only allow sound after a click or key press, so it starts
   on the first gesture when the visitor has turned it on before. */
(function () {
  'use strict';
  const KEY = 'vg:sound';
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch { /* ignore */ } },
  };
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // Cmaj9 → Am9 → Fmaj9 → G6/9: warm, unresolved, never tense.
  const CHORDS = [
    [48, 55, 59, 62, 64],
    [45, 52, 55, 59, 60],
    [41, 48, 52, 55, 57],
    [43, 50, 57, 59, 64],
  ];
  const BELLS = [72, 74, 76, 79, 81, 84, 86, 88];
  const CHORD_SECONDS = 10;

  class Ambient {
    constructor() { this.ctx = null; this.playing = false; this.timer = null; this.listeners = new Set(); }

    build() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.ratio.value = 3;
      this.master.connect(comp).connect(ctx.destination);

      // Reverb from a generated impulse: stereo noise with a long, soft tail.
      const len = ctx.sampleRate * 5;
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = ir;
      const wet = ctx.createGain(); wet.gain.value = 0.85;
      this.reverb.connect(wet).connect(this.master);
      this.dry = ctx.createGain(); this.dry.gain.value = 0.55;
      this.dry.connect(this.master);

      // A very quiet breath of filtered brown noise that swells and settles.
      const nb = ctx.createBuffer(1, ctx.sampleRate * 6, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      let last = 0;
      for (let i = 0; i < nd.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; nd[i] = last * 3.2; }
      const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 420;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.03;
      lfo.connect(lfoAmt).connect(ng.gain);
      noise.connect(nf).connect(ng);
      ng.connect(this.dry); ng.connect(this.reverb);
      noise.start(); lfo.start();

      this.chordIndex = 0;
      this.nextChord = ctx.currentTime + 0.1;
      this.nextBell = ctx.currentTime + 4;
      return true;
    }

    pad(notes, t) {
      const ctx = this.ctx;
      const attack = 4.5, hold = CHORD_SECONDS - 2, release = 6;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0, t);
      bus.gain.linearRampToValueAtTime(1, t + attack);
      bus.gain.setValueAtTime(1, t + hold);
      bus.gain.linearRampToValueAtTime(0, t + hold + release);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(700, t);
      filter.frequency.linearRampToValueAtTime(1500, t + attack + 2);
      filter.frequency.linearRampToValueAtTime(800, t + hold + release);
      filter.Q.value = 0.4;
      bus.connect(filter);
      filter.connect(this.dry); filter.connect(this.reverb);
      const end = t + hold + release + 0.2;
      const voice = (freq, type, level, detune) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
        const g = ctx.createGain(); g.gain.value = level;
        o.connect(g).connect(bus); o.start(t); o.stop(end);
      };
      notes.forEach((n, i) => {
        const lvl = i === 0 ? 0.05 : 0.032;
        voice(midi(n), 'sine', lvl, -4);
        voice(midi(n), 'triangle', lvl * 0.45, 5);
      });
      voice(midi(notes[0] - 12), 'sine', 0.05, 0); // a soft root an octave down
    }

    bell(t) {
      const ctx = this.ctx;
      const f = midi(BELLS[Math.floor(Math.random() * BELLS.length)]);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.03, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 5);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = Math.random() * 1.2 - 0.6; g.connect(pan); pan.connect(this.reverb); pan.connect(this.dry); }
      else { g.connect(this.reverb); }
      [[1, 1], [2.01, 0.25], [3.02, 0.08]].forEach(([mul, lvl]) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * mul;
        const og = ctx.createGain(); og.gain.value = lvl;
        o.connect(og).connect(g); o.start(t); o.stop(t + 5.2);
      });
    }

    tick() {
      const now = this.ctx.currentTime;
      while (this.nextChord < now + 2) {
        this.pad(CHORDS[this.chordIndex % CHORDS.length], this.nextChord);
        this.chordIndex++;
        this.nextChord += CHORD_SECONDS;
      }
      while (this.nextBell < now + 2) {
        this.bell(this.nextBell);
        this.nextBell += 2.6 + Math.random() * 5;
      }
    }

    async start() {
      if (!this.ctx && !this.build()) return false;
      try { await this.ctx.resume(); } catch { return false; }
      if (this.ctx.state !== 'running') return false;
      const now = this.ctx.currentTime;
      if (this.nextChord < now) this.nextChord = now + 0.1;
      if (this.nextBell < now) this.nextBell = now + 3;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0.6, now + 3.5);
      clearInterval(this.timer);
      this.tick();
      this.timer = setInterval(() => this.tick(), 1000);
      this.playing = true;
      this.emit();
      return true;
    }

    stop() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + 1.4);
      this.playing = false;
      this.emit();
      setTimeout(() => { if (!this.playing) { clearInterval(this.timer); this.ctx.suspend(); } }, 1500);
    }

    async toggle() {
      if (this.playing) { this.stop(); store.set('off'); }
      else if (await this.start()) store.set('on');
      return this.playing;
    }

    onChange(fn) { this.listeners.add(fn); }
    emit() { this.listeners.forEach((fn) => fn(this.playing)); }
  }

  const ambient = new Ambient();
  window.VGAmbient = ambient;

  function bindButtons() {
    const btns = document.querySelectorAll('[data-sound-toggle]');
    const paint = (on) => btns.forEach((b) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Turn the calm background sound off' : 'Play calm background sound';
    });
    btns.forEach((b) => b.addEventListener('click', () => { ambient.toggle(); hideNudge(); }));
    ambient.onChange(paint);
    paint(false);
  }

  let nudge = null;
  function hideNudge() { if (nudge) { nudge.remove(); nudge = null; } }
  function showNudge() {
    if (!document.querySelector('[data-sound-toggle]')) return;
    // Once per browser session, and it tucks itself away after a few seconds.
    try { if (sessionStorage.getItem('vg:nudged')) return; sessionStorage.setItem('vg:nudged', '1'); } catch { /* ignore */ }
    nudge = document.createElement('div');
    if (document.querySelector('.app')) nudge.classList.add('top');
    setTimeout(hideNudge, 14000);
    nudge.className = 'sound-nudge';
    nudge.setAttribute('role', 'status');
    nudge.innerHTML = `<span class="wave" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4"/></svg></span>
      <p><b>Calm ambience</b><br><span class="muted">A soft background sound while you look around.</span></p>
      <button class="btn btn-amber btn-sm" type="button">Play</button>
      <button class="x" type="button" aria-label="No thanks"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    nudge.querySelector('.btn').addEventListener('click', () => { ambient.toggle(); hideNudge(); });
    nudge.querySelector('.x').addEventListener('click', () => { store.set('off'); hideNudge(); });
    document.body.appendChild(nudge);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindButtons();
    const pref = store.get();
    if (pref === 'on') {
      // Resume on the first gesture: browsers block sound until the visitor interacts.
      const go = (e) => {
        if (e.target.closest && e.target.closest('[data-sound-toggle]')) return; // the button handles itself
        ambient.start();
        ['pointerdown', 'keydown'].forEach((t) => window.removeEventListener(t, go, true));
      };
      ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, go, true));
    } else if (pref === null) {
      setTimeout(showNudge, 1800);
    }
  });
})();
