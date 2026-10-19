// Bloxity character system: the standard player.glb body with the player's
// equipped cosmetics and proportions, animated for running/jumping and emotes.
// Patterns follow the reference test game (bloxity.io/test-game.html) and the SDK docs.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { T, V3 } from './engine.js';
import { AvatarMotion } from './animator.js';

export const AVATAR_CDN = 'https://static.bloxity.io/avatars';
const API = 'https://api.bloxity.io';
const TARGET_HEIGHT = 5.4; // studs, same as the blocky rig

const PART_MESH_NAMES = {
    head: 'default_head', arm_L: 'default_arm_L', arm_R: 'default_arm_R',
    leg_L: 'default_leg_L', leg_R: 'default_leg_R', torso: 'default_torso',
};
const PART_INFO = {
    head: { dir: 'head', suffix: '', key: 'headId' },
    arm_L: { dir: 'arms', suffix: '_L', key: 'armLId' },
    arm_R: { dir: 'arms', suffix: '_R', key: 'armRId' },
    leg_L: { dir: 'legs', suffix: '_L', key: 'legLId' },
    leg_R: { dir: 'legs', suffix: '_R', key: 'legRId' },
    torso: { dir: 'torso', suffix: '', key: 'torsoId' },
};
// Accessories authored in the body's rest pose: bone + origin
const ACCESSORIES = {
    neckId: { slot: 'neck', bone: 'Spine2', origin: [0, 4.8, 0] },
    chestId: { slot: 'chest', bone: 'Spine2', origin: [0, 3.6, 0] },
    waistId: { slot: 'waist', bone: 'Spine1', origin: [0, 2.4, 0] },
};
const PAIRS = {
    handId: { slot: 'hand', bones: ['ArmL2_leaf', 'ArmR2_leaf'] },
    shoesId: { slot: 'shoes', bones: ['LegL2_leaf', 'LegR2_leaf'] },
};
const AVATAR_KEYS = ['hatId', 'backId', 'skinId', 'headId', 'armLId', 'armRId', 'legLId', 'legRId', 'torsoId',
    'hairId', 'maskId', 'neckId', 'chestId', 'waistId', 'handId', 'shoesId', 'faceId', 'pantsId', 'shirtId'];

export const isEquipped = (id) => id !== undefined && id !== null && id !== '' && id !== '-1' && id !== 'undefined';

// Compact avatar description to sync to other players (only real ids)
export function packAvatar(av) {
    if (!av) return '';
    const e = {};
    for (const k of AVATAR_KEYS) if (isEquipped(av[k])) e[k] = String(av[k]).slice(0, 40);
    const p = {};
    const src = av.proportions || {};
    for (const k of ['height', 'shoulderWidth', 'armLength', 'legOffsetX', 'torsoScaleX', 'neckHeight', 'headScale']) {
        if (typeof src[k] === 'number' && Number.isFinite(src[k]) && src[k] !== 1) p[k] = Math.round(src[k] * 100) / 100;
    }
    return JSON.stringify({ e, p });
}
export function unpackAvatar(s) {
    try { const o = JSON.parse(s); return { ...(o.e || {}), proportions: o.p || {} }; } catch (e) { return null; }
}
// Skin with face/shirt/pants drawn on (API route works for any player)
export function skinUrlFor(eq) {
    const extra = (isEquipped(eq.pantsId) ? `_pn${eq.pantsId}` : '') + (isEquipped(eq.shirtId) ? `_sh${eq.shirtId}` : '') + (isEquipped(eq.faceId) ? `_fc${eq.faceId}` : '');
    const skin = isEquipped(eq.skinId) ? eq.skinId : '0';
    return extra ? `${API}/v1/avatar/skin-texture/s${skin}${extra}.png` : `${AVATAR_CDN}/skins/${skin}.png`;
}

