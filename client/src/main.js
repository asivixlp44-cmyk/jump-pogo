import { Client } from '@colyseus/sdk';
import {
    T, V3, $, canvas, renderer, scene, camera, sun, updateSky, solids, triggers, prompts, tickers,
    billboard, buildRig, pogoPose, buildPogo, setPogoCompress, POGO_TIP, POGO_SQUASH, confettiAt, floatText, updateEffects, lerpAngle,
} from './engine.js';
import { S, actions, net } from './state.js';
import { initAudio, startMusic, sfx, setVolume, setMusicDuck, setMusicIntensity } from './audio.js';
import * as BX from './bloxity.js';
import { createAvatar, loadBase, packAvatar, unpackAvatar, avatarStats } from './avatar.js';
import { updateMaterials } from './textures.js';
import { pad, pollGamepad, rumble, onGamepadConnection } from './gamepad.js';
import { render, setSpeedLines, updateFx, dust, sparkleColumn, ring, fireworks, setQuality, makeTrail, splash, pogoFx, bounceFx } from './fx.js';
import {
    buildWorld, SPAWN, refreshShop, renderBoards, updateLobbySigns, playerAt, updateWorld, trampDip, updateGuide, questTarget, trampLocked, updateGems, updateBlob,
} from './world.js';
import {
    updateHud, toast, levelUp, buy, closeModal, openModal, refreshModal, promptEl, promptTxtEl, showGoal,
    animateCounters, showOffline, openDailyOnJoin, questDone, showRecord,
} from './ui.js';
import {
    CFG, LOBBY, STAIRS, SUMMIT, TRAMPS, TRAMP_GEO, PASSES, POGOS, QUESTS, pogoById, trailById, KITS, SKINS,
    jumpPowerFor, jumpHeight, trampPos, secretAt, stepAt, fmt, clamp,
} from '../../shared/config.js';

