// Character animation copied from Bloxity's top games: the PlayerAnimator of +1 Fast Keyboard
// Escape (walk / run / sprint cycle, idle breathing, jump crouch, rise and fall, landing squash,
// a lean into turns, a fall-over when dying) plus the air-jump backflip of +1 High Jump Power
// Escape. The run cycle is locked to the ground speed (stride length), knees and elbows bend,
// the torso leans, twists and rolls with the step and the head counter-twists; every state change
// is cross-faded. A pose is a rotation about the character's own axes (x pitch, y yaw, z roll) for
// each bone, so the same numbers work whatever a bone's rest orientation.
//
// The avatar feeds it from what it sees: its own ground speed, climb / fall speed and turning,
// measured from frame to frame, so local and remote players animate the same without the game
// sending anything new. A game's own poses (riding, climbing, sitting in a kart...) fade in over it.
import * as THREE from 'three';

const D = Math.PI / 180;
const deg = (def) => { const o = {}; for (const k in def) o[k] = { x: (def[k].x || 0) * D, y: (def[k].y || 0) * D, z: (def[k].z || 0) * D }; return o; };
const tier = (walk, run, sprint) => ({ walk: walk * D, run: run * D, sprint: sprint * D });

export const POSE_BONES = ['Rig1', 'Spine1', 'Spine2', 'Neck1', 'ArmL1', 'ArmL2', 'ArmR1', 'ArmR2', 'LegL1', 'LegL2', 'LegR1', 'LegR2'];
const IDX = Object.fromEntries(POSE_BONES.map((n, i) => [n, i]));
const N = POSE_BONES.length;

// The reference character is 3.2 units tall: speeds and distances below are in its units and
// scaled to ours, so the steps land the same on a taller body.
const REF_H = 3.2;
const LOCO = {
    minFrequency: 0.7, maxFrequency: 3.4, strideDistance: 5.2, idleSpeed: 0.6, walkSpeed: 4, runSpeed: 15, sprintSpeed: 27,
    hipSwing: tier(22, 40, 58), kneeBend: tier(30, 58, 74), armSwing: tier(18, 38, 60), elbowBend: tier(14, 46, 74),
    torsoTwist: tier(4, 7, 9), torsoLean: tier(3, 11, 24), headCounterTwist: tier(2, 4, 5), torsoRoll: tier(2, 3, 3),
    bob: { walk: 0.05, run: 0.11, sprint: 0.16 }, bankAngle: 9 * D,
};
const IDLE = { breathFrequency: 0.35, breathAmount: 1.8 * D, breathBob: 0.012, basePose: deg({ ArmL1: { x: 4, z: 6 }, ArmR1: { x: 4, z: -6 }, ArmL2: { x: 10 }, ArmR2: { x: 10 } }) };
const JUMP = { duration: 0.1, bobY: -0.18, pose: deg({ LegL1: { x: -30 }, LegR1: { x: -30 }, LegL2: { x: 46 }, LegR2: { x: 46 }, ArmL1: { x: -70, z: 14 }, ArmR1: { x: -70, z: -14 }, Spine1: { x: 8 } }) };
const AIR = {
    velocityReference: 14,
    rise: deg({ LegL1: { x: -42 }, LegR1: { x: 12 }, LegL2: { x: 66 }, LegR2: { x: 24 }, ArmL1: { x: -120, z: 22 }, ArmR1: { x: -120, z: -22 }, ArmL2: { x: 20 }, ArmR2: { x: 20 }, Spine1: { x: -6 }, Neck1: { x: -8 } }),
    fall: deg({ LegL1: { x: 14 }, LegR1: { x: -8 }, LegL2: { x: 30 }, LegR2: { x: 20 }, ArmL1: { x: -40, z: 48 }, ArmR1: { x: -40, z: -48 }, ArmL2: { x: 30 }, ArmR2: { x: 30 }, Spine1: { x: 10 }, Neck1: { x: 6 } }),
};
const LAND = { duration: 0.16, bobY: -0.32, pose: deg({ LegL1: { x: -34 }, LegR1: { x: -34 }, LegL2: { x: 58 }, LegR2: { x: 58 }, ArmL1: { x: -18, z: 20 }, ArmR1: { x: -18, z: -20 }, Spine1: { x: 14 } }) };
const DEATH = { duration: 0.55, roll: 88 * D, pitch: 18 * D, drop: 0.9, pose: deg({ ArmL1: { x: -80, z: 30 }, ArmR1: { x: -80, z: -30 }, LegL1: { x: -20 }, LegR1: { x: 10 }, Spine1: { x: 10 }, Neck1: { x: -12 } }) };
const FLIP = {
    rotationDuration: 0.42, abortDuration: 0.14, tuckAsymmetry: 6 * D,
    tuckPose: deg({ Spine1: { x: 34 }, Spine2: { x: 20 }, Neck1: { x: -16 }, LegL1: { x: -84 }, LegR1: { x: -84 }, LegL2: { x: 112 }, LegR2: { x: 112 }, ArmL1: { x: 46, z: -26 }, ArmR1: { x: 46, z: 26 }, ArmL2: { x: 78 }, ArmR2: { x: 78 } }),
};
const BLEND = { toLocomotion: 0.14, toJumpStart: 0.05, toAirborne: 0.16, toLanding: 0.06, toDeath: 0.12, toBackflip: 0.06, toSpecial: 0.12 };
const AIR_RATE = 0.8; // jump / air / landing states play at this speed (the reference's playbackRate)
const AIR_STATES = new Set(['jumpStart', 'airborne', 'landing', 'backflip']);
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const step = (a, b, v) => { const t = clamp((v - a) / (b - a || 1), 0, 1); return t * t * (3 - 2 * t); };
const knee = (p) => { const s = Math.sin(p - Math.PI / 2.6); return s > 0 ? s * s : 0; };

