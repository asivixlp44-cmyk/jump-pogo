// Game data shared by the client and the Colyseus server.
// +1 Jump Pogo: every bounce is +Power, Power levels you up and every level is +2.5 Jump Power.
// Bounce up the giant Rainbow Stairs for Wins, spend Wins on better pogos.

export const CFG = {
    maxLevel: 150,
    // Jump Power: 50 at Level 0, +2.5 per level, +25 per rebirth (as in the reference: "Jump Power 55 > 57.5 (+2.5)")
    jpBase: 50,
    jpPerLevel: 2.5,
    jpPerRebirth: 25,
    // A full bounce rises jumpHeight(JP) studs; between full bounces the pogo keeps hopping
    gravity: 120,
    hopHeight: 3.6,
    trampHeight: 10,
    moveSpeed: 26,
    // Power from a bounce grows with height: +1 every heightStep studs above the sea
    heightStep: 15,
    // The server ignores bounces closer together than this
    minBounce: 0.26,
    waterY: -1.5,
    boostMult: 2,
    boostMinutes: 15,
    starterPackDuration: 15 * 60,
    offerRotate: 45,
    // Rebirth: +50% Power per rebirth, +25 Jump Power. Needs Level 20, then 10 more per rebirth (up to 120)
    rebirthStep: 0.5,
    // Friend Boost: +10% Power per Bloxity friend in the same server, up to 5
    friendBoost: 0.1,
    friendMax: 5,
    // Trampolines keep paying while you're away: Power for up to 8 hours, at a quarter rate
    offlineHours: 8,
    offlineRate: 0.25,
    // Leaderboards refresh every minute
    boardsEvery: 60,
    world2Rebirths: 10,
    maxPlayers: 24,
};
export const rebirthLevel = (r) => 20 + 10 * Math.min(10, r || 0);
export const jumpPowerFor = (L, R) => CFG.jpBase + CFG.jpPerLevel * (L || 0) + CFG.jpPerRebirth * (R || 0);
// Studs a full bounce rises with this Jump Power
export const jumpHeight = (jp) => jp * 0.42;

// XP to the next level, read off the reference: 50, 54, 58, 62, 67 ... (x1.075), a step up to 322 at
// Level 20, then x1.075 again (621 at 29, 1.5K at 41, 4.4K at 56, 12.3K at 70)
export function xpFor(L) {
    L = Math.max(0, Math.min(CFG.maxLevel, L | 0));
    return L < 20 ? Math.round(50 * Math.pow(1.075, L)) : Math.round(322 * Math.pow(1.075, L - 20));
}

export const LOBBY = { halfX: 100, halfZ: 72, spawn: { x: 0, y: 0.2, z: -38 } };

// ----- The Rainbow Stairs: a stepped pyramid out at sea, straight ahead of the lobby (+z) -----
// Step k is a giant studded block: its riser rises `rise` studs above the step below, its top is
// `h` studs above the sea ("10 STUD", "25 STUD" ... painted on the riser), `d` studs deep. Each
// step's top has a "+N Wins" pad that pays out and sends you back to the lobby.
// The rises follow the reference (10, 15, 20, 25, 30, 36, 39, 48, 54, 60, 67, 76), then +8% a step.
export const BRIDGE = { z0: LOBBY.halfZ, len: 46, width: 30 };
export const STAIRS_Z0 = BRIDGE.z0 + BRIDGE.len;
const RISES = [10, 15, 20, 25, 30, 36, 39, 48, 54, 60, 67, 76];
while (RISES.length < 30) RISES.push(Math.round(RISES[RISES.length - 1] * 1.08));
const STEP_WINS = [1, 3, 5, 10, 15, 25, 35, 50, 75, 100, 150, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000,
    5500, 7500, 10000, 14000, 19000, 26000, 36000, 50000, 70000, 100000];