// ----- shared asset caches -----
let basePromise = null;
export function loadBase() {
    if (!basePromise) basePromise = new Promise((res, rej) => new GLTFLoader().load(`${AVATAR_CDN}/player.glb`, res, undefined, rej));
    return basePromise;
}
const texCache = new Map();
function pixelTexture(url, flipY) {
    const key = url + (flipY === false ? '|nf' : '');
    if (!texCache.has(key)) {
        texCache.set(key, new Promise((res) => new T.TextureLoader().load(url, (t) => {
            if (flipY === false) t.flipY = false;
            t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter; t.colorSpace = T.SRGBColorSpace; t.needsUpdate = true;
            res(t);
        }, undefined, () => res(null))));
    }
    return texCache.get(key);
}
const objCache = new Map();
function loadObj(slotDir, texDir, id) {
    const key = slotDir + '/' + id;
    if (!objCache.has(key)) {
        objCache.set(key, Promise.all([
            new Promise((res) => new OBJLoader().load(`${AVATAR_CDN}/items/${slotDir}/${id}.obj`, res, undefined, () => res(null))),
            pixelTexture(`${AVATAR_CDN}/textures/${texDir}/${id}.png`),
        ]));
    }
    return objCache.get(key).then(([obj, tex]) => {
        if (!obj) return null;
        const o = obj.clone(true);
        o.traverse((c) => { if (c.isMesh) { c.material = new T.MeshLambertMaterial({ map: tex }); c.castShadow = true; } });
        return o;
    });
}
const partCache = new Map();
function loadPart(info, id) {
    const key = info.dir + '/' + id + info.suffix;
    if (!partCache.has(key)) {
        partCache.set(key, new Promise((res) => new GLTFLoader().load(`${AVATAR_CDN}/parts/${info.dir}/${id}${info.suffix}.glb`, res, undefined, () => res(null))));
    }
    return partCache.get(key);
}

// A rigid part's geometry with every vertex bound to the bone the original part mostly follows
export function rigidToSkinned(geo, orig) {
    const g = geo.clone(), si = orig && orig.getAttribute('skinIndex'), sw = orig && orig.getAttribute('skinWeight');
    const weight = new Map();
    if (si && sw) for (let i = 0; i < si.count; i++) weight.set(si.getX(i), (weight.get(si.getX(i)) || 0) + sw.getX(i));
    let bone = 0, best = -1;
    for (const [b, w] of weight) if (w > best) { best = w; bone = b; }
    const n = g.attributes.position.count, idx = new Uint16Array(n * 4), w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { idx[i * 4] = bone; w[i * 4] = 1; }
    g.setAttribute('skinIndex', new T.Uint16BufferAttribute(idx, 4));
    g.setAttribute('skinWeight', new T.Float32BufferAttribute(w, 4));
    return g;
}

// A body part's geometry with only what it draws with, in fixed array types: parts from different
// files store joints and weights differently, and merging them needs them all alike
const GET = ['getX', 'getY', 'getZ', 'getW'];
function bodyPartGeo(g) {
    const n = g.attributes.position.count, out = new T.BufferGeometry();
    const put = (name, size, Arr, src, fill) => {
        const a = new Arr(n * size);
        if (src) for (let k = 0; k < size; k++) { const get = src[GET[k]].bind(src); for (let i = 0; i < n; i++) a[i * size + k] = get(i); }
        else for (let i = 0; i < n; i++) a.set(fill, i * size);
        out.setAttribute(name, new T.BufferAttribute(a, size));
    };
    if (!g.attributes.normal) { g = g.clone(); g.computeVertexNormals(); }
    put('position', 3, Float32Array, g.attributes.position);
    put('normal', 3, Float32Array, g.attributes.normal);
    put('uv', 2, Float32Array, g.attributes.uv, [0, 0]);
    put('skinIndex', 4, Uint16Array, g.attributes.skinIndex, [0, 0, 0, 0]);
    put('skinWeight', 4, Float32Array, g.attributes.skinWeight, [1, 0, 0, 0]);
    const idx = new Uint32Array(g.index ? g.index.count : n);
    for (let i = 0; i < idx.length; i++) idx[i] = g.index ? g.index.getX(i) : i;
    out.setIndex(new T.BufferAttribute(idx, 1));
    return out;
}

// Emote clip sampling (degrees, deltas over bind pose, smoothstep between keys)
function sampleTrack(keys, t) {
    if (!keys || !keys.length) return null;
    if (t <= keys[0][0]) return keys[0].slice(1);
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last.slice(1);
    for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], b = keys[i + 1];
        if (t >= a[0] && t <= b[0]) {
            let s = (t - a[0]) / (b[0] - a[0] || 1);
            s = s * s * (3 - 2 * s);
            return [1, 2, 3].map((j) => a[j] + (b[j] - a[j]) * s);
        }
    }
    return null;
}