class Pose {
    constructor() { this.r = new Float32Array(N * 3); this.bobY = 0; }
    reset() { this.r.fill(0); this.bobY = 0; return this; }
    set(b, x, y = 0, z = 0) { const i = IDX[b] * 3; this.r[i] = x; this.r[i + 1] = y; this.r[i + 2] = z; }
    add(b, x, y = 0, z = 0) { const i = IDX[b] * 3; this.r[i] += x; this.r[i + 1] += y; this.r[i + 2] += z; }
    copy(p) { this.r.set(p.r); this.bobY = p.bobY; return this; }
    lerp(a, b, t) { for (let i = 0; i < this.r.length; i++) this.r[i] = a.r[i] + (b.r[i] - a.r[i]) * t; this.bobY = a.bobY + (b.bobY - a.bobY) * t; return this; }
    def(d, w = 1) { this.reset(); return this.blend(d, w); }
    blend(d, w = 1) { for (const k in d) this.add(k, d[k].x * w, d[k].y * w, d[k].z * w); return this; }
}

// Stride-locked walk / run / sprint cycle
const FOOTFALLS = [0.3 * Math.PI, 1.3 * Math.PI];
class Locomotion {
    constructor() { this.phase = 0; this.sprintWeight = 0; this.footfalls = 0; }
    runBlend(speed, mult) { const m = Math.max(1, mult); return step(LOCO.walkSpeed * m, LOCO.runSpeed * m, speed); }
    advance(dt, speed, mult, sprinting) {
        const m = Math.max(1, mult), f = clamp(speed / LOCO.strideDistance, LOCO.minFrequency, LOCO.maxFrequency);
        const a = this.phase, b = a + f * TAU * dt;
        for (const d of FOOTFALLS) if ((a < d && b >= d) || (a < d + TAU && b >= d + TAU)) this.footfalls++;
        this.phase = b % TAU;
        const s = step(LOCO.runSpeed * m, LOCO.sprintSpeed * m, speed), want = sprinting ? Math.max(0.6, s) : s * 0.4;
        this.sprintWeight += (want - this.sprintWeight) * (1 - Math.exp(-7 * dt));
    }
    settle(dt) {
        const to = this.phase > Math.PI ? TAU : 0;
        this.phase += (to - this.phase) * (1 - Math.exp(-8 * dt));
        if (this.phase >= TAU - 1e-4) this.phase = 0;
        this.sprintWeight *= Math.exp(-6 * dt);
    }
    write(p, speed, mult) {
        const n = this.runBlend(speed, mult), o = this.sprintWeight, r = this.phase;
        const a = (v) => mix(mix(v.walk, v.run, n), v.sprint, o);
        const hip = a(LOCO.hipSwing), kn = a(LOCO.kneeBend), arm = a(LOCO.armSwing), elb = a(LOCO.elbowBend), tw = a(LOCO.torsoTwist),
            lean = a(LOCO.torsoLean), head = a(LOCO.headCounterTwist), roll = a(LOCO.torsoRoll), bob = a(LOCO.bob);
        const s = Math.sin(r), c = -s, x = 1 + o * 0.35;
        p.reset();
        p.set('LegL1', hip * (s > 0 ? s : s * x)); p.set('LegR1', hip * (c > 0 ? c : c * x));
        p.set('LegL2', kn * knee(r)); p.set('LegR2', kn * knee(r + Math.PI));
        p.set('ArmL1', arm * c - o * 0.25, 0, o * 0.12); p.set('ArmR1', arm * s - o * 0.25, 0, -o * 0.12);
        p.set('ArmL2', elb + elb * 0.35 * Math.max(0, c)); p.set('ArmR2', elb + elb * 0.35 * Math.max(0, s));
        p.set('Spine1', lean, tw * c, roll * Math.sin(r * 2)); p.set('Spine2', lean * 0.4, tw * 0.5 * c, 0);
        p.set('Neck1', -lean * 0.7, head * s, 0);
        p.bobY = -bob * Math.cos(r * 2);
    }
}