export const STEP_DEPTH = 28;
export const STAIRS = [];
{
    let h = 0;
    RISES.forEach((rise, k) => {
        h += rise;
        STAIRS.push({
            k, rise, h, y0: h - rise,
            z0: STAIRS_Z0 + k * STEP_DEPTH,
            w: Math.max(52, 96 - k * 1.6),
            wins: STEP_WINS[k],
        });
    });
}
// The top: a wide gold summit with the trophy and the last, biggest pad
export const SUMMIT = { depth: 70, wins: 250000 };
{
    const last = STAIRS[STAIRS.length - 1];
    SUMMIT.z0 = last.z0 + STEP_DEPTH;
    SUMMIT.h = last.h + 12;
    SUMMIT.zEnd = SUMMIT.z0 + SUMMIT.depth;
}
// Every step block reaches back to the summit's far end, like a ziggurat
export const STAIRS_END = SUMMIT.zEnd;
// Rainbow from green at the bottom through yellow, orange, red, pink and purple to blue at the top
export const stepColor = (k) => ((Math.round(((110 - k * 11) % 360 + 360) % 360)) / 360);
// Which step's top a point is on (index), or -1
export function stepAt(x, y, z) {
    for (let k = STAIRS.length - 1; k >= 0; k--) {
        const s = STAIRS[k];
        if (z >= s.z0 && z < s.z0 + STEP_DEPTH && Math.abs(x) <= s.w / 2 && Math.abs(y - s.h) < 4) return k;
    }
    return -1;
}
// Wins pad on step k: on the right of the tread as you face up the stairs (-x)
export const padPos = (k) => {
    if (k === STAIRS.length) return { x: 0, y: SUMMIT.h, z: SUMMIT.zEnd - 18 };
    const s = STAIRS[k];
    return { x: -(s.w / 2 - 8), y: s.h, z: s.z0 + STEP_DEPTH / 2 };
};

// ----- Power Gems: glowing crystals floating over every step. Touch one for a burst of Power;
// it comes back for you after GEM_RESPAWN seconds. Worth more the higher it floats. -----
export const GEM_RESPAWN = 45;
export const GEMS = [];
STAIRS.forEach((s) => {
    for (const fx of [0.18, -0.12, 0.34]) {
        if (s.k < 2 && fx === 0.34) continue;
        GEMS.push({ i: GEMS.length, k: s.k, x: fx * s.w, y: s.h + 5.5, z: s.z0 + STEP_DEPTH * (fx > 0 ? 0.62 : 0.4) });
    }
});
// Power from a gem before multipliers
export const gemValue = (g) => 25 * (1 + Math.floor(g.y / CFG.heightStep));

// ----- Training: trampolines along the left side of the lobby -----
// "0 Rebirths 1.5x Power", "1 Rebirth 2x Power" ... as in the reference, plus the ADMIN pass trampoline
export const TRAMPS = [
    { mult: 1.5, reb: 0 }, { mult: 2, reb: 1 }, { mult: 3, reb: 2 }, { mult: 5, reb: 3 },
    { mult: 7.5, reb: 4 }, { mult: 10, reb: 5 }, { mult: 15, reb: 8 }, { mult: 25, reb: 12 },
    { mult: 250, pass: 'AdminTramp', tag: 'ADMIN' },
];
export const TRAMP_COLORS = [0x2a8cff, 0xff8a1e, 0xe8304a, 0x46ec50, 0xff4ad8, 0x8a5aff, 0xffd028, 0x28e8d8, 0xff2a3a];
export const TRAMP_GEO = { x: 68, z0: -56, step: 14, r: 5.6, top: 2.2 };
export const trampPos = (i) => ({ x: TRAMP_GEO.x, z: TRAMP_GEO.z0 + i * TRAMP_GEO.step });
// Secret trampoline: x3 Power for one minute, every five minutes, somewhere in the lobby (server clock)
export const SECRET = { every: 300, lasts: 60, mult: 3, spots: [[-22, 18], [28, -6], [-40, -30], [20, 40], [-46, 30], [44, 24]] };
export function secretAt(nowMs) {
    const t = nowMs / 1000, k = Math.floor(t / SECRET.every), age = t - k * SECRET.every;
    const [x, z] = SECRET.spots[k % SECRET.spots.length];
    return { k, x, z, on: age < SECRET.lasts, left: SECRET.lasts - age, next: SECRET.every - age };
}
// The trampoline (definition or the secret one) under a point, or null
export function trampAt(x, y, z, nowMs) {
    if (y > TRAMP_GEO.top + 4 || y < TRAMP_GEO.top - 1.5) return null;
    for (let i = 0; i < TRAMPS.length; i++) {
        const p = trampPos(i);
        if ((x - p.x) ** 2 + (z - p.z) ** 2 <= (TRAMP_GEO.r + 0.6) ** 2) return { ...TRAMPS[i], i };
    }
    if (nowMs) {
        const s = secretAt(nowMs);
        if (s.on && (x - s.x) ** 2 + (z - s.z) ** 2 <= (TRAMP_GEO.r + 0.6) ** 2) return { mult: SECRET.mult, i: -1, secret: true };
    }
    return null;
}