// =====================================================================================
// Local player. P.pos is where the pogo's rubber tip touches the ground; the rider stands
// POGO_TIP studs above it. On the ground the stick squashes for a moment, then fires you up:
// a small hop on its own, a full Jump Power bounce while Space is held (or tapped in the air).
// =====================================================================================
const HW = 1.1, PH = 7.6, STEP = 1.2, G = CFG.gravity;
const P = {
    pos: SPAWN.clone(), vel: new V3(), onGround: false, ground: null, facing: 0,
    moving: false, lockToastT: -9, contact: 0, contactFull: false, compress: 0, compressV: 0,
    airTime: 0, fallV: 0, fullQueued: false, lastBounceSent: 0, splashed: 0, peakY: 0, lastFx: 0,
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let shake = 0;
function addShake(a) { if (!reduceMotion) shake = Math.min(1.2, shake + a); }
let rig, headLabel, nameLabelText = '';

// ----- bodies: the blocky rider and its pogo, both on a "lift" the spring squashes -----
function buildBody(kit, skin, name, pogoId) {
    const g = new T.Group();
    const lift = new T.Group(); lift.position.y = POGO_TIP; g.add(lift);
    const k = KITS[kit % KITS.length];
    const body = buildRig({ ...k, skin: SKINS[skin % SKINS.length], hair: 0x8a3a14, hairStyle: ['long', 'short', 'curly', 'fade', 'quiff'][skin % 5], num: 1 + (kit % 99), numC: '#ffffff', label: (name || '').toUpperCase() });
    lift.add(body);
    g.userData.body = body;
    g.userData.lift = lift;
    setPogo(g, pogoId || 'Basic');
    return g;
}
function setPogo(g, id) {
    const u = g.userData;
    if (u.pogoId === id) return;
    if (u.pogo) u.lift.remove(u.pogo);
    u.pogoId = id;
    u.pogoDef = pogoById[id] || POGOS[0];
    u.pogo = buildPogo(u.pogoDef);
    u.lift.add(u.pogo);
}
// Pose and spring: compress 0 (rest) .. 1 (squashed flat on landing)
function animateBody(g, dt, t, st) {
    const u = g.userData;
    pogoPose(u.body, st.air, t);
    u.lift.position.y = POGO_TIP - st.compress * POGO_SQUASH;
    // Lean into the direction of travel a little
    u.body.rotation.x += ((st.moving ? 0.12 : 0) - u.body.rotation.x) * Math.min(1, dt * 8);
    u.pogo.rotation.x = u.body.rotation.x * 0.6;
    setPogoCompress(u.pogo, st.compress, t);
    if (u.blox) u.blox.update(dt, { moving: st.moving, air: st.air, pogo: true, speed: 16, t });
}

// ----- Bloxity avatars -----
// The Bloxity body replaces the blocky body's meshes; labels and the pogo stay.
function dressRig(group, avatar) {
    const body = group.userData.body;
    body.children.forEach((c) => { c.visible = false; });
    body.add(avatar.root);
    group.userData.blox = avatar;
}
let localAvatar = null, localAvatarReq = 0;
async function setupLocalAvatar() {
    const req = ++localAvatarReq;
    const a = await createAvatar(BX.currentAvatar(), BX.getSkinTextureUrl());
    if (!a) return;
    if (req !== localAvatarReq || !rig) { a.dispose(); return; }
    if (localAvatar) localAvatar.dispose();
    localAvatar = a;
    dressRig(rig, a);
}
function syncMyAvatar() {
    const av = BX.currentAvatar();
    if (localAvatar && av) { localAvatar.setProportions(av.proportions); localAvatar.setEquipped(av, BX.getSkinTextureUrl()); }
    net.send('avatar', { av: packAvatar(av) });
}
async function playEmoteOn(avatar, id) {
    if (!avatar) return;
    const cat = await BX.loadEmotes();
    const e = cat.get(id);
    if (e && e.clip) avatar.playEmote(e.clip);
}
// Chat bubble above a rig for a few seconds
function chatBubble(group, text) {
    if (!group) return;
    if (group.userData.bubble) { group.remove(group.userData.bubble); group.userData.bubble.material.map.dispose(); }
    const b = billboard([{ t: '💬 ' + text, c: '#ffffff', s: '#16121f', px: 44 }], 9, 1024, new V3(0, 12, 0), group);
    group.userData.bubble = b;
    setTimeout(() => { if (group.userData.bubble === b) { group.remove(b); b.material.map.dispose(); group.userData.bubble = null; } }, 5000);
}

function buildPlayer(kit, skin) {
    if (rig) scene.remove(rig);
    rig = buildBody(kit, skin, S.name, S.pogo);
    scene.add(rig);
    nameLabelText = '';
    headLabel = billboard([{ t: S.name || ' ', c: '#ffffff', s: '#16121f', px: 56 }], 6, 512, new V3(0, 9.9, 0), rig);
    rig.position.copy(P.pos);
    localAvatar = null;
    setupLocalAvatar();
}

// ----- collision: an AABB HW wide, PH tall, standing on P.pos -----
function overlapsBox(c, x, y, z) {
    return c.max.x > x - HW && c.min.x < x + HW && c.max.y > y && c.min.y < y + PH && c.max.z > z - HW && c.min.z < z + HW;
}
function freeAt(x, y, z) {
    for (const c of solids) if (overlapsBox(c, x, y, z)) return false;
    return true;
}
function moveAxis(axis, d) {
    if (d === 0) return;
    const p = P.pos;
    p[axis] += d;
    for (const c of solids) {
        if (!overlapsBox(c, p.x, p.y, p.z)) continue;
        if (axis === 'y') {
            if (d < 0) { p.y = c.max.y; P.fallV = Math.min(P.fallV, P.vel.y); P.vel.y = 0; P.onGround = true; P.ground = c; }
            else { p.y = c.min.y - PH - 1e-4; if (P.vel.y > 0) P.vel.y = 0; }
        } else {
            const rise = c.max.y - p.y;
            if (rise > 0 && rise <= STEP && freeAt(p.x, c.max.y + 0.01, p.z)) { p.y = c.max.y + 0.001; continue; }
            if (d > 0) p[axis] = c.min[axis] - HW - 1e-4; else p[axis] = c.max[axis] + HW + 1e-4;
        }
    }
}
function jumpPower() {
    const max = jumpPowerFor(S.level, S.rebirths);
    if (qaJP) return qaJP;
    return S.customJP > 0 && S.customJP <= max ? S.customJP : max;
}

function teleport(pos, yaw) {
    P.pos.copy(pos); P.vel.set(0, 0, 0);
    P.contact = 0; P.onGround = false; P.splashed = 0; P.fallV = 0;
    P.facing = yaw || 0; cam.yaw = (yaw || 0) + Math.PI;
    cam.target.set(pos.x, pos.y + 6, pos.z);
    for (const t of triggers) t.inside = overlapsBox(t, pos.x, pos.y, pos.z);
    sendMove(true);
}
function teleportLobby() { teleport(SPAWN, 0); }

// Auto Bounce: stand on the best unlocked trampoline and keep bouncing while AFK
let autoBounce = false;
function setAutoBounce(on) {
    autoBounce = on;
    $('#btnAuto').classList.toggle('on', on);
    if (!on) return;
    let best = 0;
    TRAMPS.forEach((d, i) => { if (!trampLocked(d) && d.mult > TRAMPS[best].mult) best = i; });
    const p = trampPos(best);
    teleport(new V3(p.x, TRAMP_GEO.top + 0.5, p.z), -Math.PI / 2);
    toast('Auto Bounce ON - ' + TRAMPS[best].mult + 'x Power trampoline', '#c28cff');
}
$('#btnAuto').addEventListener('click', () => { if (running) setAutoBounce(!autoBounce); });

// =====================================================================================
// Bouncing
// =====================================================================================
const POP_COLORS = { tramp: '#ffd028', full: '#2a8cff', hop: '#2a8cff' };
function landed() {
    const g = P.ground;
    const fall = -P.fallV;
    P.fallV = 0;
    let tr = g && g.tramp != null ? g.tramp : null;
    // A locked trampoline still bounces, but only like the floor
    if (tr != null && tr >= 0 && trampLocked(TRAMPS[tr])) {
        const def = TRAMPS[tr];
        if (clockT - P.lockToastT > 3) {
            P.lockToastT = clockT;
            if (def.pass) {
                toast(PASSES[def.pass].name + ' is a game pass!', '#ffd028');
                // Offer it once in a while, not on every bounce
                if (clockT - (P.passOfferT || -99) > 20) { P.passOfferT = clockT; buy('pass', def.pass); }
            } else toast('You need ' + def.reb + (def.reb === 1 ? ' Rebirth' : ' Rebirths') + ' to use this trampoline!', '#ff5a5a');
        }
        tr = null;
    }
    P.landTramp = tr;
    const full = P.fullQueued || jumpHeld;
    P.contactFull = full;
    P.contact = full || tr != null ? 0.09 : 0.06;
    P.compressV = 0;
    // Effects scale with how hard you came down
    const k = clamp(fall / 120, 0, 1);
    if (tr != null) { trampDip(tr, 0.6 + k); sfx('tramp'); }
    if (fall > 60) { bounceFx(P.pos, k, 0xffffff); addShake(0.25 * k); rumble(0.3 * k, 120); }
    else dust(P.pos, 3, 0.5);
    // Every landing is a bounce: the server pays for it (rate-limited there too)
    if (clockT - P.lastBounceSent >= CFG.minBounce) {
        P.lastBounceSent = clockT;
        sendMove(true);
        net.send('bounce');
    }
}
function launch() {
    const tr = P.landTramp, full = P.contactFull;
    let h = full ? jumpHeight(jumpPower()) : CFG.hopHeight;
    if (tr != null) h = full ? h * 1.15 : CFG.trampHeight;
    P.vel.y = Math.sqrt(2 * G * h);
    P.onGround = false; P.ground = null;
    P.fullQueued = false;
    P.peakY = P.pos.y;
    P.compressV = -9;
    if (full) { sfx('bigBoing'); dust(P.pos, 8, 1); ring(P.pos, 0x6fe0ff, 4 + Math.min(6, h / 12), 0.4); rumble(0.25, 90); }
    else if (tr == null) sfx('boing');
}
// Fell into the sea: splash, a moment under, then back to the lobby
function splashDown() {
    P.splashed = 0.9;
    P.vel.set(0, 0, 0);
    sfx('splash');
    splash(new V3(P.pos.x, CFG.waterY + 0.5, P.pos.z), 1.2);
    toast('Splash! Back to the lobby', '#6fe0ff');
    sendMove(true);
}

// "+N" with a blue shoe pops up beside you every time Power goes up, like the reference
let powerSeen = false, popT = 0, popAcc = 0;
function popGain(n) {
    popAcc += n;
    if (clockT - popT < 0.12 && n < 1000) return;
    popT = clockT;
    const a = Math.random() * Math.PI * 2;
    const side = new V3(Math.cos(a) * (3 + Math.random() * 2.5), 5 + Math.random() * 4, Math.sin(a) * (3 + Math.random() * 2.5));
    floatText('👟+' + fmt(popAcc), P.landTramp != null ? POP_COLORS.tramp : POP_COLORS.hop, P.pos.clone().add(side));
    popAcc = 0;
    sfx('gain');
}

// =====================================================================================
// Actions triggered by world objects
// =====================================================================================
actions.pad = (k) => {
    sendMove(true);
    net.send('pad', { i: k });
    teleportLobby();
};
actions.chest = () => net.send('chest');
actions.portal = () => {
    if (clockT - P.lockToastT < 3) return;
    P.lockToastT = clockT;
    if (S.rebirths < CFG.world2Rebirths) toast('World 2: ' + CFG.world2Rebirths + ' Rebirths Required! (you have ' + S.rebirths + ')', '#ff8af0');
    else toast('World 2 is coming soon!', '#ff8af0');
};
actions.buy = (kind, key) => buy(kind, key);
const pogoToastT = new Map();
actions.pogo = (def) => {
    if (S.pogo === def.id) return;
    if ((pogoToastT.get(def.id) || -9) > clockT - (def.pass ? 6 : 1.5)) return;
    pogoToastT.set(def.id, clockT);
    const owned = S.pogos && S.pogos[def.id];
    if (!owned && def.pass) { buy('pass', def.pass); return; }
    if (!owned && S.wins < def.cost) {
        toast('You need ' + Math.max(1, Math.round((1 - S.wins / def.cost) * 100)) + '% more Wins!', '#ff5a5a');
        return;
    }
    net.send('pogo', { id: def.id });
};
actions.trail = (t) => {
    if (S.trail === t.id) return;
    if (t.pass && !S.passes[t.pass]) { buy('pass', t.pass); return; }
    if (!t.pass && S.rebirths < t.reb) { toast('Need ' + t.reb + (t.reb === 1 ? ' Rebirth' : ' Rebirths') + ' for this trail!', '#ff5a5a'); return; }
    net.send('trail', { id: t.id });
};
// Power Gems: the server checks the position and pays (reply: 'gem')
function touchGem(g) {
    sendMove(true);
    net.send('gem', { i: g.i });
    sfx('pickup');
    sparkleColumn(new V3(g.x, g.y - 2, g.z), 0x9ff0ff);
    ring(new V3(g.x, g.y - 1, g.z), 0x9ff0ff, 5, 0.4);
}
let secretToastK = -1;
actions.secretSpawned = () => {
    const s = secretAt(net.now());
    if (!running || s.k === secretToastK || s.left < 5) return;
    secretToastK = s.k;
    toast('A Secret Trampoline Has Spawned In The Lobby!', '#ffd028');
    sfx('gate');
};

// Friend Boost: tell the server which of our Bloxity friends are in this server
let friendNames = [], friendsT = 3, friendSyncT = 5;
async function refreshFriends() {
    if (!BX.bloxity.ready || !BX.identity().loggedIn) return;
    const list = await BX.getFriends();
    friendNames = list.map((f) => f.displayName || f.username).filter(Boolean);
    syncFriends();
}
function syncFriends() {
    const room = net.room;
    if (!room || !room.state || !room.state.players || !friendNames.length) return;
    const here = [];
    room.state.players.forEach((p, id) => { if (id !== room.sessionId && friendNames.includes(p.name)) here.push(p.name); });
    net.send('friends', { names: here });
}

// =====================================================================================
// Other players
// =====================================================================================
const remotes = new Map();
let joinSynced = false;
class Remote {
    constructor(p) {
        this.rig = buildBody(p.kit, p.skin, p.name, p.pogo);
        this.rig.position.set(p.x, p.y, p.z);
        this.rig.rotation.y = p.ry;
        scene.add(this.rig);
        this.labelText = '';
        this.label = billboard([{ t: p.name, c: '#ffffff', s: '#16121f', px: 56 }], 6, 512, new V3(0, 10.6, 0), this.rig);
        this.trail = makeTrail(0xbfefff);
        this.av = null; this.blox = null; this.dead = false;
        this.anim = p.anim; this.compress = 0; this.fxT = 0;
        this.setAvatar(p.av);
    }
    setAvatar(av) {
        this.av = av;
        const data = av ? unpackAvatar(av) : null;
        if (this.blox) { this.blox.setProportions(data && data.proportions); this.blox.setEquipped(data || {}); return; }
        if (this.loading) return;
        this.loading = true;
        createAvatar(data).then((a) => {
            this.loading = false;
            if (!a) return;
            if (this.dead) { a.dispose(); return; }
            this.blox = a;
            dressRig(this.rig, a);
            if (this.av !== av) this.setAvatar(this.av);
        });
    }
    update(p, dt, t) {
        const r = this.rig;
        const k = 1 - Math.exp(-dt * 14);
        if ((r.position.x - p.x) ** 2 + (r.position.z - p.z) ** 2 + (r.position.y - p.y) ** 2 > 2500) r.position.set(p.x, p.y, p.z);
        else { r.position.x += (p.x - r.position.x) * k; r.position.y += (p.y - r.position.y) * k; r.position.z += (p.z - r.position.z) * k; }
        r.rotation.y = lerpAngle(r.rotation.y, p.ry, k);
        if (p.av !== this.av) this.setAvatar(p.av);
        if (p.pogo !== r.userData.pogoId) setPogo(r, p.pogo);
        // Falling (4) to rising (2) is a bounce: squash the spring
        if (this.anim === 4 && p.anim !== 4 && p.anim !== 3) this.compress = 1;
        this.anim = p.anim;
        this.compress = Math.max(0, this.compress - dt * 7);
        r.visible = p.anim !== 3;
        animateBody(r, dt, t, { moving: p.anim === 1, air: p.anim === 2 || p.anim === 4, compress: this.compress });
        const text = p.name + '|' + fmt(p.power);
        if (text !== this.labelText) {
            this.labelText = text;
            this.label.userData.set([{ t: p.name, c: '#ffffff', s: '#16121f', px: 50 }, { t: fmt(p.power) + ' Power', c: '#c46aff', s: '#16121f', px: 56 }]);
        }
        const tr = trailById[p.trail] || trailById.Starter;
        this.trail.setColor(tr.id === 'Rainbow' ? -1 : tr.color);
        trailAt.set(-Math.sin(r.rotation.y) * 1.2, 4, -Math.cos(r.rotation.y) * 1.2).add(r.position);
        this.trail.update(trailAt, p.anim !== 3 && p.anim !== 0, dt);
        const def = r.userData.pogoDef;
        if (def.fx && r.visible && camera.position.distanceToSquared(r.position) < 120 * 120) {
            this.fxT -= dt;
            if (this.fxT <= 0) { this.fxT = 0.06; pogoFx(r.position, def.fx); }
        }
    }
    dispose() {
        this.dead = true;
        if (this.blox) this.blox.dispose();
        this.trail.dispose();
        scene.remove(this.rig);
    }
}
function syncRemotes(dt, t) {
    const room = net.room;
    if (!room || !room.state || !room.state.players) return 1;
    const seen = new Set();
    room.state.players.forEach((p, id) => {
        if (id === room.sessionId) {
            // Our own public stats come from the server
            const oldLevel = S.level, oldReb = S.rebirths;
            if (powerSeen && p.power > S.power) popGain(p.power - S.power);
            powerSeen = true;
            S.name = p.name; S.power = p.power; S.wins = p.wins; S.level = p.level; S.xp = p.xp; S.rebirths = p.rebirths; S.friends = p.friends;
            if (!rig || rig.userData.kit !== p.kit) { buildPlayer(p.kit, p.skin); rig.userData.kit = p.kit; }
            if (p.pogo && rig.userData.pogoId !== p.pogo) setPogo(rig, p.pogo);
            if (oldLevel !== S.level || oldReb !== S.rebirths) { refreshModal(); refreshShop(); }
            return;
        }
        seen.add(id);
        let r = remotes.get(id);
        if (!r) {
            r = new Remote(p); remotes.set(id, r);
            if (joinSynced) BX.playerJoined(p.name); else BX.playerInRoom(p.name);
        }
        r.update(p, dt, t);
    });
    for (const [id, r] of remotes) if (!seen.has(id)) { r.dispose(); remotes.delete(id); }
    joinSynced = true;
    return room.state.players.size;
}

// =====================================================================================
// Networking
// =====================================================================================
// Hosted on Bloxity (VITE_BLOXITY_GAME_ID set at build time): the client is served from
// <id>.play.bloxity.io and the server pods are found through the Bloxity matchmaker.
const BLOXITY_GAME_ID = import.meta.env.VITE_BLOXITY_GAME_ID || '';
// <id>.play.bloxity.io -> <id>.host.bloxity.io, <id>.dev.play.bloxity.io -> <id>.dev.host.bloxity.io
const ON_BLOXITY_HOST = /\.play\.bloxity\.io$/.test(location.hostname);
const DEV_CHANNEL = /\.dev\.play\.bloxity\.io$/.test(location.hostname);
const SERVER_URL = import.meta.env.VITE_SERVER_URL
    || (ON_BLOXITY_HOST ? `https://${location.hostname.replace(/\.play\.bloxity\.io$/, '.host.bloxity.io')}`
        : BLOXITY_GAME_ID ? `https://${BLOXITY_GAME_ID}.host.bloxity.io`
        : import.meta.env.DEV ? `${location.protocol}//${location.hostname}:2567` : location.origin);
async function serverEndpoint() {
    let url = SERVER_URL;
    if (BLOXITY_GAME_ID) {
        const r = await BX.resolveEndpoint(BLOXITY_GAME_ID, DEV_CHANNEL ? 'preview' : undefined);
        if (r && r.cold) $('#loading').textContent = 'Waking up a server…';
        url = (r && r.endpoint) || SERVER_URL;
    }
    // The matchmaker hands back a wss:// room proxy (wss://play.bloxity.io/v1/ws/<room>): Colyseus
    // joins through it directly and it has no /health, so only plain http(s) servers are polled
    if (!/^https?:/i.test(url)) return url;
    // A scaled-to-zero server takes a while to boot: poll /health (every 2 s, up to 60 s) before joining
    if (!(await serverUp(url))) {
        $('#loading').textContent = 'Waking up a server…';
        const until = Date.now() + 60000;
        while (Date.now() < until) {
            await new Promise((res) => setTimeout(res, 2000));
            if (await serverUp(url)) break;
        }
    }
    return url;
}
async function serverUp(url) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(url.replace(/\/$/, '') + '/health', { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(t);
        return r.ok;
    } catch (e) { return false; }
}
let lastMoveSent = 0, lastMoveKey = '';
function animState() { return P.splashed > 0 ? 3 : P.onGround || P.contact > 0 ? (P.moving ? 1 : 0) : P.vel.y > 0 ? 2 : 4; }
function sendMove(force) {
    const now = performance.now();
    if (!force && now - lastMoveSent < 66) return;
    const a = animState();
    const m = { x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2), ry: +P.facing.toFixed(3), a };
    const key = m.x + ',' + m.y + ',' + m.z + ',' + m.ry + ',' + a;
    if (!force && key === lastMoveKey && now - lastMoveSent < 500) return;
    lastMoveKey = key; lastMoveSent = now;
    net.send('move', m);
}