const DEG = Math.PI / 180;
const tq = new T.Quaternion(), te = new T.Euler(), tm = new T.Matrix4(), tm2 = new T.Matrix4(), tp = new V3(), tqq = new T.Quaternion(), ts = new V3();
const ONE = new V3(1, 1, 1);

export const avatarStats = { created: 0, equips: 0, props: 0 };

export class BloxAvatar {
    constructor(gltf) {
        avatarStats.created++;
        this.root = new T.Group();
        const model = cloneSkinned(gltf.scene);
        this.model = model;
        this.partMeshes = {}; this.origGeos = {}; this.bones = {}; this.bind = {}; this.restInv = {};
        this.props = {}; this.eq = {}; this.items = {}; this.pairs = [];
        this.phase = 0; this.emote = null; this.emoteW = 0; this.disposed = false;
        let skeleton = null;
        model.traverse((c) => {
            if (c.isSkinnedMesh) {
                if (!skeleton) skeleton = c.skeleton;
                c.material = new T.MeshLambertMaterial({ color: 0xffffff });
                c.castShadow = true;
                c.frustumCulled = false;
                for (const [slot, name] of Object.entries(PART_MESH_NAMES)) {
                    if (c.name.toLowerCase() === name.toLowerCase()) { this.partMeshes[slot] = c; this.origGeos[slot] = c.geometry; }
                }
            }
        });
        this.skeleton = skeleton;
        // Rest transforms in model space, captured before any pose/proportions/scale
        model.updateMatrixWorld(true);
        if (skeleton) {
            for (const bone of skeleton.bones) {
                const p = new V3(), q = new T.Quaternion(), s = new V3();
                bone.matrix.decompose(p, q, s);
                bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(s);
                bone.matrixAutoUpdate = true;
                this.bones[bone.name] = bone;
                this.bind[bone.name] = { op: p, oq: q, os: s };
                this.restInv[bone.name] = bone.matrixWorld.clone().invert();
            }
            this.neckOffsetBindY = 0;
            skeleton.bones.forEach((b, i) => { if (b.name === 'Neck_Offset') this.neckOffsetBindY = skeleton.boneInverses[i].clone().invert().elements[13]; });
            this.patchSkeleton(model);
            // the top games' run / jump / land animation, bound in the rest pose
            this.motion = new AvatarMotion(this.bones, model, TARGET_HEIGHT);
            this.spec = {};
        }
        // Normalise to the game's character height, feet on y = 0. Measuring a skinned model walks
        // every vertex through its bones (over a second on a slow PC), and every avatar is the same
        // base model, so it is measured once and remembered.
        if (!gltf.userData.restBox) gltf.userData.restBox = new T.Box3().setFromObject(model);
        const box = gltf.userData.restBox;
        const h = box.getSize(new V3()).y || 1;
        this.baseScale = TARGET_HEIGHT / h;
        this.footOffset = -box.min.y * this.baseScale;
        model.scale.setScalar(this.baseScale);
        model.position.y = this.footOffset;
        this.root.add(model);
        this.buildBody();
    }

    // The six body parts drawn as one skinned mesh: one draw call, one shadow draw and one skeleton
    // update per player instead of six each (busy servers draw dozens of players). Rebuilt when a
    // part changes; a part that can't be merged leaves the parts drawn on their own as before.
    buildBody() {
        const parts = Object.values(this.partMeshes).filter(Boolean);
        if (!parts.length || !this.skeleton || this.disposed) return;
        let g = null;
        try { g = mergeGeometries(parts.map((p) => bodyPartGeo(p.geometry)), false); } catch (e) { g = null; }
        if (!g) { for (const p of parts) p.visible = true; if (this.body) this.body.visible = false; return; }
        const first = parts[0];
        if (!this.body) {
            this.body = new T.SkinnedMesh(g, first.material);
            this.body.name = 'blox_body';
            this.body.castShadow = true;
            first.parent.add(this.body);
            this.body.bind(first.skeleton, first.bindMatrix);
        } else {
            this.body.geometry.dispose();
            this.body.geometry = g;
        }
        // a fixed sphere round the whole body in any pose (arms up included), so players off screen
        // or outside the shadow's reach are skipped and nothing re-measures the posed mesh
        g.computeBoundingBox();
        const bb = g.boundingBox, c = bb.getCenter(new V3()), r = bb.getSize(new V3()).length() * 0.75;
        this.body.boundingSphere = new T.Sphere(c, r);
        this.body.boundingBox = bb.clone().expandByScalar(r * 0.35);
        this.body.visible = true;
        for (const p of parts) p.visible = false;
    }