// ----- Pogo skins: Power multipliers bought with Wins (stand on the pad), or passes -----
// From the reference: x1 FREE, x2 1 Win, x3 15, x5 50, x10 125, x15 250, x20 520, x25 1,300, x30 3,000,
// x40 8,000, x50 25,000; CUTE / GALAXY / ADMIN pogos are game passes.
export const POGOS = [
    { id: 'Basic', name: 'Basic Pogo', mult: 1, cost: 0, pole: 0xd8dce8, grip: 0xe8304a, spring: 0x9aa0b4 },
    { id: 'Sky', name: 'Sky Pogo', mult: 2, cost: 1, pole: 0x3a8cff, grip: 0xffffff, spring: 0x9fd8ff },
    { id: 'Lime', name: 'Lime Pogo', mult: 3, cost: 15, pole: 0x46ec50, grip: 0x16121f, spring: 0xc8ffb0 },
    { id: 'Sunny', name: 'Sunny Pogo', mult: 5, cost: 50, pole: 0xffd028, grip: 0xff8a1e, spring: 0xfff2a0 },
    { id: 'Blaze', name: 'Blaze Pogo', mult: 10, cost: 125, pole: 0xff6a14, grip: 0x16121f, spring: 0xffc070, glow: 0xff8a1e, fx: 'fire' },
    { id: 'Bubble', name: 'Bubblegum Pogo', mult: 15, cost: 250, pole: 0xff5ab8, grip: 0xffffff, spring: 0xffc0e4, glow: 0xff7ad0 },
    { id: 'Frost', name: 'Frost Pogo', mult: 20, cost: 520, pole: 0x6fe0ff, grip: 0xffffff, spring: 0xd8f6ff, glow: 0x6fe0ff, fx: 'spark' },
    { id: 'Neon', name: 'Neon Pogo', mult: 25, cost: 1300, pole: 0x8a5aff, grip: 0x28e8d8, spring: 0xd0b8ff, glow: 0xb07aff, fx: 'spark' },
    { id: 'Royal', name: 'Royal Pogo', mult: 30, cost: 3000, pole: 0xffc428, grip: 0xb0182c, spring: 0xfff0b0, glow: 0xffd028, fx: 'star' },
    { id: 'Toxic', name: 'Toxic Pogo', mult: 40, cost: 8000, pole: 0x7dff28, grip: 0x16121f, spring: 0xd8ff8a, glow: 0x9cff3a, fx: 'fire' },
    { id: 'Rainbow', name: 'Rainbow Pogo', mult: 50, cost: 25000, pole: 0xffffff, grip: 0xff3c5a, spring: 0xffffff, glow: -1, fx: 'star' },
    { id: 'Cute', name: 'Cute Pogo', mult: 60, pass: 'CutePogo', pole: 0xffa0d8, grip: 0xffffff, spring: 0xffd8ee, glow: 0xff7ad0, fx: 'heart' },
    { id: 'Galaxy', name: 'Galaxy Pogo', mult: 150, pass: 'GalaxyPogo', pole: 0x3a1a8a, grip: 0xc46aff, spring: 0x8a5aff, glow: 0xa84aff, fx: 'star' },
    { id: 'Admin', name: 'ADMIN Pogo', mult: 300, pass: 'AdminPogo', pole: 0x16121f, grip: 0xff2a3a, spring: 0xffd028, glow: 0xff2a3a, fx: 'fire' },
];
export const pogoById = Object.fromEntries(POGOS.map((p) => [p.id, p]));
export const POGO_GEO = { x: -66, z0: -62, step: 9.4 };

// Group Chest in the lobby: free Power and Wins once a day
export const GROUP_CHEST = { hours: 24, power: 2500, wins: 5 };