// Forward flips on an air jump (+1 High Jump Power Escape)
const bounce = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
class Backflip {
    constructor() { this.reset(); }
    reset() { this.angle = 0; this.target = 0; this.active = false; this.aborting = false; this.abortT = 0; this.from = 0; this.to = 0; }
    get rotation() { if (!this.active) return 0; const t = this.angle % TAU; return t < 0 ? t + TAU : t; }
    get tuck() {
        if (!this.active) return 0;
        if (this.aborting) return Math.sin(clamp(1 - this.abortT / FLIP.abortDuration, 0, 1) * Math.PI);
        return Math.sin((this.rotation / TAU) * Math.PI);
    }
    request() {
        if (this.aborting) { this.aborting = false; this.target = Math.ceil(this.angle / TAU) * TAU; }
        if (!this.active) { this.active = true; this.angle = 0; this.target = TAU; return; }
        this.target += TAU;
    }
    update(dt) {
        if (!this.active) return false;
        if (this.aborting) {
            this.abortT += dt;
            const s = clamp(this.abortT / FLIP.abortDuration, 0, 1);
            this.angle = this.from + (this.to - this.from) * bounce(s);
            if (s >= 1) { this.reset(); return true; }
            return false;
        }
        this.angle = Math.min(this.angle + (TAU / FLIP.rotationDuration) * dt, this.target);
        if (this.angle >= this.target) { this.reset(); return true; }
        return false;
    }
    abort() { if (!this.active || this.aborting) return; this.aborting = true; this.abortT = 0; this.from = this.angle; this.to = Math.round(this.angle / TAU) * TAU; }
}

