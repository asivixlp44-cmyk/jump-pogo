// Procedural soundtrack and sound effects (Web Audio, no asset files).
// "Rainbow Bounce": an original 126 BPM future-bass / tropical-house track in C.
// Sidechain-pumped supersaw chords (Fmaj7 - G6 - Em7 - Am7), a bouncy sub bass, a vocal-chop
// style lead through the echo, marimba arpeggios, four-on-the-floor kick with claps, offbeat
// open hats and shakers, snare-roll + white-noise risers into each drop and an impact on the one.
// 32 bars: intro, build, drop, break, build, drop 2, looping.

let ctx = null, master, musicBus, musicOut, duckFilter, sfxBus, reverb, delay, ambGain, pump;
let noiseBuf = null;
let musicOn = false, schedTimer = null, step = 0, nextTime = 0, intensity = 0, ducked = false;
const settings = { music: 0.6, sfx: 0.8, master: 1 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('jpg_audio') || '{}')); } catch (e) { /* defaults */ }

const BPM = 126, STEP = 60 / BPM / 4;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// One chord per bar: Fmaj7, G6, Em7, Am7 (bass root, then the voicing in MIDI)
const CHORDS = [
    { root: 41, notes: [57, 60, 64, 65] },
    { root: 43, notes: [59, 62, 64, 67] },
    { root: 40, notes: [55, 59, 62, 64] },
    { root: 45, notes: [57, 60, 64, 67] },
];
// Vocal-chop lead, one phrase per chord: [step, midi, length in steps]
const CHOPS_A = [
    [[0, 72, 2], [3, 74, 2], [6, 76, 1], [8, 76, 2], [10, 74, 1], [12, 72, 2], [14, 69, 2]],
    [[0, 74, 2], [3, 76, 2], [6, 79, 3], [10, 76, 2], [12, 74, 3]],
    [[0, 71, 2], [3, 72, 2], [6, 74, 1], [8, 76, 3], [12, 74, 2], [14, 72, 2]],
    [[0, 72, 3], [4, 71, 2], [6, 69, 4], [12, 67, 2], [14, 69, 2]],
];
const CHOPS_B = [
    [[0, 77, 2], [3, 76, 2], [6, 72, 2], [8, 76, 2], [10, 77, 2], [12, 79, 4]],
    [[0, 79, 2], [3, 81, 2], [6, 79, 2], [8, 76, 3], [12, 74, 2], [14, 76, 2]],
    [[0, 76, 2], [3, 74, 2], [6, 71, 2], [8, 72, 2], [10, 74, 2], [12, 76, 4]],
    [[0, 76, 2], [2, 79, 2], [4, 81, 4], [10, 79, 2], [12, 76, 4]],
];
// Syncopated tropical rhythm for the chord stabs and the bass in the drops
const STABS = [0, 3, 6, 8, 11, 14];
// Song map: 32 bars
const SECTION = (bar) => {
    const b = bar % 32;
    if (b < 4) return 'intro';
    if (b < 8) return 'build';
    if (b < 16) return 'drop';
    if (b < 20) return 'break';
    if (b < 24) return 'build';
    return 'drop2';
};

export function initAudio() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    master = ctx.createGain(); master.gain.value = 0.9;
    comp.connect(master).connect(ctx.destination);
    // Music: everything -> musicBus -> duck lowpass (menus) -> volume -> compressor
    musicBus = ctx.createGain();
    duckFilter = ctx.createBiquadFilter(); duckFilter.type = 'lowpass'; duckFilter.frequency.value = 20000; duckFilter.Q.value = 0.5;
    musicOut = ctx.createGain();
    musicBus.connect(duckFilter).connect(musicOut).connect(comp);
    sfxBus = ctx.createGain(); sfxBus.connect(comp);
    // Sidechain "pump": chords, pads and bass duck under every kick
    pump = ctx.createGain(); pump.connect(musicBus);
    applyVolumes();

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Bright hall reverb (generated impulse) and a dotted-eighth echo for the chops
    reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.6, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
        const ch = ir.getChannelData(c);
        for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    reverb.buffer = ir;
    const revGain = ctx.createGain(); revGain.gain.value = 0.32;
    reverb.connect(revGain).connect(musicBus);
    delay = ctx.createDelay(1);
    delay.delayTime.value = STEP * 3;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const dlf = ctx.createBiquadFilter(); dlf.type = 'highpass'; dlf.frequency.value = 500;
    const dlGain = ctx.createGain(); dlGain.gain.value = 0.3;
    delay.connect(dlf).connect(fb).connect(delay);
    dlf.connect(dlGain).connect(musicBus);

    startWind();
    document.addEventListener('visibilitychange', () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend(); else ctx.resume();
    });
}