function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
function playerUid() {
    let uid = storageGet('jpg_uid');
    if (!uid) {
        uid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
        storageSet('jpg_uid', uid);
    }
    return uid;
}

async function connect(name) {
    const client = new Client(await serverEndpoint());
    const id = BX.identity();
    const room = await client.joinOrCreate('pogo', {
        uid: playerUid(), name: name || id.name, token: id.token, av: packAvatar(BX.currentAvatar()),
        save: storageGet('jpg_save') || '',
    });
    net.room = room;
    joinSynced = false;
    room.onMessage('hello', (m) => { net.offset = m.now - Date.now(); net.bux = !!m.bux; net.bloxity = !!m.bloxity; });
    room.onMessage('authed', () => { net.bloxity = true; });
    room.onMessage('emote', (m) => { const r = remotes.get(m.s); if (r) playEmoteOn(r.blox, m.id); });
    room.onMessage('chat', (m) => {
        toast(m.name + ': ' + m.text, '#ffffff');
        chatBubble(m.s === room.sessionId ? rig : remotes.get(m.s) && remotes.get(m.s).rig, m.text);
    });
    BX.updateRoom(room.roomId);
    BX.gameplayStart();
    room.onMessage('profile', (m) => {
        const oldBest = S.best | 0;
        // Signed backup of this player's progress, handed back if the server restarts
        if (m.save) storageSet('jpg_save', m.save);
        delete m.save;
        Object.assign(S, m);
        // A new highest step: "NEW HEIGHT!" with fireworks
        if (powerSeen && (S.best | 0) > oldBest && S.best >= 2) {
            const top = S.best > STAIRS.length ? SUMMIT.h : STAIRS[S.best - 1].h;
            showRecord(top, S.best > STAIRS.length);
            sfx('cheer');
            fireworks(P.pos, S.best > STAIRS.length ? 12 : 3, () => sfx('firework'));
        }
        refreshShop(); refreshModal();
        openDailyOnJoin();
    });
    room.onMessage('toast', (m) => toast(m.text, m.color));
    room.onMessage('offline', (m) => showOffline(m));
    room.onMessage('quest', (m) => { questDone(m); sfx('cheer'); confettiAt(P.pos.clone().add(new V3(0, 6, 0))); });
    room.onMessage('levelUp', (m) => {
        levelUp(m.from, m.to, m.jp);
        sfx('levelUp'); rumble(0.3, 150);
        ring(P.pos, 0x46ec50, 10, 0.8);
        sparkleColumn(P.pos, 0x7dff6b);
    });
    room.onMessage('wins', (m) => {
        refreshShop();
        showGoal(m.n, m.summit);
        sfx('cheer'); rumble(0.7, 500);
        // The pad already sent us to the lobby: celebrate there
        setTimeout(() => {
            confettiAt(P.pos.clone().add(new V3(0, 6, 0)));
            fireworks(P.pos, m.summit ? 10 : 5, () => sfx('firework'));
        }, 50);
    });
    room.onMessage('fx', () => {
        confettiAt(P.pos.clone().add(new V3(0, 6, 0)));
        sparkleColumn(P.pos, 0xffd028);
        sfx('buy');
    });
    room.onMessage('gem', (m) => {
        floatText('💎+' + fmt(m.n), '#c46aff', P.pos.clone().add(new V3(0, 10, 0)));
        popAcc = 0; popT = clockT;
    });
    room.onMessage('rebirthed', () => { ring(P.pos, 0xc46aff, 14, 1); sparkleColumn(P.pos, 0xc46aff); fireworks(P.pos, 6, () => sfx('firework')); });
    room.onMessage('boards', renderBoards);
    room.onLeave((code, reason) => {
        console.warn('[net] left room', code, reason || '');
        net.room = null;
        if (code !== 1000) $('#offline').hidden = false;
    });
    return room;
}