export class Animator {
    constructor() {
        this.loco = new Locomotion(); this.flip = new Backflip();
        this.target = new Pose(); this.from = new Pose(); this.output = new Pose();
        this.state = 'idle'; this.stateTime = 0; this.blendTime = 0; this.blendDuration = 0;
        this.idleTime = 0; this.wasGrounded = true; this.airWeight = 1; this.bank = 0; this.specialW = 0;
    }
    reset() {
        this.flip.reset(); this.state = 'idle'; this.stateTime = 0; this.blendDuration = 0; this.wasGrounded = true;
        this.airWeight = 1; this.bank = 0; this.specialW = 0; this.target.reset(); this.from.reset(); this.output.reset();
    }
    // inp: { grounded, speed, mult, vy, sprinting, turn, jumped, airJumped, landed, dying, special } in reference units
    update(dt, inp) {
        const s = Math.max(0, Math.min(dt, 0.1)), n = s * AIR_RATE;
        this.stateTime += AIR_STATES.has(this.state) ? n : s;
        const flipDone = this.flip.update(n);
        this.resolve(inp, flipDone);
        this.write(s, n, inp);
        const t = AIR_STATES.has(this.state) ? n : s;
        if (this.blendDuration > 0) {
            this.blendTime += t;
            const k = clamp(this.blendTime / this.blendDuration, 0, 1);
            this.output.lerp(this.from, this.target, smooth(k));
            if (k >= 1) this.blendDuration = 0;
        } else this.output.copy(this.target);
        const lean = this.state === 'run' ? (inp.turn || 0) * LOCO.bankAngle * (0.6 + this.loco.sprintWeight * 0.8) : 0;
        this.bank += (lean - this.bank) * (1 - Math.exp(-8 * s));
        this.specialW = this.state === 'special' ? Math.min(1, this.specialW + s / BLEND.toSpecial) : Math.max(0, this.specialW - s / BLEND.toLocomotion);
    }
    resolve(e, flipDone) {
        if (e.dying) { this.go('dying', BLEND.toDeath); return; }
        if (this.state === 'dying') this.go('idle', BLEND.toLocomotion);
        if (e.special) { if (this.flip.active) this.flip.reset(); this.wasGrounded = e.grounded; this.go('special', BLEND.toSpecial); return; }
        if (e.landed || (e.grounded && !this.wasGrounded)) {
            if (this.flip.active) this.flip.abort();
            this.wasGrounded = true;
            if (e.landed !== false) { this.go('landing', BLEND.toLanding); return; }
        }
        this.wasGrounded = e.grounded;
        if (e.airJumped) { this.flip.request(); this.go('backflip', BLEND.toBackflip, true); return; }
        if (e.jumped) { this.airWeight = 1; this.go('jumpStart', BLEND.toJumpStart); return; }
        if (this.flip.active) return;
        if (!e.grounded) {
            if (this.state === 'jumpStart' && this.stateTime < JUMP.duration && !flipDone) return;
            this.go('airborne', BLEND.toAirborne);
            return;
        }
        if (this.state === 'landing' && this.stateTime < LAND.duration) return;
        this.go(e.speed < LOCO.idleSpeed ? 'idle' : 'run', BLEND.toLocomotion);
    }
    go(state, blend, again) {
        if (state === this.state && !again) return;
        this.from.copy(this.output);
        this.state = state; this.stateTime = 0; this.blendTime = 0; this.blendDuration = blend;
    }
    write(s, n, e) {
        const p = this.target;
        switch (this.state) {
            case 'idle': {
                this.loco.settle(s);
                this.idleTime += s;
                const b = Math.sin(this.idleTime * IDLE.breathFrequency * TAU);
                p.def(IDLE.basePose);
                p.add('Spine1', b * IDLE.breathAmount); p.add('Neck1', -b * IDLE.breathAmount * 0.6);
                p.bobY = b * IDLE.breathBob;
                break;
            }
            case 'run': this.loco.advance(s, e.speed, e.mult, e.sprinting); this.loco.write(p, e.speed, e.mult); break;
            case 'jumpStart': p.def(JUMP.pose); p.bobY = JUMP.bobY; break;
            case 'airborne': this.writeAir(n, e.vy); break;
            case 'landing': { const k = 1 - smooth(clamp(this.stateTime / LAND.duration, 0, 1)); p.def(LAND.pose, k); p.bobY = LAND.bobY * k; break; }
            case 'backflip': {
                const k = this.flip.tuck;
                this.writeAir(n, e.vy);
                p.blend(FLIP.tuckPose, k);
                const a = FLIP.tuckAsymmetry * k;
                p.add('LegL1', a); p.add('LegR1', -a); p.bobY = 0;
                if (!this.flip.active) this.go('airborne', BLEND.toAirborne);
                break;
            }
            case 'dying': p.def(DEATH.pose); break;
            default: p.reset(); // a game pose ('special') draws the body itself
        }
    }
    writeAir(n, vy) {
        const k = (clamp(vy / AIR.velocityReference, -1, 1) + 1) * 0.5;
        this.airWeight += (k - this.airWeight) * (1 - Math.exp(-9 * n));
        this.target.def(AIR.fall, 1 - this.airWeight).blend(AIR.rise, this.airWeight);
        this.target.bobY = 0;
    }
    get deathK() { return this.state === 'dying' ? smooth(clamp(this.stateTime / DEATH.duration, 0, 1)) : 0; }
    get flipAngle() { return this.flip.rotation; }
}