    // Shoulder width / torso width / leg spacing move vertices through the bone matrices
    patchSkeleton(model) {
        const done = new Set();
        const self = this;
        model.traverse((c) => {
            if (!c.isSkinnedMesh || done.has(c.skeleton)) return;
            done.add(c.skeleton);
            const skel = c.skeleton;
            const orig = skel.update.bind(skel);
            const bindPos = new Map();
            for (let i = 0; i < skel.bones.length; i++) bindPos.set(skel.bones[i].name, new V3().setFromMatrixPosition(skel.boneInverses[i].clone().invert()));
            const spine1X = bindPos.get('Spine1') ? bindPos.get('Spine1').x : 0;
            const above = new Set(['Spine2', 'ArmL_Offset', 'ArmL1', 'ArmL2', 'ArmR_Offset', 'ArmR1', 'ArmR2', 'Neck_Offset', 'Neck1']);
            skel.update = function () {
                orig();
                const p = self.props;
                const sw = p.shoulderWidth ?? 1, lox = p.legOffsetX ?? 1, tsx = p.torsoScaleX ?? 1;
                if (sw === 1 && lox === 1 && tsx === 1) return;
                const bm = this.boneMatrices;
                for (let i = 0; i < this.bones.length; i++) {
                    const name = this.bones[i].name, off = i * 16;
                    if ((name === 'Spine1' || name === 'Spine2') && tsx !== 1) { bm[off] *= tsx; bm[off + 1] *= tsx; bm[off + 2] *= tsx; bm[off + 3] *= tsx; }
                    if (above.has(name) && tsx !== 1) { const bp = bindPos.get(name); if (bp) bm[off + 12] += (bp.x - spine1X) * (tsx - 1) * 0.8; }
                    if (sw !== 1 && name.startsWith('Arm')) { const r = bindPos.get(name.startsWith('ArmL') ? 'ArmL_Offset' : 'ArmR_Offset'); if (r) bm[off + 12] += r.x * (sw - 1) * 0.8; }
                    if (lox !== 1 && name.startsWith('Leg')) { const r = bindPos.get(name.startsWith('LegL') ? 'LegL_Offset' : 'LegR_Offset'); if (r) bm[off + 12] += r.x * (lox - 1) * 0.8; }
                }
            };
        });
    }

    setProportions(p) { avatarStats.props++; this.props = { ...(p || {}) }; }

    // Apply equipped cosmetics; only slots that changed are reloaded
    setEquipped(eq, skinUrl) {
        avatarStats.equips++;
        eq = eq || {};
        const prev = this.eq;
        this.eq = { ...eq };
        const url = skinUrl || skinUrlFor(eq);
        if (url !== this.skinUrl) {
            this.skinUrl = url;
            this.skinReady = pixelTexture(url, false).then((tex) => {
                if (!tex || this.disposed || this.skinUrl !== url) return;
                this.model.traverse((c) => { if (c.isSkinnedMesh) { c.material.map = tex; c.material.needsUpdate = true; } });
            }).catch(() => {});
        }
        for (const [slot, info] of Object.entries(PART_INFO)) if (eq[info.key] !== prev[info.key]) this.swapPart(slot, eq[info.key]);
        for (const k of ['hatId', 'hairId', 'maskId']) if (eq[k] !== prev[k]) this.attach(k, 'hats', 'hats', eq[k], 'Neck1', (o) => o.position.set(0, 0.8, 0));
        if (eq.backId !== prev.backId) this.attach('backId', 'back', 'back', eq.backId, 'Spine2', (o) => o.position.set(0, 0, 0));
        for (const [k, a] of Object.entries(ACCESSORIES)) {
            if (eq[k] === prev[k]) continue;
            this.attach(k, a.slot, a.slot, eq[k], a.bone, (o) => {
                o.matrixAutoUpdate = false;
                o.matrix.copy(this.restInv[a.bone] || tm.identity()).multiply(tm2.makeTranslation(a.origin[0], a.origin[1], a.origin[2]));
            });
        }
        for (const [k, pr] of Object.entries(PAIRS)) if (eq[k] !== prev[k]) this.attachPair(k, pr, eq[k]);
    }