function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const m = settings.master ?? 1;
    musicOut.gain.setTargetAtTime(settings.music * 0.5 * m * (ducked ? 0.6 : 1), t, 0.08);
    sfxBus.gain.setTargetAtTime(settings.sfx * m, t, 0.05);
    if (ambGain) ambGain.gain.setTargetAtTime(settings.sfx * 0.05 * m, t, 0.2);
}
export function getVolumes() { return { ...settings }; }
export function setVolume(kind, v) {
    settings[kind] = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('jpg_audio', JSON.stringify(settings)); } catch (e) { /* ignore */ }
    applyVolumes();
}
// Menus open: the music goes muffled and a little quieter, like it's behind a door
export function setMusicDuck(on) {
    if (!ctx || on === ducked) return;
    ducked = on;
    duckFilter.frequency.setTargetAtTime(on ? 900 : 20000, ctx.currentTime, 0.12);
    applyVolumes();
}
// 0 in the lobby, 1 up on the stairs: an extra sparkle arp layer in the drops
export function setMusicIntensity(v) { intensity = v; }

// ----- instruments -----
function env(g, t, a, peak, d, sustain, r, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d);
    if (end) { g.gain.setValueAtTime(Math.max(0.0001, sustain), end); g.gain.exponentialRampToValueAtTime(0.0001, end + r); }
}
function noise(t, dur, type, freq, q, gain, out) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out || musicBus);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
    return g;
}
// Kick: punchy pitch drop plus a click, and it pumps the sidechain
function kick(t, gain) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
    g.gain.setValueAtTime(gain || 0.85, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.4);
    noise(t, 0.012, 'highpass', 3000, 0.7, 0.18, musicBus);
    pump.gain.cancelScheduledValues(t);
    pump.gain.setValueAtTime(0.22, t);
    pump.gain.linearRampToValueAtTime(1, t + STEP * 3.2);
}
function clap(t, gain) {
    gain = gain || 0.2;
    for (let i = 0; i < 3; i++) noise(t + i * 0.009, 0.08, 'bandpass', 1500, 1.1, gain, musicBus);
    noise(t, 0.3, 'bandpass', 1800, 0.9, gain * 0.5, reverb);
}
function hat(t, open, gain) { noise(t, open ? 0.14 : 0.03, 'highpass', open ? 7000 : 9000, 0.7, gain || (open ? 0.07 : 0.035), musicBus); }
function shaker(t, gain) { noise(t, 0.045, 'bandpass', 6500, 1.2, gain, musicBus); }
function snare(t, gain) { noise(t, 0.09, 'bandpass', 2200, 0.8, gain, musicBus); }
// Supersaw stab: three detuned saws per note through a plucky lowpass, into the pump
function supersaw(t, notes, dur, gain, cutoff) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(cutoff * 2.2, t); f.frequency.exponentialRampToValueAtTime(cutoff, t + dur * 0.6);
    env(g, t, 0.006, gain, dur * 0.5, gain * 0.55, 0.08, t + dur);
    f.connect(g); g.connect(pump); g.connect(reverb);
    for (const n of notes) for (const det of [-14, 0, 14]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(f); o.start(t); o.stop(t + dur + 0.12);
    }
}
// Warm pad: slow attack detuned saws behind a closed filter
function pad(t, notes, dur, gain, cutoff) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.Q.value = 0.7; f.frequency.value = cutoff;
    env(g, t, dur * 0.25, gain, dur * 0.2, gain * 0.8, 0.3, t + dur);
    f.connect(g); g.connect(pump); g.connect(reverb);
    for (const n of notes) for (const det of [-8, 8]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
        o.connect(f); o.start(t); o.stop(t + dur + 0.35);
    }
}
// Sub bass with a touch of growl, also pumped
function bass(t, n, dur, gain) {
    const g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 520; f.Q.value = 2;
    env(g, t, 0.005, gain || 0.32, dur * 0.6, (gain || 0.32) * 0.7, 0.05, t + dur);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(n);
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = midi(n); const g2 = ctx.createGain(); g2.gain.value = 0.18;
    o.connect(g); o2.connect(g2).connect(f).connect(g); g.connect(pump);
    o.start(t); o.stop(t + dur + 0.1); o2.start(t); o2.stop(t + dur + 0.1);
}
// Vocal chop: saw + square through two formant bandpasses, sliding up into the note
function chop(t, n, dur, gain) {
    const g = ctx.createGain(), f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(), mix = ctx.createGain();
    f1.type = 'bandpass'; f1.frequency.value = 900; f1.Q.value = 3;
    f2.type = 'bandpass'; f2.frequency.value = 2400; f2.Q.value = 4;
    mix.gain.value = 1;
    env(g, t, 0.012, gain || 0.22, dur * 0.4, (gain || 0.22) * 0.6, 0.06, t + dur);
    f1.connect(mix); f2.connect(mix); mix.connect(g);
    g.connect(musicBus); g.connect(delay); g.connect(reverb);
    for (const [type, k] of [['sawtooth', 1], ['square', 0.5]]) {
        const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; og.gain.value = k;
        o.frequency.setValueAtTime(midi(n - 1), t); o.frequency.exponentialRampToValueAtTime(midi(n), t + 0.05);
        o.connect(og); og.connect(f1); og.connect(f2);
        o.start(t); o.stop(t + dur + 0.1);
    }
}
// Marimba: sine with a quick knock and a short 4th-harmonic ping
function marimba(t, n, gain) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain || 0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    g.connect(musicBus); g.connect(reverb);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(n); o.connect(g); o.start(t); o.stop(t + 0.5);
    const h = ctx.createOscillator(), hg = ctx.createGain(); h.type = 'sine'; h.frequency.value = midi(n) * 4; hg.gain.setValueAtTime(0.35, t); hg.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    h.connect(hg).connect(g); h.start(t); h.stop(t + 0.1);
}
// White-noise riser sweeping up over `bars` bars, ending on the drop
function riser(t, dur) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.95); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    src.connect(f).connect(g); g.connect(musicBus); g.connect(reverb);
    src.start(t); src.stop(t + dur + 0.1);
}
// The drop's impact: a deep boom and a splash of noise
function impact(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g).connect(musicBus); o.start(t); o.stop(t + 1.2);
    noise(t, 1.4, 'highpass', 3500, 0.5, 0.14, reverb);
    noise(t, 0.6, 'highpass', 6000, 0.5, 0.08, musicBus);
}