const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qm = new THREE.Quaternion(), qp = new THREE.Quaternion();
const eu = new THREE.Euler(), vp = new THREE.Vector3();

// Drives one Bloxity avatar (avatar.js BloxAvatar): binds the pose bones in the rest pose, senses
// the avatar's motion, runs the Animator and lays the pose, the game's own pose and the bob /
// lean / flip / fall-over onto the bones and the model.
export class AvatarMotion {
    constructor(bones, model, height) {
        this.k = height / REF_H; // our units per reference unit
        this.height = height;
        this.anim = new Animator();
        this.bind = [];
        model.updateMatrixWorld(true);
        model.getWorldQuaternion(qm);
        const inv = qm.clone().invert();
        for (let i = 0; i < N; i++) {
            const b = bones[POSE_BONES[i]];
            if (!b) { this.bind.push(null); continue; }
            if (b.parent) b.parent.getWorldQuaternion(qp); else qp.identity();
            const toParent = inv.clone().multiply(qp).invert();
            this.bind.push({ bone: b, x: AX.clone().applyQuaternion(toParent).normalize(), y: AY.clone().applyQuaternion(toParent).normalize(), z: AZ.clone().applyQuaternion(toParent).normalize() });
        }
        this.seen = false; this.px = 0; this.py = 0; this.pz = 0; this.pyaw = 0;
        this.hs = 0; this.vy = 0; this.vyRaw = 0; this.turn = 0; this.airT = 0; this.wasAir = false; this.jumpChecked = true;
        this.inp = { grounded: true, speed: 0, mult: 1, vy: 0, sprinting: false, turn: 0, jumped: false, airJumped: false, landed: false, dying: false, special: false };
    }
    get state() { return this.anim.state; }
    reset() { this.anim.reset(); this.seen = false; }

    // where the avatar is in the world (its root's last rendered matrix): speed, climb and turn rate
    sense(root, dt) {
        const m = root.matrixWorld.elements, x = m[12], y = m[13], z = m[14], yaw = Math.atan2(m[8], m[10]);
        if (!this.seen || dt <= 0) { this.seen = true; this.px = x; this.py = y; this.pz = z; this.pyaw = yaw; return; }
        const dx = x - this.px, dy = y - this.py, dz = z - this.pz, d = Math.hypot(dx, dy, dz);
        let dyaw = yaw - this.pyaw;
        while (dyaw > Math.PI) dyaw -= TAU;
        while (dyaw < -Math.PI) dyaw += TAU;
        this.px = x; this.py = y; this.pz = z; this.pyaw = yaw;
        if (d > Math.max(8, 90 * dt)) { this.hs = 0; this.vy = 0; this.vyRaw = 0; return; } // teleported
        const hs = Math.hypot(dx, dz) / dt;
        this.vyRaw = dy / dt;
        this.hs += (hs - this.hs) * (1 - Math.exp(-12 * dt));
        this.vy += (this.vyRaw - this.vy) * (1 - Math.exp(-16 * dt));
        // turning right (clockwise from above) is +1 and leans the body into the turn
        const tr = clamp(-dyaw / dt / 6, -1, 1);
        this.turn += (tr - this.turn) * (1 - Math.exp(-10 * dt));
    }