export const PRODUCTS = {
    Power10K: { name: '+10K Power', price: 19, power: 10000 },
    Power100K: { name: '+100K Power', price: 49, power: 100000 },
    Power1M: { name: '+1M Power', price: 99, power: 1000000 },
    Power10M: { name: '+10M Power', price: 249, power: 10000000 },
    Power25M: { name: '+25M Power', price: 449, power: 25000000 },
    Level5: { name: '+5 Levels', price: 29, levels: 5 },
    StarterPack: { name: 'Starter Pack', price: 19, power: 25000, wins: 10 },
    PowerBoost: { name: 'x2 Power Boost (15 min)', price: 49 },
    Wins500: { name: '+500 Wins', price: 99, wins: 500 },
    Wins5K: { name: '+5K Wins', price: 399, wins: 5000 },
};
export const PASSES = {
    DoublePower: { name: 'x2 Power', price: 9, ic: '⚡', desc: 'Double all Power you earn' },
    DoubleWins: { name: 'x2 Wins', price: 99, ic: '🏆', desc: 'Double Wins from every Wins pad' },
    CutePogo: { name: 'Cute Pogo', price: 79, ic: '💖', desc: 'x60 Power pogo with hearts' },
    GalaxyPogo: { name: 'Galaxy Pogo', price: 249, ic: '🌌', desc: 'x150 Power pogo with stars' },
    AdminPogo: { name: 'ADMIN Pogo', price: 399, ic: '👑', desc: 'x300 Power pogo' },
    AdminTramp: { name: 'ADMIN Trampoline', price: 299, ic: '🔥', desc: 'Unlocks the x250 trampoline' },
    RainbowTrail: { name: 'Rainbow Trail', price: 99, ic: '🌈', desc: 'x8 Power trail' },
};
// Bloxity Bux SKUs: create these in the game's IAP catalog on bloxity.io (prices live there)
export const SKUS = {
    product: {
        Power10K: 'power_10k', Power100K: 'power_100k', Power1M: 'power_1m', Power10M: 'power_10m', Power25M: 'power_25m',
        Level5: 'level_5', StarterPack: 'starter_pack', PowerBoost: 'power_boost', Wins500: 'wins_500', Wins5K: 'wins_5k',
    },
    pass: {
        DoublePower: 'pass_double_power', DoubleWins: 'pass_double_wins', CutePogo: 'pass_cute_pogo',
        GalaxyPogo: 'pass_galaxy_pogo', AdminPogo: 'pass_admin_pogo', AdminTramp: 'pass_admin_trampoline',
        RainbowTrail: 'pass_rainbow_trail',
    },
};
// Bux price label for 3D text (DOM uses the coin icon instead)
export const buxText = (n) => fmt(n) + ' Bux';
export function skuLookup(sku) {
    for (const kind of ['product', 'pass']) for (const [key, s] of Object.entries(SKUS[kind])) if (s === sku) return { kind, key };
    return null;
}
// The +Power buttons under the Level bar: bigger ones from Level 50 (as in the reference)
export const powerButtons = (level) => (level >= 50 ? ['Power1M', 'Power10M', 'Power25M'] : ['Power10K', 'Power100K', 'Power1M']);

export const OFFERS = [
    { title: 'STARTER PACK', ic: '🎁', kind: 'product', key: 'StarterPack' },
    { title: 'Cute Pogo x60', ic: '💖', kind: 'pass', key: 'CutePogo' },
    { title: '1M Power', ic: '⚡', kind: 'product', key: 'Power1M' },
    { title: 'x2 Wins', ic: '🏆', kind: 'pass', key: 'DoubleWins' },
    { title: 'Rainbow Trail', ic: '🌈', kind: 'pass', key: 'RainbowTrail' },
];

// Trails: rebirth rewards and a pass
export const TRAILS = [
    { id: 'Starter', name: 'Starter', reb: 0, mult: 1, color: 0xbfefff },
    { id: 'Sky', name: 'Sky Trail', reb: 1, mult: 1.5, color: 0x3ab4ff },
    { id: 'Violet', name: 'Violet Trail', reb: 3, mult: 2, color: 0xb05aff },
    { id: 'Blaze', name: 'Blaze Trail', reb: 5, mult: 3, color: 0xff6a14 },
    { id: 'Gold', name: 'Golden Trail', reb: 10, mult: 5, color: 0xffd028 },
    { id: 'Rainbow', name: 'Rainbow Trail', pass: 'RainbowTrail', mult: 8, color: 0xff50c8 },
];
export const trailById = Object.fromEntries(TRAILS.map((t) => [t.id, t]));