// One 16th-note step of the song
function playStep(s, t) {
    const bar = Math.floor(s / 16), i = s % 16, b = bar % 32, sec = SECTION(bar), chord = CHORDS[bar % 4];
    const drop = sec === 'drop' || sec === 'drop2';
    if (sec === 'intro' || sec === 'break') {
        // Pad and marimba, a soft shaker; the break adds claps and a light kick
        if (i === 0) pad(t, chord.notes, STEP * 16, sec === 'break' ? 0.05 : 0.04, sec === 'intro' ? 600 + (b % 4) * 400 : 1800);
        if (i === 0) bass(t, chord.root, STEP * 14, 0.14);
        if (i % 2 === 0) { const arp = [0, 1, 2, 3, 2, 1, 3, 2][(i / 2) % 8]; marimba(t, chord.notes[arp] + 12, 0.09); }
        if (i % 4 === 2) shaker(t, 0.03);
        if (sec === 'break') {
            if (i === 4 || i === 12) clap(t, 0.12);
            const ph = CHOPS_A[bar % 4];
            for (const [at, n, l] of ph) if (at === i) marimba(t, n + 12, 0.11);
        }
        if (b === 3 && i >= 12) snare(t, 0.05 + (i - 12) * 0.02);
        return;
    }
    if (sec === 'build') {
        // Rising snare roll (quarters, eighths, sixteenths), the filter opens, the riser climbs
        const k = b % 4;
        if (k === 0 && i === 0) riser(t, STEP * 64);
        const every = k < 2 ? 4 : k === 2 ? 2 : 1;
        if (i % every === 0) snare(t, 0.05 + (k * 16 + i) / 64 * 0.12);
        if (k < 3 && i % 4 === 0) kick(t, 0.6);
        if (i === 0) supersaw(t, chord.notes, STEP * 14, 0.035, 800 + k * 900);
        if (i % 2 === 0) hat(t, false, 0.025);
        if (i === 0) bass(t, chord.root, STEP * 12, 0.18);
        return;
    }
    // Drops: the full groove
    if (b === 8 && i === 0 || b === 24 && i === 0) impact(t);
    if (i % 4 === 0) kick(t, 0.85);
    if (i === 4 || i === 12) clap(t, 0.2);
    if (i % 4 === 2) hat(t, true);
    if (i % 2 === 1) shaker(t, 0.025);
    if (STABS.includes(i)) {
        supersaw(t, chord.notes.map((n) => n + 12), STEP * 2.2, 0.05, 2600);
        bass(t, chord.root + (i === 6 || i === 14 ? 12 : 0), STEP * 2.4, 0.3);
    }
    const ph = (sec === 'drop2' ? CHOPS_B : CHOPS_A)[bar % 4];
    for (const [at, n, l] of ph) if (at === i) chop(t, n, STEP * l, 0.2);
    // Up on the stairs: a glittery arp on top
    if (intensity > 0.5 && i % 2 === 0) marimba(t, chord.notes[(i / 2) % 4] + 24, 0.05);
    if (i === 14 && bar % 4 === 3) snare(t, 0.08), snare(t + STEP / 2, 0.1);
}