// =====================================================================================
// Camera & input
// =====================================================================================
const cam = { yaw: Math.PI, pitch: 0.3, dist: 26, target: new V3() };
let camSens = 1;
const keys = {};
const touchMove = { x: 0, y: 0 };
let touchJump = false, running = false;

addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') { if (e.key === 'Enter') e.target.blur(); return; }
    keys[e.code] = true;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.code === 'KeyE' && running) usePrompt();
    if (e.code === 'Escape') {
        if (!$('#daily').hidden) $('#daily').hidden = true;
        else if (!$('#offlinePop').hidden) $('#offlinePop').hidden = true;
        else if (!$('#modal').hidden) closeModal();
        else if (running && BX.isEmbedded()) BX.showPortalMenu();
    }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const drags = new Map();
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drags.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.focus(); });
canvas.addEventListener('pointermove', (e) => {
    const d = drags.get(e.pointerId);
    if (!d) return;
    const k = (e.pointerType === 'touch' ? 0.008 : 0.005) * camSens;
    cam.yaw -= (e.clientX - d.x) * k;
    cam.pitch = clamp(cam.pitch + (e.clientY - d.y) * k, -0.7, 1.4);
    d.x = e.clientX; d.y = e.clientY;
});
const endDrag = (e) => drags.delete(e.pointerId);
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist + Math.sign(e.deltaY) * 3, 10, 80); e.preventDefault(); }, { passive: false });

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
(function joystick() {
    const stick = $('#stick'), knob = $('#knob');
    let id = null;
    const set = (e) => {
        const r = stick.getBoundingClientRect();
        let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        const max = r.width / 2, l = Math.hypot(dx, dy);
        if (l > max) { dx *= max / l; dy *= max / l; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        touchMove.x = dx / max; touchMove.y = dy / max;
    };
    stick.addEventListener('pointerdown', (e) => { id = e.pointerId; stick.setPointerCapture(id); set(e); });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
    const end = (e) => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; touchMove.x = touchMove.y = 0; };
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
    const jb = $('#jumpBtn');
    jb.addEventListener('pointerdown', (e) => { e.preventDefault(); touchJump = true; });
    jb.addEventListener('pointerup', () => { touchJump = false; });
    jb.addEventListener('pointercancel', () => { touchJump = false; });
})();