// Session playtime rewards (minutes since joining). The REWARD button opens these.
export const FREE = [
    { min: 2, power: 500 }, { min: 5, wins: 5 }, { min: 10, wins: 25 }, { min: 15, power: 10000 },
    { min: 20, boost: 15 }, { min: 30, wins: 100 }, { min: 45, power: 250000 }, { min: 60, wins: 500 },
    { min: 90, power: 2500000 }, { min: 120, wins: 2500 },
];
// Daily Reward: seven days. One claim per UTC day; missing a day resets the streak.
export const DAILY = [
    { power: 500 }, { wins: 10 }, { power: 25000 }, { wins: 100 }, { power: 250000 }, { wins: 1000 }, { rebirths: 1 },
];
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
// Daily state at time now: can = claimable, streak = days claimed in a row, day = DAILY index of the next (or last) claim
export function dailyStatus(d, now) {
    d = d || {};
    const today = dayKey(now), yesterday = dayKey(now - 86400000);
    const can = d.last !== today;
    const streak = d.last === today || d.last === yesterday ? d.streak || 0 : 0;
    return { can, streak, day: Math.min(DAILY.length - 1, can ? streak : Math.max(0, streak - 1)) };
}
export const rewardText = (r) => [
    r.power ? '+' + fmt(r.power) + ' Power' : '',
    r.wins ? '+' + fmt(r.wins) + ' Wins' : '',
    r.rebirths ? '+' + r.rebirths + ' Rebirths' : '',
    r.boost ? 'x2 Power ' + r.boost + ' min' : '',
].filter(Boolean).join(' & ');

// The objective line at the top ("Follow the beam and bounce on Trampoline 1!"). done(p) -> [have, need];
// `to` is what the guide beam points at. Wins goals count lifetime Wins, so spending never undoes them.
const earned = (p) => Math.max(p.winsTotal || 0, p.wins || 0);
const owns = (p, id) => !!(p.pogos && p.pogos[id]);
const stud = (k) => STAIRS[k].h + ' STUD';
export const QUESTS = [
    { text: 'Follow the beam and bounce on Trampoline 1', done: (p) => [p.tramps && p.tramps[0] ? 1 : 0, 1], to: { tramp: 0 }, reward: { power: 25 } },
    { text: 'Bounce up the stairs and claim your first Win', done: (p) => [earned(p) > 0 ? 1 : 0, 1], to: { step: 0 }, reward: { power: 50 } },
    { text: 'Follow the beam and unlock Power Multiplier 2', done: (p) => [owns(p, 'Sky') ? 1 : 0, 1], to: { pogo: 1 }, reward: { power: 100 } },
    { text: 'Reach Level 5', done: (p) => [p.level + p.rebirths * 200, 5], to: { tramp: 0 }, reward: { wins: 3 } },
    { text: 'Claim the Wins on the ' + stud(2) + ' step', done: (p) => [Math.min(3, p.best || 0), 3], to: { step: 2 }, reward: { power: 500 } },
    { text: 'Unlock Power Multiplier 3', done: (p) => [owns(p, 'Lime') ? 1 : 0, 1], to: { pogo: 2 }, reward: { power: 1000 } },
    { text: 'Claim the Wins on the ' + stud(4) + ' step', done: (p) => [Math.min(5, p.best || 0), 5], to: { step: 4 }, reward: { wins: 10 } },
    { text: 'Unlock Power Multiplier 5', done: (p) => [owns(p, 'Sunny') ? 1 : 0, 1], to: { pogo: 3 }, reward: { power: 5000 } },
    { text: 'Rebirth once', done: (p) => [p.rebirths, 1], reward: { wins: 25 } },
    { text: 'Bounce on Trampoline 2', done: (p) => [p.tramps && p.tramps[1] ? 1 : 0, 1], to: { tramp: 1 }, reward: { power: 25000 } },
    { text: 'Claim the Wins on the ' + stud(7) + ' step', done: (p) => [Math.min(8, p.best || 0), 8], to: { step: 7 }, reward: { wins: 50 } },
    { text: 'Unlock Power Multiplier 10', done: (p) => [owns(p, 'Blaze') ? 1 : 0, 1], to: { pogo: 4 }, reward: { power: 100000 } },
    { text: 'Claim the Wins on the ' + stud(9) + ' step', done: (p) => [Math.min(10, p.best || 0), 10], to: { step: 9 }, reward: { wins: 150 } },
    { text: 'Rebirth 3 times', done: (p) => [p.rebirths, 3], reward: { power: 500000 } },
    { text: 'Unlock Power Multiplier 20', done: (p) => [owns(p, 'Frost') ? 1 : 0, 1], to: { pogo: 6 }, reward: { wins: 500 } },
    { text: 'Claim the Wins on the ' + stud(11) + ' step', done: (p) => [Math.min(12, p.best || 0), 12], to: { step: 11 }, reward: { power: 5000000 } },
    { text: 'Rebirth 5 times', done: (p) => [p.rebirths, 5], reward: { wins: 2500 } },
    { text: 'Unlock Power Multiplier 50', done: (p) => [owns(p, 'Rainbow') ? 1 : 0, 1], to: { pogo: 10 }, reward: { power: 50000000 } },
    { text: 'Claim the Wins on the ' + stud(19) + ' step', done: (p) => [Math.min(20, p.best || 0), 20], to: { step: 19 }, reward: { wins: 25000 } },
    { text: 'Reach the top of the Rainbow Stairs', done: (p) => [(p.best || 0) > STAIRS.length ? 1 : 0, 1], to: { step: STAIRS.length }, reward: { wins: 100000 } },
];