    swapPart(slot, id) {
        const target = this.partMeshes[slot];
        if (!target) return;
        // a skinned mesh caches its bounds from the geometry it had: recompute them for the new one
        const use = (geo) => { target.geometry = geo; target.boundingSphere = null; target.boundingBox = null; this.buildBody(); };
        if (!isEquipped(id)) { use(this.origGeos[slot]); return; }
        loadPart(PART_INFO[slot], id).then((gltf) => {
            if (!gltf || this.disposed || this.eq[PART_INFO[slot].key] !== id) return;
            let sm = null, rm = null;
            gltf.scene.traverse((c) => { if (c.isSkinnedMesh && !sm) sm = c; else if (c.isMesh && !rm) rm = c; });
            // a part made as a plain mesh gets skinned to the bone its slot follows (a skinned mesh
            // without skin data breaks the renderer's bounds and sorting: the game would freeze)
            if (!sm) { if (rm) use(rigidToSkinned(rm.geometry, this.origGeos[slot])); return; }
            if (!sm.geometry.getAttribute('skinIndex') || !sm.geometry.getAttribute('skinWeight')) { use(rigidToSkinned(sm.geometry, this.origGeos[slot])); return; }
            const geo = sm.geometry.clone();
            if (this.skeleton && sm.skeleton) {
                const nameMap = new Map();
                this.skeleton.bones.forEach((b, i) => nameMap.set(b.name, i));
                const idx = new Map();
                sm.skeleton.bones.forEach((b, i) => { const ci = nameMap.get(b.name); if (ci !== undefined) idx.set(i, ci); });
                const si = geo.getAttribute('skinIndex');
                if (si) { for (let i = 0; i < si.array.length; i++) { const m = idx.get(si.array[i]); if (m !== undefined) si.array[i] = m; } si.needsUpdate = true; }
            }
            use(geo);
        });
    }

    attach(key, slotDir, texDir, id, boneName, place) {
        const old = this.items[key];
        if (old) { old.parent && old.parent.remove(old); this.items[key] = null; }
        if (!isEquipped(id)) return;
        loadObj(slotDir, texDir, id).then((o) => {
            if (!o || this.disposed || this.eq[key] !== id) return;
            const bone = this.bones[boneName];
            place(o);
            (bone || this.model).add(o);
            this.items[key] = o;
        });
    }

    // Hands and shoes: one mesh per side, the right one mirrored; follow bone position + rotation only
    attachPair(key, pr, id) {
        this.pairs = this.pairs.filter((p) => { if (p.key === key) { p.obj.parent && p.obj.parent.remove(p.obj); return false; } return true; });
        if (!isEquipped(id)) return;
        pr.bones.forEach((boneName, i) => {
            loadObj(pr.slot, pr.slot, id).then((o) => {
                if (!o || this.disposed || this.eq[key] !== id || !this.bones[boneName]) return;
                const local = (this.restInv[boneName] || new T.Matrix4()).clone();
                if (i === 1) local.multiply(tm2.makeScale(-1, 1, 1));
                o.matrixAutoUpdate = false;
                this.model.add(o);
                this.pairs.push({ key, obj: o, bone: this.bones[boneName], local });
            });
        });
    }

    playEmote(clip) { this.emote = clip ? { clip, t: 0 } : null; }