function rayHit(o, d, maxT) {
    let best = maxT;
    for (const c of solids) {
        let t0 = 0, t1 = best, hit = true;
        for (const a of ['x', 'y', 'z']) {
            if (Math.abs(d[a]) < 1e-9) { if (o[a] < c.min[a] || o[a] > c.max[a]) { hit = false; break; } continue; }
            let ta = (c.min[a] - o[a]) / d[a], tb = (c.max[a] - o[a]) / d[a];
            if (ta > tb) { const q = ta; ta = tb; tb = q; }
            t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
            if (t0 > t1) { hit = false; break; }
        }
        if (hit && t0 > 0 && t0 < best) best = t0;
    }
    return best;
}
const camDir = new V3(), camPos = new V3(), lookTmp = new V3();
const ATTRACT_LOOK = new V3(0, 120, 300);
let intro = null, baseFov = camera.fov, camY = 0, camExtra = 0;
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
function updateCamera(dt) {
    if (!running) {
        const t = performance.now() / 1000;
        camera.position.set(Math.sin(t * 0.07) * 140, 70, Math.cos(t * 0.07) * 120 - 40);
        camera.lookAt(ATTRACT_LOOK);
        baseFov = camera.fov;
        return;
    }
    // Follow sideways tightly but vertically softly, so the bouncing doesn't shake the view;
    // the softer the higher the bounce
    const want = P.pos.y + 6;
    const big = Math.abs(want - camY) > 30;
    camY += (want - camY) * (1 - Math.exp(-dt * (big ? 6 : 3.2)));
    cam.target.x += (P.pos.x - cam.target.x) * (1 - Math.exp(-dt * 16));
    cam.target.z += (P.pos.z - cam.target.z) * (1 - Math.exp(-dt * 16));
    cam.target.y = camY;
    const cp = Math.cos(cam.pitch);
    camDir.set(Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), Math.cos(cam.yaw) * cp);
    // Pull the camera back a little on big, fast bounces so you can see where you'll land
    camExtra += ((Math.min(16, Math.max(0, Math.abs(P.vel.y) - 45) * 0.12)) - camExtra) * (1 - Math.exp(-dt * 2));
    const dist = Math.max(4, rayHit(cam.target, camDir, cam.dist + camExtra) - 0.8);
    camPos.copy(cam.target).addScaledVector(camDir, dist);
    if (camPos.y < CFG.waterY + 1.2 && P.pos.y > CFG.waterY) camPos.y = CFG.waterY + 1.2;
    if (intro) {
        intro.t += dt;
        const k = ease(Math.min(1, intro.t / intro.dur));
        camera.position.lerpVectors(intro.from, camPos, k);
        camera.lookAt(lookTmp.lerpVectors(ATTRACT_LOOK, cam.target, k));
        if (intro.t >= intro.dur) intro = null;
    } else {
        camera.position.copy(camPos);
        camera.lookAt(cam.target);
    }
    if (shake > 0.001) {
        const s = shake * shake * 0.9;
        camera.position.x += (Math.random() * 2 - 1) * s;
        camera.position.y += (Math.random() * 2 - 1) * s;
        shake = Math.max(0, shake - dt * 2.2);
    }
    // Field of view widens on fast bounces
    const fovBase = innerWidth < innerHeight ? 85 : 72;
    const vk = Math.min(10, Math.max(0, Math.abs(P.vel.y) - 50) * 0.08);
    const wantFov = fovBase + (reduceMotion ? 0 : vk);
    baseFov += (wantFov - baseFov) * Math.min(1, dt * 4);
    if (Math.abs(camera.fov - baseFov) > 0.01) { camera.fov = baseFov; camera.updateProjectionMatrix(); }
    sun.position.set(P.pos.x + 45, P.pos.y + 110, P.pos.z - 30);
    sun.target.position.copy(P.pos);
}

// Proximity prompts
let activePrompt = null;
const projV = new V3();
function updatePrompt() {
    let best = null, bd = Infinity;
    for (const p of prompts) {
        const d = p.pos.distanceTo(P.pos);
        if (d < p.r && d < bd) { bd = d; best = p; }
    }
    activePrompt = best;
    if (!best) { promptEl.hidden = true; return; }
    projV.copy(best.pos).setY(best.pos.y + 2).project(camera);
    if (projV.z > 1) { promptEl.hidden = true; return; }
    promptEl.hidden = false;
    promptEl.style.left = ((projV.x + 1) / 2 * innerWidth) + 'px';
    promptEl.style.top = ((1 - projV.y) / 2 * innerHeight) + 'px';
    const txt = best.label();
    if (promptTxtEl.textContent !== txt) promptTxtEl.textContent = txt;
    const key = usingPad() ? 'X' : 'E';
    if (promptKey.textContent !== key) promptKey.textContent = key;
}
function usePrompt() { if (activePrompt) activePrompt.act(); }
const promptKey = promptEl.querySelector('kbd');
const usingPad = () => pad.connected && performance.now() - pad.lastUsed < 8000;