function scheduler() {
    while (nextTime < ctx.currentTime + 0.15) {
        playStep(step, nextTime);
        nextTime += STEP;
        step++;
    }
}
export function startMusic() {
    if (!ctx || musicOn) return;
    musicOn = true;
    step = 0; nextTime = ctx.currentTime + 0.1;
    schedTimer = setInterval(scheduler, 25);
}
export function stopMusic() { musicOn = false; clearInterval(schedTimer); }

// ----- ambience -----
// Soft high-altitude wind that swells and fades
function startWind() {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.7;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.06; lg.gain.value = 350; lfo.connect(lg).connect(f.frequency);
    ambGain = ctx.createGain(); ambGain.gain.value = 0;
    src.connect(f).connect(ambGain).connect(sfxBus);
    src.start(); lfo.start();
    applyVolumes();
}

// ----- sound effects -----
function tone(t, type, f0, f1, dur, gain, out) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out || sfxBus); o.start(t); o.stop(t + dur + 0.05);
}
const SFX = {
    click(t) { tone(t, 'triangle', 900, 500, 0.06, 0.25); },
    jump(t) { tone(t, 'sine', 260, 620, 0.14, 0.25); },
    land(t) { noise(t, 0.12, 'lowpass', 500, 1, 0.35, sfxBus); tone(t, 'sine', 120, 60, 0.1, 0.3); },
    step(t) { tone(t, 'sine', 160 + Math.random() * 40, 80, 0.06, 0.07); noise(t, 0.04, 'lowpass', 1200, 1, 0.04, sfxBus); },
    // Hands slapping onto the studs
    grab(t) { noise(t, 0.06, 'bandpass', 1800, 1.5, 0.3, sfxBus); tone(t, 'triangle', 300, 180, 0.08, 0.15); },
    grip(t) { noise(t, 0.035, 'bandpass', 2400 + Math.random() * 600, 2, 0.12, sfxBus); },
    // Pulled over the top edge
    top(t) { [72, 79, 84].forEach((n, i) => tone(t + i * 0.06, 'triangle', midi(n), null, 0.18, 0.14)); },
    // A falling block smashing at the foot of its wall
    // Laser zap: a falling buzzy square with a crackle
    zap(t) { tone(t, 'square', 1400, 180, 0.22, 0.18); noise(t, 0.15, 'highpass', 3000, 0.8, 0.2, sfxBus); },
    crash(t) { tone(t, 'sine', 140, 40, 0.3, 0.5); noise(t, 0.35, 'lowpass', 900, 1, 0.45, sfxBus); },
    pickup(t) { tone(t, 'sine', midi(84), null, 0.12, 0.3); tone(t + 0.07, 'sine', midi(91), null, 0.22, 0.3); },
    gain(t) { tone(t, 'triangle', midi(84), null, 0.06, 0.07); },
    hit(t) { tone(t, 'sine', 180, 50, 0.25, 0.7); noise(t, 0.25, 'lowpass', 1200, 1, 0.5, sfxBus); },
    death(t) { tone(t, 'sawtooth', 420, 60, 0.7, 0.25); noise(t, 0.5, 'lowpass', 800, 1, 0.3, sfxBus); },
    chomp(t) { tone(t, 'square', 160, 60, 0.12, 0.35); tone(t + 0.12, 'square', 140, 50, 0.14, 0.35); noise(t, 0.3, 'lowpass', 900, 1, 0.4, sfxBus); },
    levelUp(t) { [72, 76, 79, 84].forEach((n, i) => tone(t + i * 0.08, 'square', midi(n), null, 0.25, 0.12)); tone(t + 0.32, 'triangle', midi(88), null, 0.6, 0.2); },
    buy(t) { [79, 84, 88, 91, 96].forEach((n, i) => tone(t + i * 0.05, 'sine', midi(n), null, 0.3, 0.16)); },
    whoosh(t) {
        const src = ctx.createBufferSource(); src.buffer = noiseBuf;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
        f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3000, t + 0.35);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        src.connect(f).connect(g).connect(sfxBus); src.start(t); src.stop(t + 0.55);
    },
    cheer(t) {
        // Drum roll into a fanfare
        for (let i = 0; i < 6; i++) tone(t + i * 0.04, 'sine', 180 - i * 8, 90, 0.08, 0.2);
        [72, 76, 79, 84, 88].forEach((n, i) => tone(t + 0.25 + i * 0.07, 'square', midi(n), null, 0.3, 0.08));
        noise(t + 0.25, 0.6, 'highpass', 4000, 0.7, 0.12, sfxBus);
    },
    gate(t) {
        [84, 88, 91, 96, 100].forEach((n, i) => tone(t + i * 0.035, 'sine', midi(n), null, 0.5, 0.09));
        tone(t, 'triangle', 220, 880, 0.35, 0.12);
    },
    firework(t) { tone(t, 'sine', 900, 200, 0.35, 0.06); noise(t + 0.35, 0.4, 'lowpass', 2500, 0.8, 0.35, sfxBus); },
    // Pogo spring: a short "boing" (pitch wobble), bigger and lower for a full-power bounce
    boing(t) { springTone(t, 300 + Math.random() * 40, 0.16, 0.12); },
    bigBoing(t) { springTone(t, 170, 0.42, 0.22); noise(t, 0.08, 'lowpass', 700, 1, 0.15, sfxBus); },
    tramp(t) { springTone(t, 220, 0.3, 0.18); tone(t, 'sine', 90, 50, 0.18, 0.25); },
    splash(t) { noise(t, 0.6, 'bandpass', 900, 0.6, 0.5, sfxBus); noise(t + 0.05, 0.9, 'highpass', 2500, 0.5, 0.2, sfxBus); tone(t, 'sine', 300, 80, 0.25, 0.2); },
};
// Sine whose pitch springs up and wobbles back down, like a coil
function springTone(t, f, dur, gain) {
    const o = ctx.createOscillator(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f * 0.7, t); o.frequency.exponentialRampToValueAtTime(f * 1.9, t + dur * 0.35); o.frequency.exponentialRampToValueAtTime(f, t + dur);
    lfo.frequency.value = 28; lg.gain.value = f * 0.12; lfo.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(sfxBus); o.start(t); o.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
}
export function sfx(name) {
    if (!ctx || !SFX[name] || settings.sfx <= 0) return;
    SFX[name](ctx.currentTime + 0.005);
}
