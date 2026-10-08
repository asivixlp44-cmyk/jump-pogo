// Controller support through the Gamepad API, with Xbox-style names.
// Sticks and triggers are read every frame; face buttons fire on press.
// Controllers with the browser's "standard" layout (Xbox, PlayStation, X-input mode) work as is.
// Generic controllers (D-input mode, cheap Bluetooth pads) get a best-guess layout, and the
// Settings panel can run a quick setup that maps every button by asking the player to press it;
// that map is saved per controller in localStorage.

const DEAD = 0.18;
export const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
const STD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
// Most D-input pads number their face buttons X, A, B, Y (Logitech / "Generic USB Joystick" order)
const DINPUT = { X: 0, A: 1, B: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11 };
const prev = new Map();
let activeIndex = null;
let onConnect = null;
// Left-stick flicks act as D-pad presses (for menus), repeating while held
const NAV_ON = 0.6, NAV_FIRST = 0.38, NAV_REPEAT = 0.16;
let navDir = '', navT = 0, lastPoll = 0;

export const pad = {
    connected: false,
    lx: 0, ly: 0, rx: 0, ry: 0,
    jump: false, sprint: false,
    pressed: new Set(), // names of buttons pressed this frame
    nav: new Set(),     // UP/DOWN/LEFT/RIGHT from left-stick flicks this frame (menus only)
    lastUsed: 0,        // performance.now() of the last controller input
    info: null,         // { id, mapping, custom, axes, down } of the controller in use, for Settings
};

function dz(v) {
    const a = Math.abs(v);
    return a < DEAD ? 0 : Math.sign(v) * Math.min(1, (a - DEAD) / (1 - DEAD));
}
const btnDown = (b) => !!b && (b.pressed || b.value > 0.5);

// ----- layouts -----
// A layout says where each named input lives:
//   buttons: { NAME: { b: index } | { a: axis, s: +1/-1 } (trigger on an axis) | { h: axis, d: 'UP'... } (hat) }
//   sticks:  { lx|ly|rx|ry: { a: axis, s: +1/-1 } } (s flips it so right / down are positive)
function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
const mapKey = (g) => 'jpg_padmap:' + g.id;
const layouts = new Map();

function defaultLayout(g) {
    const buttons = {};
    const sticks = { lx: { a: 0, s: 1 }, ly: { a: 1, s: 1 }, rx: { a: 2, s: 1 }, ry: { a: 3, s: 1 } };
    if (g.mapping === 'standard') {
        for (const n of NAMES) buttons[n] = { b: STD[n] };
        return { buttons, sticks, custom: false };
    }
    for (const [n, i] of Object.entries(DINPUT)) if (i < g.buttons.length) buttons[n] = { b: i };
    // D-input usually puts the right stick on axes 2 + 5 (3 and 4 are the triggers) when there are 6+ axes
    if (g.axes.length >= 6) sticks.ry = { a: 5, s: 1 };
    // The D-pad: a hat axis (rests above 1, e.g. 1.2857 in Chrome) or buttons 12-15
    const hat = Array.from(g.axes).findIndex((v) => Math.abs(v) > 1.05);
    if (hat >= 0) for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT']) buttons[d] = { h: hat, d };
    else if (g.buttons.length >= 16) for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT']) buttons[d] = { b: STD[d] };
    return { buttons, sticks, custom: false };
}
function layoutFor(g) {
    let L = layouts.get(g.index);
    if (L && L.id === g.id) return L;
    let saved = null;
    try { saved = JSON.parse(storageGet(mapKey(g)) || 'null'); } catch (e) { saved = null; }
    L = saved && saved.buttons && saved.sticks ? { ...saved, custom: true } : defaultLayout(g);
    L.id = g.id;
    layouts.set(g.index, L);
    return L;
}

