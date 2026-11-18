// The soundscape, synthesised live: a deep rumble, slow water wash, distant whale calls, chimes and bubbles,
// lava growling and crackling nearby, and the diver's own breathing inside the helmet.
export class Sound {
  constructor() {
    this.ctx = null; this.on = true;
    this.nextWhale = 6; this.nextChime = 2; this.nextBubble = 1; this.nextCrackle = 0;
    this.helmet = -1; this.lavaLevel = -1;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    // the world is heard through the helmet (a low-pass when it is on); breathing is heard directly
    const master = (this.master = ctx.createGain()), hf = (this.hf = ctx.createBiquadFilter()), direct = (this.direct = ctx.createGain());
    master.gain.value = 0;
    master.gain.setTargetAtTime(0.85, ctx.currentTime, 1.5);
    hf.type = 'lowpass'; hf.frequency.value = 18000;
    master.connect(hf); hf.connect(ctx.destination); direct.connect(ctx.destination);
    // everything "distant" goes through a murky echo
    const delay = ctx.createDelay(1), fb = ctx.createGain(), damp = ctx.createBiquadFilter(), wet = (this.wet = ctx.createGain());
    delay.delayTime.value = 0.47; fb.gain.value = 0.55; damp.type = 'lowpass'; damp.frequency.value = 1400;
    wet.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(master); wet.connect(master);
    // brown noise bed
    const len = ctx.sampleRate * 6, nb = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = nb.getChannelData(ch); let v = 0;
      for (let i = 0; i < len; i++) { v = (v + (Math.random() * 2 - 1) * 0.02) / 1.02; d[i] = v * 3.5; }
      for (let i = 0; i < 4000; i++) { const k = i / 4000; d[i] = d[i] * k + d[len - 4000 + i] * (1 - k); }   // seamless loop
    }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; noise.loopEnd = (len - 4000) / ctx.sampleRate;
    const rumble = ctx.createBiquadFilter(); rumble.type = 'lowpass'; rumble.frequency.value = 130;
    const rg = ctx.createGain(); rg.gain.value = 0.9;
    noise.connect(rumble); rumble.connect(rg); rg.connect(master);
    const wash = ctx.createBiquadFilter(); wash.type = 'bandpass'; wash.frequency.value = 480; wash.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = 0.06;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 0.04;
    lfo.connect(lg); lg.connect(wg.gain); lfo.start();
    noise.connect(wash); wash.connect(wg); wg.connect(master);
    // lava: a growl that swells as you come close
    const growl = ctx.createBiquadFilter(); growl.type = 'bandpass'; growl.frequency.value = 75; growl.Q.value = 0.7;
    const lava = (this.lava = ctx.createGain()); lava.gain.value = 0;
    const tremor = ctx.createOscillator(), tg = ctx.createGain(); tremor.frequency.value = 0.9; tg.gain.value = 0.35;
    const shake = ctx.createGain(); shake.gain.value = 1; tremor.connect(tg); tg.connect(shake.gain); tremor.start();
    noise.connect(growl); growl.connect(shake); shake.connect(lava); lava.connect(master);
    noise.start();
    // white noise for breath and crackles
    const wl = ctx.sampleRate * 2, wb = (this.white = ctx.createBuffer(1, wl, ctx.sampleRate)), wd = wb.getChannelData(0);
    for (let i = 0; i < wl; i++) wd[i] = Math.random() * 2 - 1;
    // a soft drone that makes the place feel big
    for (const [fr, g] of [[55, 0.05], [82.4, 0.03], [110.3, 0.018]]) {
      const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = fr; og.gain.value = g;
      const l2 = ctx.createOscillator(), l2g = ctx.createGain(); l2.frequency.value = 0.03 + Math.random() * 0.05; l2g.gain.value = g * 0.6;
      l2.connect(l2g); l2g.connect(og.gain); l2.start(); o.connect(og); og.connect(master); o.start();
    }
  }

  toggle() {
    this.on = !this.on;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.on ? 0.85 : 0, this.ctx.currentTime, 0.15);
    this.direct.gain.setTargetAtTime(this.on ? 1 : 0, this.ctx.currentTime, 0.15);
  }

  voice(type, f0, f1, dur, gain, attack, vib, delay = 0, dest = this.wet) {
    const ctx = this.ctx, t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    if (vib) { const v = ctx.createOscillator(), vg = ctx.createGain(); v.frequency.value = 5; vg.gain.value = vib; v.connect(vg); vg.connect(o.frequency); v.start(t); v.stop(t + dur); }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // a shaped puff of filtered white noise
  burst(dur, ftype, f0, f1, q, peak, dest, attack = dur * 0.35) {
    const ctx = this.ctx, t = ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.white; s.loop = true;
    f.type = ftype; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + attack); g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }

  // kind 0 = breathe in through the regulator, 1 = breathe out with a stream of bubbles
  breath(kind) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) return;
    if (kind === 0) this.burst(1.9, 'bandpass', 620, 1500, 0.8, 0.11, this.direct);
    else {
      this.burst(2.1, 'lowpass', 950, 360, 0.5, 0.09, this.direct, 0.3);
      for (let i = 0; i < 10; i++) { const f = 170 + Math.random() * 260; this.voice('sine', f, f * 1.9, 0.07, 0.035, 0.008, 0, 0.2 + Math.random() * 1.5, this.direct); }
    }
  }

  // the kraken's call: a very low, slow groan that fills the water; `near` is 0 (far) .. 1 (right here)
  kraken(near) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) return;
    const g = 0.05 + 0.11 * near;
    this.voice('sine', 58, 36, 5.2, g, 1.6, 3);
    this.voice('triangle', 116, 74, 4.4, g * 0.35, 1.2, 5, 0.3);
    this.burst(4.6, 'lowpass', 230, 90, 0.7, g * 0.5, this.wet, 1.5);
  }

  // called every frame; only allocates when a new sound actually starts
  update(cam, surf, heat = 0, helmet = 0) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) return;
    const t = ctx.currentTime;
    const h = helmet > 0.5 ? 1 : 0;
    if (h !== this.helmet) { this.helmet = h; this.hf.frequency.setTargetAtTime(h ? 1700 : 18000, t, 0.3); }
    const lv = Math.round(Math.min(Math.max(heat, 0), 1) * 20) / 20;
    if (lv !== this.lavaLevel) { this.lavaLevel = lv; this.lava.gain.setTargetAtTime(lv * 2.2, t, 0.4); }
    if (heat > 0.08 && t > this.nextCrackle) {
      this.nextCrackle = t + (0.04 + Math.random() * 0.35) / heat;
      this.burst(0.03 + Math.random() * 0.05, 'highpass', 1500 + Math.random() * 2500, 1200, 0.7, 0.06 * heat * (0.4 + Math.random()), this.master, 0.004);
    }
    if (t > this.nextWhale) {
      this.nextWhale = t + 12 + Math.random() * 20;
      const f = 150 + Math.random() * 170, up = Math.random() < 0.6;
      this.voice('sine', f, f * (up ? 1.5 + Math.random() * 0.5 : 0.62), 2.4 + Math.random() * 1.8, 0.07, 0.7, 4);
      if (Math.random() < 0.5) this.voice('sine', f * 1.9, f * 1.3, 1.6, 0.03, 0.4, 6, 1.5);
    }
    if (t > this.nextChime) {
      this.nextChime = t + 2.5 + Math.random() * 6;
      const scale = [0, 3, 5, 7, 10, 12, 15, 17], n = scale[(Math.random() * scale.length) | 0];
      const f = 392 * Math.pow(2, n / 12) * (Math.random() < 0.3 ? 2 : 1);
      this.voice('sine', f, f * 0.995, 3.5, 0.018, 0.02, 0);
    }
    if (t > this.nextBubble) {
      this.nextBubble = t + 0.3 + Math.random() * 2.2;
      const f = 300 + Math.random() * 500, depth = Math.max(0.3, 1 - (surf - cam.y) / 80);
      this.voice('sine', f, f * 2.6, 0.09 + Math.random() * 0.06, 0.02 * depth, 0.01, 0);
    }
  }
}