// Player outfits cycle by join order so players look different from each other
export const KITS = [
    { shirt: 0x14141e, shorts: 0x14141e, socks: 0x14141e },
    { shirt: 0x2f7bff, shorts: 0x1e2a44, socks: 0x1e2a44 },
    { shirt: 0xe82434, shorts: 0x14141e, socks: 0x14141e },
    { shirt: 0x28c43c, shorts: 0x1e2a44, socks: 0x1e2a44 },
    { shirt: 0xffb51c, shorts: 0x1e3caa, socks: 0x1e3caa },
    { shirt: 0x8a1cff, shorts: 0x1e2a44, socks: 0x1e2a44 },
    { shirt: 0xff3fa0, shorts: 0x1e2a44, socks: 0x1e2a44 },
    { shirt: 0x1ec8b4, shorts: 0x14141e, socks: 0x14141e },
];
export const SKINS = [0xe1af87, 0xc88c5f, 0x8c5a3c, 0x5f3c28, 0xf0c8a0];

// Combined multiplier for earned Power: rebirths, trail, pogo, 2x pass, timed boost, friends here
export function powerMult(p, now, friends) {
    let m = 1 + (p.rebirths || 0) * CFG.rebirthStep;
    const tr = trailById[p.trail];
    if (tr) m *= tr.mult;
    const pg = pogoById[p.pogo];
    if (pg) m *= pg.mult;
    if (p.passes && p.passes.DoublePower) m *= 2;
    if ((now || Date.now()) < (p.boostUntil || 0)) m *= CFG.boostMult;
    m *= 1 + CFG.friendBoost * Math.min(CFG.friendMax, friends || 0);
    return m;
}
// Power for one bounce before multipliers: +1, and +1 more for every heightStep studs up
export const bounceBase = (y) => 1 + Math.max(0, Math.floor((y || 0) / CFG.heightStep));

const SUF = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
// 2700 -> "2.7K", 1000000 -> "1M", 950 -> "950"
export function fmt(v) {
    v = Math.floor(v || 0);
    if (v < 1000) return String(v);
    let i = -1, s = v;
    while (s >= 1000 && i < SUF.length - 1) { s /= 1000; i++; }
    const t = s >= 100 ? String(Math.floor(s)) : (Math.floor(s * 10) / 10).toFixed(1).replace(/\.0$/, '');
    return t + SUF[i];
}
// Leaderboard style: 1.77Qa, 783.10B
export function big(v) {
    v = Math.floor(v || 0);
    if (v < 1000) return String(v);
    let i = -1, s = v;
    while (s >= 1000 && i < SUF.length - 1) { s /= 1000; i++; }
    return s.toFixed(2) + SUF[i];
}
export function clock(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function rngFrom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