// Axis rest values, taken the first time a controller is seen. Some controllers report triggers
// resting at -1, or a hat resting above 1; those are never read as sticks.
const rest = new Map();
function restOf(g) {
    let r = rest.get(g.index);
    if (!r || r.length !== g.axes.length) { r = Array.from(g.axes, (v) => (Math.abs(v) > 0.6 ? v : 0)); rest.set(g.index, r); }
    return r;
}
function stickValue(g, r, m) {
    if (!m || m.a >= g.axes.length) return 0;
    const v = g.axes[m.a] || 0, base = r[m.a];
    if (base) {
        if (Math.abs(base) > 0.95) return 0;   // a trigger or hat axis, not a stick
        if (Math.abs(v) < 0.15) r[m.a] = 0;    // a stick that was held at start: read it from now on
        else return 0;
    }
    return dz(v * m.s);
}
// 8-way hat axis: -1 up, -0.71 up-right, -0.43 right ... 1 up-left; anything above 1.05 is centred
function hatDir(v) {
    if (v === undefined || Math.abs(v) > 1.05) return -1;
    return ((Math.round((v + 1) / (2 / 7)) % 8) + 8) % 8;
}
const HAT = { UP: [7, 0, 1], RIGHT: [1, 2, 3], DOWN: [3, 4, 5], LEFT: [5, 6, 7] };
function bindingDown(g, r, m) {
    if (!m) return false;
    if (m.b !== undefined) return btnDown(g.buttons[m.b]);
    if (m.h !== undefined) return HAT[m.d].includes(hatDir(g.axes[m.h]));
    if (m.a !== undefined) return ((g.axes[m.a] || 0) - (r[m.a] || 0)) * m.s > 0.6;
    return false;
}

// ----- connection -----
addEventListener('gamepadconnected', (e) => {
    activeIndex = e.gamepad.index;
    pad.connected = true;
    if (onConnect) onConnect(e.gamepad, true);
});
addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index === activeIndex) {
        activeIndex = null;
        pad.connected = false;
        if (onConnect) onConnect(e.gamepad, false);
    }
});
export function onGamepadConnection(cb) { onConnect = cb; }

function currentPad() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    if (activeIndex !== null && list[activeIndex]) return list[activeIndex];
    // Prefer a controller with the standard layout; otherwise take the first one that's connected
    let pick = null;
    for (const g of list) if (g && g.connected && (!pick || (g.mapping === 'standard' && pick.mapping !== 'standard'))) pick = g;
    if (pick) { activeIndex = pick.index; pad.connected = true; if (onConnect) onConnect(pick, true); return pick; }
    return null;
}

// ----- controller setup: press each button when asked -----
// Steps in order; sticks are mapped by pushing them right, then down.
export const SETUP_STEPS = [
    { key: 'A', text: 'Press A (bottom face button: Jump)' },
    { key: 'B', text: 'Press B (right face button: Back)' },
    { key: 'X', text: 'Press X (left face button)' },
    { key: 'Y', text: 'Press Y (top face button)' },
    { key: 'LB', text: 'Press LB (left bumper)' },
    { key: 'RB', text: 'Press RB (right bumper)' },
    { key: 'LT', text: 'Press LT (left trigger)' },
    { key: 'RT', text: 'Press RT (right trigger)' },
    { key: 'BACK', text: 'Press SELECT / VIEW / SHARE' },
    { key: 'START', text: 'Press START / MENU / OPTIONS' },
    { key: 'UP', text: 'Press D-pad UP' },
    { key: 'DOWN', text: 'Press D-pad DOWN' },
    { key: 'LEFT', text: 'Press D-pad LEFT' },
    { key: 'RIGHT', text: 'Press D-pad RIGHT' },
    { key: 'lx', text: 'Push the LEFT stick to the RIGHT', stick: true },
    { key: 'ly', text: 'Push the LEFT stick DOWN', stick: true },
    { key: 'rx', text: 'Push the RIGHT stick to the RIGHT', stick: true },
    { key: 'ry', text: 'Push the RIGHT stick DOWN', stick: true },
];
let setup = null; // { step, map, waitRelease, cb }
export function startSetup(cb) {
    const g = currentPad();
    if (!g) return false;
    restOf(g);
    setup = { step: 0, map: { buttons: {}, sticks: {} }, waitRelease: true, cb, hatAxes: new Set() };
    cb({ step: 0 });
    return true;
}
export function skipSetupStep() { if (setup) advanceSetup(null); }
export function cancelSetup() { setup = null; }
export function resetLayout() {
    const g = currentPad();
    if (!g) return;
    storageSet(mapKey(g), null);
    layouts.delete(g.index);
}
function advanceSetup(binding) {
    const st = SETUP_STEPS[setup.step];
    if (binding) (st.stick ? setup.map.sticks : setup.map.buttons)[st.key] = binding;
    setup.step++;
    setup.waitRelease = true;
    if (setup.step >= SETUP_STEPS.length) {
        const g = currentPad(), def = defaultLayout(g);
        // Anything skipped keeps its best guess
        const map = { buttons: { ...def.buttons, ...setup.map.buttons }, sticks: { ...def.sticks, ...setup.map.sticks } };
        storageSet(mapKey(g), JSON.stringify(map));
        layouts.delete(g.index);
        const cb = setup.cb;
        setup = null;
        cb({ done: true });
        return;
    }
    setup.cb({ step: setup.step });
}
// Finds what the player is pressing right now (a button, a hat direction, or an axis pushed away from rest)
function anyInput(g, r) {
    for (let i = 0; i < g.buttons.length; i++) if (btnDown(g.buttons[i])) return { b: i };
    for (let i = 0; i < g.axes.length; i++) {
        const v = g.axes[i] || 0;
        if (Math.abs(r[i]) > 1.05 || Math.abs(v) > 1.05) {
            const d = hatDir(v);
            if (d >= 0) return { h: i, dir: d };
            continue;
        }
        const delta = v - (r[i] || 0);
        if (Math.abs(delta) > 0.6) return { a: i, s: Math.sign(delta) };
    }
    return null;
}
function pollSetup(g) {
    const r = restOf(g), inp = anyInput(g, r);
    if (setup.waitRelease) { if (!inp) setup.waitRelease = false; return; }
    if (!inp) return;
    const st = SETUP_STEPS[setup.step];
    if (st.stick) { if (inp.a !== undefined) advanceSetup({ a: inp.a, s: inp.s }); return; }
    if (inp.h !== undefined) advanceSetup({ h: inp.h, d: st.key });
    else if (inp.b !== undefined) advanceSetup({ b: inp.b });
    else advanceSetup({ a: inp.a, s: inp.s });
}
export const setupActive = () => !!setup;