// Controller buttons: popups and panels first, then gameplay shortcuts.
// In-game:  A full bounce · X Auto Bounce · Y Rewards · LB Rebirth · RB Trails · View Store ·
//           Menu Settings · D-pad up/down zoom · R3 camera behind you.
// In menus the D-pad or left stick moves, A picks, B closes.
const shown = (sel) => { const e = $(sel); return !!e && !e.hidden; };
const OVERLAYS = ['#start', '#offline', '#buy', '#offlinePop', '#daily', '#modal'];
function focusStep(container, dir) {
    const items = [...container.querySelectorAll('button:not(:disabled), input[type=range]')].filter((b) => b.offsetParent && !b.classList.contains('x'));
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[i < 0 ? 0 : (i + dir + items.length) % items.length];
    next.focus({ preventScroll: false });
    next.scrollIntoView({ block: 'nearest' });
}
let padJumpBlock = false;
function padButtons() {
    const p = new Set([...pad.pressed, ...pad.nav]);
    // A press that closed a menu shouldn't also bounce once the game is back
    if (padJumpBlock) { if (!pad.jump) padJumpBlock = false; else pad.jump = false; }
    if (!p.size) return;
    const overlay = OVERLAYS.find(shown);
    if (overlay) { pad.jump = false; padJumpBlock = true; }
    const ok = p.has('A'), back = p.has('B');
    if (overlay === '#start') { if ((ok || p.has('START')) && shown('#playBtn')) play(); return; }
    if (overlay === '#offline') { if (ok) $('#reconnectBtn').click(); return; }
    if (overlay === '#offlinePop') { if (ok || back) $('#offlineOk').click(); return; }
    if (overlay === '#daily') {
        if (ok && !$('#dailyClaim').disabled) $('#dailyClaim').click();
        else if (ok || back) $('#dailyClose').click();
        return;
    }
    if (overlay === '#buy') { if (ok) $('#buyOk').click(); else if (back) $('#buyCancel').click(); return; }
    if (overlay === '#modal') {
        const body = $('#modal');
        const el = document.activeElement;
        const onSlider = el && el.type === 'range' && body.contains(el);
        if (onSlider && (p.has('LEFT') || p.has('RIGHT'))) {
            el.value = Number(el.value) + (p.has('RIGHT') ? 5 : -5);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        if (p.has('DOWN') || p.has('RIGHT')) focusStep(body, 1);
        else if (p.has('UP') || p.has('LEFT')) focusStep(body, -1);
        else if (ok && el && body.contains(el) && el.tagName === 'BUTTON') el.click();
        else if (back || ['Y', 'LB', 'RB', 'BACK', 'START'].some((b) => p.has(b))) { closeModal(); canvas.focus(); }
        return;
    }
    if (!running) return;
    const open = (kind) => { openModal(kind); focusStep($('#modal'), 1); };
    if (p.has('X')) { if (activePrompt) usePrompt(); else setAutoBounce(!autoBounce); }
    if (p.has('Y')) open('free');
    if (p.has('LB')) open('rebirth');
    if (p.has('RB')) open('trails');
    if (p.has('BACK')) open('store');
    if (p.has('START')) open('settings');
    if (p.has('R3')) { cam.yaw = P.facing + Math.PI; cam.pitch = 0.3; }
    if (pad.pressed.has('UP')) cam.dist = clamp(cam.dist - 5, 10, 80);
    if (pad.pressed.has('DOWN')) cam.dist = clamp(cam.dist + 5, 10, 80);
}
onGamepadConnection((g, on) => {
    if (running) toast(on ? '🎮 Controller connected: ' + String(g.id || '').replace(/\s*\(.*$/, '').slice(0, 28) : '🎮 Controller disconnected', on ? '#7dff6b' : '#ffb51c');
});
promptEl.addEventListener('click', usePrompt);

// =====================================================================================
// Main update
// =====================================================================================
// Dev-only test input (the QA hook drives it); always zero in a real game
const botInput = { f: 0, r: 0, jump: false };
let qaJP = 0; // dev QA Jump Power override
let clockT = 0, hudT = 0, online = 1, jumpHeld = false;
const tmpF = new V3(), tmpR = new V3(), mv = new V3();
const trail = makeTrail(0xbfefff), trailAt = new V3();

function update(dt) {
    clockT += dt;
    const t = clockT;
    let f = botInput.f, r = botInput.r;
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyD || keys.ArrowRight) r += 1;
    if (keys.KeyA || keys.ArrowLeft) r -= 1;
    // While a menu is open the left stick moves through it instead of the player
    const menu = OVERLAYS.some(shown);
    const plx = menu ? 0 : pad.lx, ply = menu ? 0 : pad.ly;
    f -= touchMove.y + ply; r += touchMove.x + plx;
    cam.yaw -= pad.rx * 2.8 * dt;
    cam.pitch = clamp(cam.pitch + pad.ry * 1.8 * dt, -0.7, 1.4);
    // Controller: the camera eases round behind you while you move and leave the right stick alone
    if (usingPad() && Math.abs(pad.rx) < 0.05 && Math.hypot(plx, ply) > 0.3 && ply < 0.5) {
        cam.yaw = lerpAngle(cam.yaw, P.facing + Math.PI, 1 - Math.exp(-dt * 1.2));
    }
    tmpF.set(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    tmpR.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    mv.set(0, 0, 0).addScaledVector(tmpF, f).addScaledVector(tmpR, r);
    if (mv.lengthSq() > 1) mv.normalize();
    // Any movement input hands control back to the player (small dead zone for stick drift)
    if (autoBounce && (Math.abs(f) > 0.2 || Math.abs(r) > 0.2)) { setAutoBounce(false); toast('Auto Bounce OFF', '#c28cff'); }
    P.moving = mv.lengthSq() > 0.01;

    const jumpNow = !!(keys.Space || touchJump || pad.jump || botInput.jump) && !menu;
    const jumpPressed = jumpNow && !jumpHeld;
    jumpHeld = jumpNow;
    // Tapping jump in the air (or holding it) makes the next landing a full Jump Power bounce
    if (jumpPressed && !P.onGround) P.fullQueued = true;

    if (P.splashed > 0) {
        P.splashed -= dt;
        if (P.splashed <= 0) teleportLobby();
    } else {
        // Horizontal: responsive on the ground, a little floaty in the air
        const sp = CFG.moveSpeed, k = 1 - Math.exp(-dt * (P.onGround || P.contact > 0 ? 14 : 7));
        P.vel.x += (mv.x * sp - P.vel.x) * k;
        P.vel.z += (mv.z * sp - P.vel.z) * k;
        if (P.contact > 0) {
            // Squashing on the ground: the spring winds up, then fires
            P.contact -= dt;
            if (jumpPressed) P.contactFull = true;
            if (P.contact <= 0) launch();
        } else if (P.onGround && jumpPressed) {
            P.contactFull = true; P.contact = 0.04;
        }
        if (P.contact <= 0) P.vel.y -= G * dt;
        const vy = P.contact > 0 ? 0 : P.vel.y;
        const dist = Math.max(Math.abs(P.vel.x), Math.abs(P.vel.z), Math.abs(vy)) * dt;
        const n = Math.max(1, Math.ceil(dist / 0.6));
        const sdt = dt / n;
        const wasGround = P.onGround || P.contact > 0;
        const ground = P.ground;
        P.onGround = false;
        if (P.contact <= 0) P.ground = null;
        for (let i = 0; i < n; i++) {
            moveAxis('x', P.vel.x * sdt);
            moveAxis('z', P.vel.z * sdt);
            if (P.contact <= 0) moveAxis('y', vy * sdt);
        }
        if (P.contact > 0) {
            // Still on whatever we landed on? (walked off the edge mid-squash: just fall)
            P.ground = ground;
            const y0 = P.pos.y;
            moveAxis('y', -0.15);
            if (!P.onGround) { P.pos.y = y0 - 0.15; P.contact = 0; } else P.onGround = true;
        }
        if (P.onGround && !wasGround) landed();
        P.peakY = Math.max(P.peakY, P.pos.y);
        if (P.onGround || P.contact > 0) P.airTime = 0; else P.airTime += dt;
        if (P.moving) P.facing = lerpAngle(P.facing, Math.atan2(mv.x, mv.z), 1 - Math.exp(-dt * 12));

        // Into the sea (or out of the world): splash and back to the lobby
        if (P.pos.y < CFG.waterY) splashDown();
        for (const tr of triggers) {
            const inside = overlapsBox(tr, P.pos.x, P.pos.y, P.pos.z);
            if (inside && !tr.inside && tr.enter) tr.enter();
            tr.inside = inside;
        }
    }
    // Spring: squashed while in contact, overshoots a little after the launch
    const squashTarget = P.contact > 0 ? (P.contactFull || P.landTramp != null ? 1 : 0.65) : 0;
    P.compressV += ((squashTarget - P.compress) * 320 - P.compressV * 18) * dt;
    P.compress = clamp(P.compress + P.compressV * dt, -0.25, 1);

    if (S.name && S.name !== nameLabelText) { nameLabelText = S.name; headLabel.userData.set([{ t: S.name, c: '#ffffff', s: '#16121f', px: 56 }]); }
    updateEffects(dt);
    updateFx(dt);
    updateMaterials(dt);
    updateWorld(dt, t);
    for (const fn of tickers) fn(dt, t);

    online = syncRemotes(dt, t);
    // Friend list every 30 s, who of them is here every 5 s
    friendsT -= dt; friendSyncT -= dt;
    if (friendsT <= 0) { friendsT = 30; friendSyncT = 5; refreshFriends(); }
    else if (friendSyncT <= 0) { friendSyncT = 5; syncFriends(); }

    rig.position.copy(P.pos);
    playerAt.copy(P.pos);
    rig.rotation.y = P.facing;
    rig.visible = P.splashed <= 0;
    const air = !P.onGround && P.contact <= 0;
    animateBody(rig, dt, t, { moving: P.moving, air, compress: Math.max(0, P.compress) });
    // Trail streams behind you through the air
    const tr = trailById[S.trail] || trailById.Starter;
    trail.setColor(tr.id === 'Rainbow' ? -1 : tr.color);
    trailAt.set(-Math.sin(P.facing) * 1.2, 4, -Math.cos(P.facing) * 1.2).add(P.pos);
    trail.update(trailAt, rig.visible && (air || P.moving), dt);
    // Pogo particles from the tip
    const def = rig.userData.pogoDef;
    if (def && def.fx && rig.visible && t - P.lastFx > 0.05) { P.lastFx = t; pogoFx(P.pos, def.fx); }
    setSpeedLines(!reduceMotion && Math.abs(P.vel.y) > 90 ? Math.min(1, (Math.abs(P.vel.y) - 90) / 60) : 0, dt);

    updateGems(dt, t, P.pos, running && P.splashed <= 0 ? touchGem : null);
    updateBlob(P.pos, rig.visible && air);
    setMusicDuck(menu);
    setMusicIntensity(P.pos.y > 8 ? 1 : 0);
    // "Follow the beam" to the current objective
    const q = QUESTS[S.quest | 0];
    updateGuide(P.pos, q && running ? questTarget(q.to) : null, dt, t);

    sendMove(false);
    updatePrompt();
    animateCounters(dt);
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.1; updateHud({ jp: jumpPower(), step: stepAt(P.pos.x, P.pos.y, P.pos.z), y: P.pos.y }, online); refreshShop(); updateLobbySigns(); }
}

// =====================================================================================
// Boot
// =====================================================================================
let frameErrors = 0, lastFrame = 0, loadingSignaled = false, fpsAcc = 0, fpsFrames = 0, showFps = false;
function frame(now) {
    const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
    fpsAcc += (now - (lastFrame || now)) / 1000; fpsFrames++;
    if (fpsAcc >= 0.5) { if (showFps) $('#fps').textContent = Math.round(fpsFrames / fpsAcc) + ' FPS'; fpsAcc = 0; fpsFrames = 0; }
    lastFrame = now;
    if (!loadingSignaled) {
        // First frame after setup: apply portal settings and lift the Bloxity loading overlay
        loadingSignaled = true;
        BX.triggerAllSettings();
    }
    // one bad frame (a broken avatar item, say) must never stop the game: log it and keep going
    try {
        pollGamepad();
        padButtons();
        // Controller mode: button hints on the HUD and a visible focus ring in menus
        const padMode = usingPad();
        if (padMode !== document.body.classList.contains('pad')) { document.body.classList.toggle('pad', padMode); if (running) showTips(); }
        if (running) update(dt);
        else { updateWorld(dt, now / 1000); for (const fn of tickers) fn(dt, now / 1000); }
        updateCamera(dt);
        updateSky(camera.position, now / 1000);
        render();
    } catch (e) { if (frameErrors++ < 5) console.error('frame error', e); }
    requestAnimationFrame(frame);
}

// Straight into the game: no menu. Joins with the Bloxity name (or guest name) automatically.
let joining = false;
async function play() {
    if (joining || running) return;
    joining = true;
    const err = $('#connectErr'), retry = $('#playBtn');
    err.hidden = true; retry.hidden = true;
    $('#loading').hidden = false;
    $('#loading').textContent = 'Joining…';
    BX.loadingStep('Joining a server…');
    initAudio();
    try {
        await waitForLogin(1500);
        const saved = (storageGet('jpg_name') || '').slice(0, 20);
        // A hosted server can be asleep or still starting: retry the join (2, 4, 6, 8 s) before giving up
        let room = null;
        for (let attempt = 0; !room; attempt++) {
            try { room = await connect(BX.identity().loggedIn ? '' : saved); } catch (e) {
                if (attempt >= 4) throw e;
                console.warn('[join] attempt', attempt + 1, 'failed:', e && e.message);
                $('#loading').textContent = 'Waking up a server…';
                await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
            }
        }
        const me = room.state.players && room.state.players.get(room.sessionId);
        S.name = me ? me.name : S.name;
    } catch (e) {
        console.error(e);
        joining = false;
        $('#loading').hidden = true;
        err.hidden = false;
        err.textContent = 'Could not reach the game server. Check your connection and try again.';
        retry.hidden = false;
        BX.loadingEnd();
        return;
    }
    joining = false;
    intro = { t: 0, dur: 2.2, from: camera.position.clone() };
    running = true;
    startMusic();
    $('#start').hidden = true;
    $('#hud').hidden = false;
    $('#touch').hidden = !isTouch;
    if (!rig) buildPlayer(0, 0);
    teleportLobby();
    camY = P.pos.y + 6;
    showTips();
    toast('Every bounce = +Power! Hold SPACE for a big bounce!', '#7dff6b');
    canvas.focus();
    BX.loadingEnd();
}
// Embedded games get the Bloxity user from the portal handshake a moment after init
function waitForLogin(ms) {
    if (!BX.bloxity.ready || BX.identity().loggedIn) return Promise.resolve();
    return new Promise((res) => {
        const t0 = performance.now();
        (function check() { if (BX.identity().loggedIn || performance.now() - t0 > ms) res(); else setTimeout(check, 100); })();
    });
}
// Controls reminder for the first seconds of play
function showTips() {
    const el = $('#tips');
    const k = (key, what) => `<span><kbd>${key}</kbd>${what}</span>`;
    el.innerHTML = document.body.classList.contains('pad')
        ? k('L', 'Move') + k('A', 'Big bounce') + k('X', 'Auto Bounce') + k('Y', 'Rewards') + k('LB', 'Rebirth') + k('RB', 'Trails') + k('View', 'Store') + k('R', 'Camera')
        : isTouch
            ? '<span>Joystick to move · hold JUMP for big bounces · drag to look</span>'
            : k('WASD', 'Move') + k('Hold Space', 'Big bounce') + k('Drag', 'Camera') + k('Wheel', 'Zoom');
    el.hidden = false; el.style.opacity = 1;
    setTimeout(() => { el.style.opacity = 0; }, 9000);
    setTimeout(() => { el.hidden = true; }, 9900);
}
// Browsers only start audio after a user gesture
function unlockAudioOnGesture() {
    const unlock = () => { initAudio(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); removeEventListener('touchstart', unlock); };
    addEventListener('pointerdown', unlock); addEventListener('keydown', unlock); addEventListener('touchstart', unlock);
}

// Portal settings only apply when the game runs inside bloxity.io (standalone has its own panel)
function wirePortalSettings() {
    const embedded = (fn) => (v) => { if (BX.isEmbedded()) fn(v); };
    const pct = (v) => clamp((parseInt(v, 10) || 0) / 100, 0, 1);
    BX.listenSetting('master_volume', embedded((v) => setVolume('master', pct(v))));
    BX.listenSetting('music_volume', embedded((v) => setVolume('music', pct(v))));
    BX.listenSetting('graphics_quality', embedded((v) => setQuality(v === 'Low' ? 'low' : v === 'Medium' ? 'medium' : 'high')));
    BX.listenSetting('camera_sensitivity', embedded((v) => { camSens = clamp(parseFloat(v) || 1, 0.1, 5); }));
    BX.listenSetting('show_fps', (v) => { showFps = v === 'true'; $('#fps').hidden = !showFps; });
}
function wirePortalEvents() {
    BX.onPortalEvent((event, data) => {
        if (event === 'respawn_request') { if (running) teleportLobby(); }
        else if (event === 'chat_message_sent' && data) net.send('chat', { text: String(data) });
        else if (event === 'play_emote' && data) { playEmoteOn(localAvatar, String(data)); net.send('emote', { id: String(data) }); }
    });
    BX.onAvatarChanged(() => syncMyAvatar());
    BX.onProportionsChanged(() => syncMyAvatar());
}
// Account chip in the HUD
function showIdentity(id) {
    const avail = BX.bloxity.ready;
    $('#acct').hidden = !avail;
    if (!avail) return;
    const label = id.name || 'Guest';
    $('#acctName').textContent = label;
    const pfp = $('#acctPfp');
    pfp.hidden = !id.pfp;
    if (id.pfp) pfp.src = id.pfp;
}

async function boot() {
    BX.initBloxity();
    BX.loadingStep('Loading fonts…');
    try { await Promise.race([document.fonts.load('700 40px Fredoka'), new Promise((r) => setTimeout(r, 2500))]); } catch (e) { /* fallback font */ }
    BX.loadingStep('Building the Rainbow Stairs…');
    buildWorld();
    loadBase().catch(() => {}); // warm up the Bloxity body model
    wirePortalSettings();
    wirePortalEvents();
    BX.loadCatalogPrices().then((changed) => { if (changed) refreshShop(); });
    BX.onIdentity((id) => {
        showIdentity(id);
        // Logged in after joining: move this session onto the Bloxity profile
        if (net.room && id.loggedIn && id.token && !net.bloxity) net.send('auth', { token: id.token });
        if (net.room) { setupLocalAvatar(); syncMyAvatar(); }
    });
    $('#acctPfp').addEventListener('error', (e) => { e.target.hidden = true; });
    $('#playBtn').addEventListener('click', play);
    $('#reconnectBtn').addEventListener('click', () => location.reload());
    unlockAudioOnGesture();
    requestAnimationFrame(frame);
    play();
}
boot();

// Dev-only hooks for automated QA runs (stripped from production builds)
if (import.meta.env.DEV) {
    window.__qa = {
        input: (o) => Object.assign(botInput, o), solids, cam,
        P, S, STAIRS, SUMMIT, LOBBY, avatarStats, scene, net, buy, PASSES,
        teleport: (x, y, z) => teleport(new V3(x, y, z), 0),
        jp: (n) => { qaJP = n; }, renderer, setQuality,
        perf: () => { renderer.info.autoReset = false; renderer.info.reset(); renderer.render(scene, camera); const r = { ...renderer.info.render }; renderer.info.autoReset = true; return {
            calls: r.calls, tris: r.triangles, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, progs: renderer.info.programs.length, solids: solids.length, triggers: triggers.length, objects: scene.children.length }; },
        look: (yaw, pitch, dist) => { cam.yaw = yaw; cam.pitch = pitch; cam.dist = dist; },
        state: () => ({ x: P.pos.x, y: P.pos.y, z: P.pos.z, vy: P.vel.y, ground: P.onGround, step: stepAt(P.pos.x, P.pos.y, P.pos.z), wins: S.wins, level: S.level, power: S.power, pogo: S.pogo, quest: S.quest, best: S.best, rebirths: S.rebirths, jp: jumpPower() }),
    };
}