    // Per-frame pose: bind pose + proportions, then the run / jump animation (animator.js), this
    // game's own poses faded in over it, or an emote
    update(dt, st) {
        if (!this.skeleton) return;
        const p = this.props;
        const h = p.height ?? 1, al = p.armLength ?? 1, hs = p.headScale ?? 1, nh = p.neckHeight ?? 1;
        this.model.scale.set(this.baseScale, this.baseScale * h, this.baseScale);
        this.model.position.y = this.footOffset * h;
        if ((st.moving && !st.air && !st.pogo) || st.climb) this.emote = null; // moving cancels an emote
        this.climbPhase = (this.climbPhase || 0) + dt * (st.climb && st.moving ? 9 : 0);
        const special = !!(st.pogo || st.climb);
        const breathe = Math.sin((st.t || 0) * 1.8) * 0.015;
        if (this.emote) { this.emote.t += dt; this.emoteW = Math.min(1, this.emoteW + dt / 0.1); }
        else this.emoteW = Math.max(0, this.emoteW - dt / 0.1);
        const clip = this.emote && this.emote.clip;
        const ct = clip ? (clip.loop ? this.emote.t % (clip.len || 1) : Math.min(this.emote.t, clip.len || 0)) : 0;
        if (clip && !clip.loop && this.emote.t > (clip.len || 0) + 0.2) this.emote = null;
        for (const name in this.bind) {
            const bone = this.bones[name], d = this.bind[name];
            bone.position.copy(d.op); bone.quaternion.copy(d.oq); bone.scale.copy(d.os);
            if (name.startsWith('Arm')) bone.scale.y = d.os.y * al;
            if (name === 'Neck_Offset') bone.position.y += (h - hs) * d.op.y + this.neckOffsetBindY * (nh - 1) * 0.8;
            if (name === 'Neck1') bone.scale.set(d.os.x * hs, d.os.y * (hs / h), d.os.z * hs);
            if (name === 'Spine2') { bone.scale.x = d.os.x * (1 + breathe); bone.position.y = d.op.y + breathe * 0.5; }
            let rx = 0, rz = 0;
            if (st.pogo) {
                // Riding the pogo: hands on the handlebar, legs nearly straight on the pegs
                if (name === 'ArmL_Offset' || name === 'ArmR_Offset') rx = -0.62;
                if (name === 'LegL_Offset' || name === 'LegR_Offset') rx = st.air ? -0.25 : -0.08;
            } else if (st.climb) {
                // Climbing: hands reaching up the wall one after the other, knees stepping
                const c = st.moving ? Math.sin(this.climbPhase) : 0;
                if (name === 'ArmL_Offset') rx = -2.7 + c * 0.45;
                if (name === 'ArmR_Offset') rx = -2.7 - c * 0.45;
                if (name === 'LegL_Offset') rx = -0.35 - c * 0.4;
                if (name === 'LegR_Offset') rx = -0.35 + c * 0.4;
            }
            if (this.emoteW > 0 && clip && clip.tracks && clip.tracks[name]) {
                const v = sampleTrack(clip.tracks[name], ct);
                if (v) {
                    const w = this.emoteW;
                    bone.quaternion.multiply(tq.setFromEuler(te.set(v[0] * DEG * w, v[1] * DEG * w, v[2] * DEG * w, 'XYZ')));
                    rx *= 1 - w; rz *= 1 - w;
                }
            }
            // kept while it fades out again
            if (special) { const s = this.spec[name] || (this.spec[name] = [0, 0]); s[0] = rx; s[1] = rz; }
        }
        this.motion.apply(this, dt, st, special, this.spec, false, this.emoteW);
        // the renderer brings every matrix up to date anyway: only items that follow a bone need them now
        if (!this.pairs.length) return;
        this.model.updateMatrixWorld(true);
        // Paired items follow their bone (position + rotation only) in model space
        if (this.pairs.length) {
            const inv = tm.copy(this.model.matrixWorld).invert();
            for (const pr of this.pairs) {
                tm2.multiplyMatrices(inv, pr.bone.matrixWorld).decompose(tp, tqq, ts);
                pr.obj.matrix.compose(tp, tqq, ONE).multiply(pr.local);
            }
        }
    }

    dispose() {
        this.disposed = true;
        this.root.parent && this.root.parent.remove(this.root);
        this.model.traverse((c) => { if (c.material && c.isSkinnedMesh) c.material.dispose(); });
        if (this.body) this.body.geometry.dispose();
    }
}

// Creates an avatar, or resolves null when player.glb can't be loaded (then the game keeps the blocky rig)
export async function createAvatar(av, skinUrl) {
    let gltf;
    try { gltf = await loadBase(); } catch (e) { return null; }
    const a = new BloxAvatar(gltf);
    if (av) { a.setProportions(av.proportions); a.setEquipped(av, skinUrl); } else a.setEquipped({}, null);
    // shown only once its skin is on (no blank white body for the first moments)
    await Promise.race([a.skinReady || Promise.resolve(), new Promise((r) => setTimeout(r, 4000))]);
    return a;
}