export function pollGamepad() {
    pad.pressed.clear(); pad.nav.clear();
    const g = currentPad();
    if (!g) { pad.lx = pad.ly = pad.rx = pad.ry = 0; pad.jump = pad.sprint = false; pad.info = null; if (pad.connected) pad.connected = false; return pad; }
    if (setup) {
        // While mapping, the controller drives nothing else
        pollSetup(g);
        pad.lx = pad.ly = pad.rx = pad.ry = 0; pad.jump = pad.sprint = false;
        pad.info = { id: g.id, mapping: g.mapping || 'non-standard', custom: false, axes: Array.from(g.axes, (v) => +v.toFixed(2)), down: [] };
        pad.lastUsed = performance.now();
        return pad;
    }
    const L = layoutFor(g), r = restOf(g);
    pad.lx = stickValue(g, r, L.sticks.lx); pad.ly = stickValue(g, r, L.sticks.ly);
    pad.rx = stickValue(g, r, L.sticks.rx); pad.ry = stickValue(g, r, L.sticks.ry);
    const now = {};
    for (const n of NAMES) now[n] = bindingDown(g, r, L.buttons[n]);
    pad.jump = now.A;
    pad.sprint = now.RT || now.LT || now.L3;
    const was = prev.get(g.index) || {};
    for (const n of NAMES) if (now[n] && !was[n]) pad.pressed.add(n);
    prev.set(g.index, now);
    const t = performance.now() / 1000, dt = Math.min(0.1, t - (lastPoll || t));
    lastPoll = t;
    const sx = pad.lx, sy = pad.ly;
    const dir = Math.max(Math.abs(sx), Math.abs(sy)) < NAV_ON ? '' : Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? 'RIGHT' : 'LEFT') : (sy > 0 ? 'DOWN' : 'UP');
    if (dir !== navDir) { navDir = dir; navT = NAV_FIRST; if (dir) pad.nav.add(dir); }
    else if (dir && (navT -= dt) <= 0) { navT = NAV_REPEAT; pad.nav.add(dir); }
    pad.info = {
        id: g.id, mapping: g.mapping || 'non-standard', custom: !!L.custom,
        axes: [pad.lx, pad.ly, pad.rx, pad.ry].map((v) => +v.toFixed(2)), down: NAMES.filter((n) => now[n]),
    };
    if (pad.pressed.size || pad.lx || pad.ly || pad.rx || pad.ry || pad.sprint) pad.lastUsed = performance.now();
    return pad;
}

// Short rumble; ignored by controllers or browsers that can't vibrate
export function rumble(strength, ms) {
    const g = currentPad();
    const act = g && g.vibrationActuator;
    if (!act || !act.playEffect) return;
    act.playEffect('dual-rumble', { duration: ms || 150, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.7) }).catch(() => {});
}