    // st: the avatar's update state ({ moving, air, hspeed?, vy?, jump?, airJump?, dying?, sprint? });
    // special: the game draws its own pose this frame; spec: { boneName: [rx, rz] } that pose;
    // hold: the right arm holds a tool (the game poses it); emoteW: how much an emote shows
    apply(avatar, dt, st, special, spec, hold, emoteW) {
        this.sense(avatar.root, dt);
        const k = this.k, inp = this.inp, air = !!st.air;
        // a jump is told apart from walking off a ledge by the first climb speed in the air
        if (air && !this.wasAir) { this.airT = 0; this.jumpChecked = false; }
        if (air) this.airT += dt;
        const vy = (st.vy ?? this.vy) / k;
        inp.jumped = false;
        if (air && !this.jumpChecked) {
            const up = st.vy ?? this.vyRaw;
            if (st.jump || up > 1.5 * k) { inp.jumped = true; this.jumpChecked = true; }
            else if (this.airT > 0.06) this.jumpChecked = true;
        }
        inp.grounded = !air || (!this.jumpChecked && !inp.jumped); // undecided: stay on the ground pose a moment
        inp.landed = !air && this.wasAir ? this.airT > 0.12 : undefined;
        if (!air && this.wasAir && !inp.landed) inp.landed = false;
        this.wasAir = air;
        const hs = st.moving ? (st.hspeed ?? this.hs) : 0;
        inp.speed = hs / k;
        inp.mult = Math.max(1, inp.speed / 12);
        inp.vy = vy;
        inp.sprinting = !!st.sprint;
        inp.turn = this.turn;
        inp.airJumped = !!st.airJump;
        inp.dying = !!st.dying;
        inp.special = !!special;
        this.anim.update(dt, inp);
        const a = this.anim, out = a.output.r, w = (1 - a.specialW) * (1 - (emoteW || 0));
        // the game's own pose, faded in over the animation
        if (spec) {
            for (const name in spec) {
                const v = spec[name], bone = avatar.bones[name];
                if (!bone || (!v[0] && !v[1])) continue;
                const sw = hold && name === 'ArmR_Offset' ? 1 : a.specialW;
                if (sw > 0) bone.quaternion.multiply(qa.setFromEuler(eu.set(v[0] * sw, 0, v[1] * sw, 'XYZ')));
            }
        }
        if (w > 0.001) {
            for (let i = 0; i < N; i++) {
                const b = this.bind[i];
                if (!b) continue;
                if (hold && (i === IDX.ArmR1 || i === IDX.ArmR2)) continue;
                const x = out[i * 3] * w, y = out[i * 3 + 1] * w, z = out[i * 3 + 2] * w;
                if (Math.abs(x) < 1e-5 && Math.abs(y) < 1e-5 && Math.abs(z) < 1e-5) continue;
                qa.setFromAxisAngle(b.x, x);
                if (Math.abs(y) >= 1e-5) qa.premultiply(qb.setFromAxisAngle(b.y, y));
                if (Math.abs(z) >= 1e-5) qa.premultiply(qb.setFromAxisAngle(b.z, z));
                b.bone.quaternion.premultiply(qa);
            }
        }
        // the whole body: step bob, lean into turns, the flip and the fall-over
        const model = avatar.model, dk = a.deathK, fa = a.flipAngle;
        model.position.y += a.output.bobY * k * w - DEATH.drop * k * dk;
        if (fa || dk || Math.abs(a.bank) > 1e-4) {
            model.rotation.set(DEATH.pitch * dk, 0, a.bank * w + DEATH.roll * dk);
            if (fa) {
                // spin around the middle of the body
                const pivot = this.height * 0.5;
                qa.setFromAxisAngle(AX, -fa);
                model.quaternion.premultiply(qa);
                vp.set(0, model.position.y - pivot, 0).applyQuaternion(qa);
                model.position.set(vp.x, vp.y + pivot, vp.z);
            }
        } else if (model.rotation.x || model.rotation.z || model.position.x || model.position.z) {
            model.rotation.set(0, 0, 0); model.position.x = 0; model.position.z = 0;
        }
    }
}
