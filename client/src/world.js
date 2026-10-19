import {
    T, V3, scene, mat, box, aabb, UNIT, solids, triggers, tickers, texFrom, billboard, textPlane, camera, buildPogo, setPogoCompress, NEON_BOOST, toLambert } from './engine.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { S, actions, net } from './state.js';
import { studWallMaterial } from './textures.js';
import {
    CFG, LOBBY, BRIDGE, STAIRS, STAIRS_Z0, STAIRS_END, STEP_DEPTH, SUMMIT, TRAMPS, TRAMP_COLORS, TRAMP_GEO, POGOS, POGO_GEO, PASSES,
    GROUP_CHEST, SECRET, GEMS, GEM_RESPAWN, stepColor, trampPos, padPos, secretAt, fmt, big, clock, rngFrom, buxText,
} from '../../shared/config.js';
import { batchStatic, skinRig } from './batch.js';

const HX = LOBBY.halfX, HZ = LOBBY.halfZ;
// Lobby colours read off the reference: light grey studded baseplate on a cartoon sea, bright
// coloured blocks round the edge, a red TRAINING sign and a cyan POGO SKINS sign
const LC = {
    floor: 0xa9adb8, floorDark: 0x8e93a0, stand: 0x4a4e62, standTop: 0x5a5f78, path: 0xffd23a,
    trunk: 0x9a6a3a, leaf: 0x34d04a, leafDark: 0x22a83a, sand: 0xf4dc9a, gold: 0xf2c230,
};
const RAINBOW = [0xff3c5a, 0xff8a1e, 0xffd028, 0x46ec50, 0x28c8ff, 0x3a6aff, 0x8a5aff, 0xff4ad8];
const WATER_Y = -1.2;

export const SPAWN = new V3(LOBBY.spawn.x, LOBBY.spawn.y, LOBBY.spawn.z);
const pogoItems = [];
const trampItems = [];
const boards = {};
const signs = {};

// =====================================================================================
// Decor batching: scenery boxes (trees, islands, edge blocks) merged into vertex-coloured meshes
// =====================================================================================
const batch = [];
function deco(sx, sy, sz, x, y, z, color, ry) { batch.push({ sx, sy, sz, x, y, z, color, ry: ry || 0 }); }
function flushDecor() {
    if (!batch.length) return;
    const chunks = new Map();
    for (const b of batch) { const k = Math.floor(b.z / 320); if (!chunks.has(k)) chunks.set(k, []); chunks.get(k).push(b); }
    batch.length = 0;
    for (const list of chunks.values()) flushDecorChunk(list);
}
function flushDecorChunk(list) {
    const base = new T.BoxGeometry(1, 1, 1).toNonIndexed();
    const n = base.attributes.position.count;
    const pos = new Float32Array(list.length * n * 3), nor = new Float32Array(list.length * n * 3), col = new Float32Array(list.length * n * 3);
    const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), v = new T.Vector3(), nm = new T.Matrix3(), c = new T.Color();
    list.forEach((b, i) => {
        m4.compose(new T.Vector3(b.x, b.y, b.z), q.setFromEuler(e.set(0, b.ry, 0)), new T.Vector3(b.sx, b.sy, b.sz));
        nm.getNormalMatrix(m4);
        c.set(b.color);
        for (let k = 0; k < n; k++) {
            v.fromBufferAttribute(base.attributes.position, k).applyMatrix4(m4);
            pos.set([v.x, v.y, v.z], (i * n + k) * 3);
            v.fromBufferAttribute(base.attributes.normal, k).applyMatrix3(nm).normalize();
            nor.set([v.x, v.y, v.z], (i * n + k) * 3);
            const shade = v.y > 0.5 ? 1.08 : 1;
            col.set([c.r * shade, c.g * shade, c.b * shade], (i * n + k) * 3);
        }
    });
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const mesh = new T.Mesh(g, toLambert({ vertexColors: true, roughness: 0.7 }));
    mesh.receiveShadow = true; mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
}

// Blocky palm: a leaning segmented trunk and a crown of long leaves
function palm(x, y, z, s, rng) {
    const lean = (rng() - 0.5) * 0.6, dir = rng() * Math.PI * 2;
    let px = x, pz = z;
    for (let i = 0; i < 6; i++) {
        px += Math.cos(dir) * lean * s; pz += Math.sin(dir) * lean * s;
        deco(1.3 * s, 1.6 * s, 1.3 * s, px, y + 0.8 * s + i * 1.55 * s, pz, i % 2 ? LC.trunk : 0x7a522a);
    }
    const top = y + 10 * s;
    for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2 + rng();
        deco(5.5 * s, 0.5 * s, 1.6 * s, px + Math.cos(a) * 2.6 * s, top - 0.4 * s, pz + Math.sin(a) * 2.6 * s, k % 2 ? LC.leaf : LC.leafDark, -a);
    }
    deco(1.6 * s, 1.2 * s, 1.6 * s, px, top, pz, LC.leafDark);
}
// Small sandy island with palms, out in the sea
function island(x, z, r, rng) {
    deco(r * 2, 3, r * 2, x, WATER_Y - 0.6, z, LC.sand);
    deco(r * 1.4, 1.6, r * 1.4, x, WATER_Y + 1.4, z, 0xffe7b0);
    deco(r * 0.9, 1.2, r * 0.9, x, WATER_Y + 2.6, z, 0x6ad84a);
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) palm(x + (rng() - 0.5) * r * 0.6, WATER_Y + 3.2, z + (rng() - 0.5) * r * 0.6, 0.9 + rng() * 0.5, rng);
}

// =====================================================================================
// Shared helpers
// =====================================================================================
function texturedBox(sx, sy, sz, x, y, z, material, geo) {
    const m = new T.Mesh(geo || UNIT, material);
    m.scale.set(sx, sy, sz); m.position.set(x, y, z);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    scene.add(m);
    return m;
}
// Unit box whose UVs are scaled per face by that face's size, so a tiling texture keeps the same
// scale on every face of any box (1 tile = 8 units = 4 studs)
const tileGeos = new Map();
function tileBoxGeo(sx, sy, sz) {
    const key = sx.toFixed(2) + '|' + sy.toFixed(2) + '|' + sz.toFixed(2);
    let g = tileGeos.get(key);
    if (g) return g;
    g = new T.BoxGeometry(1, 1, 1);
    const uv = g.attributes.uv;
    // Face order: +x, -x (z by y), +y, -y (x by z), +z, -z (x by y)
    const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
    for (let face = 0; face < 6; face++) for (let k = 0; k < 4; k++) {
        const i = face * 4 + k;
        uv.setXY(i, uv.getX(i) * dims[face][0] / 8, uv.getY(i) * dims[face][1] / 8);
    }
    tileGeos.set(key, g);
    return g;
}
// Solid box with a studded texture on every face (a stud every 2 units)
function studBox(sx, sy, sz, x, y, z, color, o) {
    const m = texturedBox(sx, sy, sz, x, y, z, studWallMaterial(color, 1, 1), tileBoxGeo(sx, sy, sz));
    if (o && o.cast) m.castShadow = true;
    if (!(o && o.decor)) solids.push(aabb(x, y, z, sx, sy, sz));
    return m;
}
// Flat board whose canvas can be redrawn (signs, leaderboards)
function canvasPlane(w, h, pxW, pxH, pos, face) {
    const cv = document.createElement('canvas'); cv.width = pxW; cv.height = pxH;
    const tex = texFrom(cv);
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    m.position.copy(pos); m.rotation.y = Math.atan2(face.x, face.z);
    scene.add(m);
    return { cv, tex, m };
}
// Big outlined title text with a top-to-bottom gradient, facing `face`
function gradientBanner(text, colors, w, pos, face, sub, subColor) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = sub ? 300 : 200;
    const x = cv.getContext('2d');
    let px = 120;
    x.font = `700 ${px}px Fredoka, sans-serif`;
    while (x.measureText(text).width > 980 && px > 40) { px -= 6; x.font = `700 ${px}px Fredoka, sans-serif`; }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineJoin = 'round'; x.lineWidth = px * 0.14; x.strokeStyle = '#16121f'; x.strokeText(text, 512, 100);
    const g = x.createLinearGradient(0, 40, 0, 160);
    g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
    x.fillStyle = g; x.fillText(text, 512, 100);
    if (sub) {
        x.font = '700 62px Fredoka, sans-serif'; x.lineWidth = 12; x.strokeText(sub, 512, 232);
        x.fillStyle = subColor || '#ffd028'; x.fillText(sub, 512, 232);
    }
    const m = new T.Mesh(new T.PlaneGeometry(w, w * cv.height / 1024), new T.MeshBasicMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, side: T.DoubleSide, toneMapped: false }));
    m.position.copy(pos); m.rotation.y = Math.atan2(face.x, face.z);
    scene.add(m);
    return m;
}
// Tilted sign board on two posts, like the reference's red TRAINING and cyan POGO SKINS signs:
// a thick slab in the sign colour, a white icon and big outlined text
function bigSign(text, icon, w, h, pos, face, color, tilt) {
    const g = new T.Group(); g.position.copy(pos); g.rotation.y = Math.atan2(face.x, face.z); scene.add(g);
    const slab = new T.Group(); slab.rotation.z = tilt || 0; g.add(slab);
    const b = new T.Mesh(UNIT, mat(color)); b.scale.set(w, h, 1.6); b.castShadow = true; slab.add(b);
    const edge = new T.Mesh(UNIT, mat(new T.Color(color).multiplyScalar(0.7).getHex())); edge.scale.set(w + 0.8, h + 0.8, 1.2); edge.position.z = -0.3; slab.add(edge);
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = Math.round(1024 * h / w);
    const x = cv.getContext('2d');
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const px = Math.min(cv.height * 0.6, 170);
    x.font = `700 ${px}px Fredoka, sans-serif`;
    const label = (icon ? icon + ' ' : '') + text;
    x.lineWidth = px * 0.14; x.strokeStyle = '#16121f'; x.strokeText(label, 512, cv.height / 2 + 6);
    x.fillStyle = '#ffffff'; x.fillText(label, 512, cv.height / 2 + 6);
    const tp = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, toneMapped: false }));
    tp.position.z = 0.82; slab.add(tp);
    for (const s of [-1, 1]) {
        const post = new T.Mesh(UNIT, mat(0x3a3a48)); post.scale.set(1, pos.y, 1); post.position.set(s * w * 0.35, -pos.y / 2, -0.6); post.castShadow = true; g.add(post);
    }
    return g;
}

// =====================================================================================
// The sea: an animated cartoon water surface that follows the camera. Rounded cyan cells with
// pale ridges (Roblox water, like the reference), sun glints, a sky-tinted fresnel at grazing
// angles, white foam round the lobby, the bridge and the stairs, and the scene's fog.
// =====================================================================================
let water = null;
function buildWater() {
    const geo = new T.PlaneGeometry(9000, 9000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const rects = [
        new T.Vector4(0, 0, HX, HZ),
        new T.Vector4(0, BRIDGE.z0 + BRIDGE.len / 2, BRIDGE.width / 2, BRIDGE.len / 2),
        new T.Vector4(0, (STAIRS_Z0 + STAIRS_END) / 2, STAIRS[0].w / 2, (STAIRS_END - STAIRS_Z0) / 2),
    ];
    const m = new T.ShaderMaterial({
        fog: false,
        uniforms: {
            uTime: { value: 0 }, uFog: { value: new T.Color() }, uFogNear: { value: 500 }, uFogFar: { value: 3000 },
            uSun: { value: new T.Vector3(0.35, 0.55, 0.76).normalize() }, uRects: { value: rects }, uSky: { value: new T.Color(0xbfe6ff) },
        },
        vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `uniform float uTime; uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar; uniform vec3 uSun; uniform vec4 uRects[3]; uniform vec3 uSky;
            varying vec3 vW;
            vec2 h2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
            // Distance to the nearest cell border (F2 - F1), cells drifting slowly
            float cells(vec2 p, float t) {
                vec2 i = floor(p), f = fract(p);
                float f1 = 8.0, f2 = 8.0;
                for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
                    vec2 g = vec2(float(x), float(y));
                    vec2 o = h2(i + g);
                    o = 0.5 + 0.42 * sin(t + 6.2831 * o);
                    float d = length(g + o - f);
                    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
                }
                return f2 - f1;
            }
            float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
            void main() {
                vec2 p = vW.xz;
                float t = uTime;
                float e1 = cells(p * 0.045 + vec2(t * 0.02, t * 0.013), t * 0.5);
                float e2 = cells(p * 0.11 - vec2(t * 0.03, -t * 0.02), t * 0.7 + 3.0);
                float ridge = 1.0 - smoothstep(0.0, 0.16, e1);
                float ridge2 = 1.0 - smoothstep(0.0, 0.1, e2);
                vec3 deep = vec3(0.07, 0.62, 0.90), mid = vec3(0.18, 0.80, 0.96), pale = vec3(0.80, 0.97, 1.0);
                vec3 col = mix(deep, mid, smoothstep(0.1, 0.6, e1));
                col = mix(col, pale, ridge * 0.75 + ridge2 * 0.25);
                // Authored in sRGB, lit in linear
                col = pow(col, vec3(2.2));
                // Gentle normal from two sine swells for the glints and the fresnel
                vec3 n = normalize(vec3(sin(p.x * 0.09 + t * 1.1) * 0.06 + cos(p.y * 0.13 - t * 0.8) * 0.04, 1.0,
                    cos(p.y * 0.08 + t * 0.9) * 0.06 + sin(p.x * 0.15 + t * 1.3) * 0.04));
                vec3 v = normalize(cameraPosition - vW);
                float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
                col = mix(col, uSky, fres * 0.55);
                vec3 r = reflect(-v, n);
                float glint = pow(max(dot(r, uSun), 0.0), 220.0) * 2.4 + pow(max(dot(r, uSun), 0.0), 18.0) * 0.18;
                col += vec3(1.0, 0.97, 0.88) * glint;
                // Foam where the sea meets the lobby, the bridge and the stairs
                float d = 1e5;
                for (int i = 0; i < 3; i++) d = min(d, sdBox(p - uRects[i].xy, uRects[i].zw));
                float wob = sin(p.x * 0.35 + t * 2.0) * 0.6 + sin(p.y * 0.4 - t * 1.7) * 0.6;
                float foam = (1.0 - smoothstep(0.5, 3.4 + wob, d)) * step(-0.5, d);
                foam = max(foam, (1.0 - smoothstep(0.0, 0.6, abs(d - 5.0 - sin(t * 1.4) * 1.5))) * 0.45 * step(0.0, d));
                col = mix(col, vec3(0.95), clamp(foam, 0.0, 1.0) * 0.9);
                float dist = length(cameraPosition - vW);
                float fogK = smoothstep(uFogNear, uFogFar, dist);
                gl_FragColor = vec4(mix(col, uFog, fogK), 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }`,
    });
    water = new T.Mesh(geo, m);
    water.position.y = WATER_Y;
    water.receiveShadow = false;
    water.userData.dynamic = true;
    scene.add(water);
}

// ----- Rainbow light pillars in the sky, like the reference's rainbow beams behind the stairs -----
function rainbowPillar(x, z, r, h) {
    const m = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false,
        uniforms: { uTime: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform float uTime; varying vec2 vUv;
            vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
            void main() {
                float a = (1.0 - smoothstep(0.55, 1.0, vUv.y)) * smoothstep(0.0, 0.04, vUv.y);
                vec3 c = hue(fract(vUv.x * 2.0 + uTime * 0.02));
                float edge = pow(abs(sin(vUv.x * 6.2831)), 0.6);
                gl_FragColor = vec4(c * 0.85, a * 0.42 * (0.55 + 0.45 * edge));
            }`,
    });
    const mesh = new T.Mesh(new T.CylinderGeometry(r, r * 1.1, h, 48, 1, true), m);
    mesh.position.set(x, h / 2 - 2, z);
    mesh.renderOrder = 2; mesh.userData.dynamic = true; mesh.frustumCulled = false;
    scene.add(mesh);
    tickers.push((dt, t) => { m.uniforms.uTime.value = t; });
}

// =====================================================================================
// Lobby pieces
// =====================================================================================
// ----- Pogo skins: a raised stand of pads, a pogo spinning on each (step on a pad to buy / equip) -----
function pogoLines(def) {
    const owned = S.pogos && S.pogos[def.id], on = S.pogo === def.id;
    const lines = [{ t: 'x' + def.mult + ' Power', c: def.pass ? '#ff8af0' : '#ffffff', s: '#16121f', px: 64 }];
    if (on) lines.push({ t: 'EQUIPPED', c: '#7dff6b', s: '#16121f', px: 50 });
    else if (owned) lines.push({ t: 'OWNED', c: '#6fe0ff', s: '#16121f', px: 50 });
    else if (def.pass) lines.push({ t: buxText(PASSES[def.pass].price), c: '#ffd028', s: '#16121f', px: 50 });
    else if (!def.cost) lines.push({ t: 'FREE', c: '#ffd028', s: '#16121f', px: 56 });
    else lines.push({ t: fmt(def.cost) + (def.cost === 1 ? ' Win' : ' Wins') + ' Required', c: '#ffb51c', s: '#16121f', px: 44 });
    return lines;
}
const pogoPadColor = (def) => (S.pogo === def.id ? 0x28c8ff : S.pogos && S.pogos[def.id] ? 0x46ec50 : def.pass ? 0xff4ad8 : 0xe8304a);
function buildPogoStand() {
    const x0 = POGO_GEO.x, n = POGOS.length, z0 = POGO_GEO.z0 - 6, z1 = POGO_GEO.z0 + (n - 1) * POGO_GEO.step + 6;
    // Two tiers of dark stone, the pads on the lower one, a back wall under the sign
    studBox(16, 1.4, z1 - z0, x0, 0.7, (z0 + z1) / 2, LC.stand);
    studBox(12, 3, z1 - z0, x0 - 14, 1.5, (z0 + z1) / 2, LC.standTop);
    POGOS.forEach((def, i) => {
        const z = POGO_GEO.z0 + i * POGO_GEO.step, y = 1.4;
        const rim = new T.Mesh(UNIT, mat(0x16121f)); rim.scale.set(7.6, 0.24, 7.6); rim.position.set(x0, y + 0.1, z); scene.add(rim);
        const pad = new T.Mesh(UNIT, mat(pogoPadColor(def), { neon: true })); pad.scale.set(6.8, 0.3, 6.8); pad.position.set(x0, y + 0.18, z);
        pad.userData.dynamic = true; scene.add(pad);
        // The pogo itself, standing on its tip and turning slowly
        const g = new T.Group(); g.position.set(x0 - 0.2, y + 0.3 + 2.5, z); g.userData.dynamic = true; scene.add(g);
        const pogo = buildPogo(def); pogo.position.z = -0.95; g.add(pogo);
        const ph = i * 0.7;
        tickers.push((dt, t) => {
            if (camera.position.distanceToSquared(g.position) > 200 * 200) return;
            g.rotation.y = t * 0.9 + ph; g.position.y = y + 2.9 + Math.sin(t * 2.2 + ph) * 0.25;
            setPogoCompress(pogo, 0, t);
        });
        const sp = billboard(pogoLines(def), 9.5, 512, new V3(x0, y + 10, z));
        pogoItems.push({ def, sp, pad, sig: '' });
        const tr = aabb(x0, y + 5, z, 6.6, 10, 6.6);
        tr.enter = () => actions.pogo(def);
        triggers.push(tr);
    });
    bigSign('POGO SKINS', '🦘', 34, 8, new V3(x0 - 18, 20, 0), new V3(1, 0, 0), 0x28c8e8, 0.06);
}

// ----- Training: trampolines along the right side ("0 Rebirths 1.5x Power" ...) -----
export function trampLocked(def) {
    if (def.pass) return !S.passes[def.pass];
    return S.rebirths < (def.reb || 0);
}
function trampLines(def) {
    const lines = [];
    if (def.tag) lines.push({ t: def.tag + ' TRAMPOLINE', c: '#ff5a5a', s: '#16121f', px: 50 });
    else lines.push({ t: def.reb + (def.reb === 1 ? ' Rebirth' : ' Rebirths'), c: '#ffffff', s: '#16121f', px: 52 });
    lines.push({ t: def.mult + 'x Power', c: '#ffd028', s: '#16121f', px: 64 });
    if (trampLocked(def)) lines.push({ t: def.pass ? '🔒 ' + buxText(PASSES[def.pass].price) : '🔒 Locked', c: '#ff8a8a', s: '#16121f', px: 42 });
    return lines;
}
const MEMBRANE = new T.CylinderGeometry(1, 1, 1, 40);
const RIM = new T.TorusGeometry(1, 0.09, 10, 48);
// One trampoline: round coloured mat in a dark padded rim on short legs. Returns the bouncing mat.
function trampoline(x, z, color, r) {
    const top = TRAMP_GEO.top;
    const g = new T.Group(); g.position.set(x, 0, z); scene.add(g);
    const rim = new T.Mesh(RIM, mat(0x2a2a36)); rim.rotation.x = Math.PI / 2; rim.scale.set(r, r, 6.5); rim.position.y = top; rim.castShadow = true; g.add(rim);
    const pad = new T.Mesh(RIM, mat(color)); pad.rotation.x = Math.PI / 2; pad.scale.set(r * 0.93, r * 0.93, 3); pad.position.y = top + 0.12; g.add(pad);
    for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2;
        const leg = new T.Mesh(UNIT, mat(0x3a3a48)); leg.scale.set(0.4, top, 0.4); leg.position.set(Math.cos(a) * r * 0.9, top / 2, Math.sin(a) * r * 0.9); leg.castShadow = true; g.add(leg);
    }
    const mm = toLambert({ color: new T.Color(color).multiplyScalar(0.55), roughness: 0.35, metalness: 0.1, emissive: new T.Color(color).multiplyScalar(0.18) });
    const membrane = new T.Mesh(MEMBRANE, mm); membrane.scale.set(r * 0.88, 0.2, r * 0.88); membrane.position.y = top - 0.05; membrane.receiveShadow = true; g.add(membrane);
    const glow = new T.Mesh(new T.RingGeometry(r * 0.84, r * 0.9, 48), mat(color, { neon: true })); glow.rotation.x = -Math.PI / 2; glow.position.y = top + 0.07; g.add(glow);
    g.userData.dynamic = true;
    return { g, membrane, glow, dip: 0 };
}
function buildTraining() {
    TRAMPS.forEach((def, i) => {
        const p = trampPos(i), color = TRAMP_COLORS[i];
        const t = trampoline(p.x, p.z, color, TRAMP_GEO.r);
        const c = aabb(p.x, TRAMP_GEO.top / 2, p.z, TRAMP_GEO.r * 1.8, TRAMP_GEO.top, TRAMP_GEO.r * 1.8); c.tramp = i; solids.push(c);
        const sp = billboard(trampLines(def), 12, 512, new V3(p.x, TRAMP_GEO.top + 9.5, p.z));
        trampItems.push({ def, i, sp, t, sig: '' });
    });
    bigSign('TRAINING', '👟', 30, 7.5, new V3(TRAMP_GEO.x + 22, 20, 0), new V3(-1, 0, 0), 0xe8304a, -0.06);
}
// The secret x3 trampoline that pops up somewhere in the lobby for a minute every five
let secret = null;
function buildSecret() {
    const t = trampoline(0, 0, 0xffd028, TRAMP_GEO.r);
    const c = aabb(0, -500, 0, TRAMP_GEO.r * 1.8, TRAMP_GEO.top, TRAMP_GEO.r * 1.8); c.tramp = -1; solids.push(c);
    const sp = billboard([{ t: '3x Power', c: '#ffd028', s: '#16121f', px: 70 }], 9, 512, new V3(0, -500, 0));
    const beam = new T.Mesh(new T.CylinderGeometry(3, 5.6, 60, 24, 1, true), new T.MeshBasicMaterial({ color: 0xffe36b, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    beam.userData.dynamic = true; scene.add(beam);
    secret = { t, c, sp, beam, k: -1, key: '' };
    t.g.visible = false; beam.visible = false;
}
function updateSecret(t) {
    const s = secretAt(net.now()), o = secret;
    const on = s.on;
    if (on !== o.t.g.visible || s.k !== o.k) {
        o.k = s.k;
        o.t.g.visible = on; o.beam.visible = on;
        const y = on ? 0 : -500;
        o.t.g.position.set(s.x, 0, s.z);
        o.c.min.set(s.x - TRAMP_GEO.r * 0.9, y, s.z - TRAMP_GEO.r * 0.9); o.c.max.set(s.x + TRAMP_GEO.r * 0.9, y + TRAMP_GEO.top, s.z + TRAMP_GEO.r * 0.9);
        o.sp.position.set(s.x, on ? TRAMP_GEO.top + 9 : -500, s.z);
        o.beam.position.set(s.x, 30, s.z);
        if (on && S.name) actions.secretSpawned && actions.secretSpawned();
    }
    if (on) {
        const key = clock(s.left);
        if (key !== o.key) { o.key = key; o.sp.userData.set([{ t: key, c: '#ff5a5a', s: '#16121f', px: 60 }, { t: '3x Power', c: '#ffd028', s: '#16121f', px: 70 }]); }
        o.t.glow.material.color.setHSL((t * 0.5) % 1, 1, 0.6).multiplyScalar(NEON_BOOST);
        o.beam.material.opacity = 0.16 + Math.sin(t * 4) * 0.06;
    }
}
// A landing on trampoline i (-1 = the secret one) dips its mat
export function trampDip(i, k) {
    const it = i < 0 ? secret : trampItems[i];
    if (it) it.t.dip = Math.max(it.t.dip, k || 1);
}
function updateTramps(dt) {
    const all = trampItems.map((x) => x.t);
    if (secret) all.push(secret.t);
    for (const t of all) {
        if (t.dip <= 0.001 && t.membrane.position.y >= TRAMP_GEO.top - 0.06) continue;
        t.dip = Math.max(0, t.dip - dt * 5);
        t.membrane.position.y = TRAMP_GEO.top - 0.05 - t.dip * 0.9;
        t.membrane.scale.y = 0.2 + t.dip * 0.4;
    }
}

// ----- Group chest: red chest with gold trim on a glowing pad ("CLAIM!") -----
function groupChest(pos) {
    const g = new T.Group(); g.position.copy(pos); g.rotation.y = Math.PI * 0.9; scene.add(g);
    const part = (sx, sy, sz, x, y, z, c, o) => { const m = new T.Mesh(UNIT, mat(c, o)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    const pad = new T.Mesh(new T.CylinderGeometry(6, 6, 0.3, 28), mat(0xffd028, { neon: true })); pad.position.y = 0.15; g.add(pad);
    part(8, 4.5, 5.5, 0, 2.6, 0, 0xe8304a);
    for (const x of [-3.2, 0, 3.2]) part(0.7, 4.6, 5.6, x, 2.6, 0, LC.gold);
    const lid = part(8.2, 2.2, 5.7, 0, 5.8, -0.2, 0xff4a5a); lid.rotation.x = -0.18;
    part(8.3, 0.4, 5.8, 0, 4.85, 0, LC.gold);
    part(1.6, 1.8, 0.4, 0, 3.6, 2.85, 0xffd23a, { neon: true });
    solids.push(aabb(pos.x, 3, pos.z, 8, 6, 8));
    billboard([{ t: 'Free Chest', c: '#ffd028', s: '#16121f', px: 80 }, { t: '+' + fmt(GROUP_CHEST.power) + ' Power', c: '#ffffff', s: '#16121f', px: 52 }], 13, 512, new V3(pos.x, 11.5, pos.z));
    signs.chest = billboard(chestLines(), 9, 512, new V3(pos.x, 8, pos.z));
    const tr = aabb(pos.x, 5, pos.z, 13, 10, 13);
    tr.enter = () => actions.chest();
    triggers.push(tr);
}
function chestLines() {
    const left = (S.chestAt || 0) + GROUP_CHEST.hours * 3600000 - net.now();
    return [left > 0 ? { t: 'Refills in ' + clock(left / 1000), c: '#6fe0ff', s: '#16121f', px: 52 } : { t: 'CLAIM!', c: '#7dff6b', s: '#16121f', px: 60 }];
}

// ----- World 2 portal: pink studded frame round a white glow ("10 Rebirths Required!") -----
function world2Portal(pos, face) {
    const g = new T.Group(); g.position.copy(pos); g.rotation.y = Math.atan2(face.x, face.z); scene.add(g);
    const part = (sx, sy, sz, x, y, z, c, o) => { const m = new T.Mesh(UNIT, mat(c, o)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); if (!(o && o.neon)) m.castShadow = true; g.add(m); return m; };
    for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) part(2.4, 2.4, 2.4, sx * 6.2, 1.2 + k * 2.4, 0, k % 2 ? 0xff7ae0 : 0xff3fa0);
    for (let k = -3; k <= 3; k++) part(2.4, 2.4, 2.4, k * 2.4, 15.6, 0, k % 2 ? 0xff7ae0 : 0xff3fa0);
    const glow = part(10, 13.2, 0.4, 0, 7.6, 0, 0xffffff, { neon: true });
    glow.userData.dynamic = true;
    tickers.push((dt, t) => { glow.scale.x = 10 + Math.sin(t * 3) * 0.3; });
    solids.push(aabb(pos.x, 8, pos.z, 16, 17, 3));
    billboard([{ t: 'WORLD 2', c: '#ff7ae0', s: '#16121f', px: 90 }, { t: CFG.world2Rebirths + ' Rebirths Required!', c: '#ffd028', s: '#16121f', px: 52 }], 13, 512, new V3(pos.x, 21, pos.z));
    const tr = aabb(pos.x - face.x * 3, 4, pos.z - face.z * 3, 12, 8, 5);
    tr.enter = () => actions.portal();
    triggers.push(tr);
}

// ----- Leaderboards: dark screens between neon pillars -----
function leaderboard(pos, title, face, accent) {
    const g = new T.Group(); g.position.copy(pos); g.rotation.y = Math.atan2(face.x, face.z); scene.add(g);
    const part = (sx, sy, sz, x, y, z, c, o) => { const m = new T.Mesh(UNIT, mat(c, o)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = !(o && o.neon); g.add(m); return m; };
    part(16, 22, 1.2, 0, 12, 0, 0x1a1f5c);
    for (const sx of [-1, 1]) { part(2.2, 26, 2.2, sx * 9, 13, 0, accent); part(0.6, 24, 0.6, sx * 9, 13, 1.2, 0xffffff, { neon: true }); }
    part(20, 2, 2.4, 0, 26, 0, accent); part(18, 0.5, 0.6, 0, 26, 1.3, 0xffffff, { neon: true });
    solids.push(aabb(pos.x, 13, pos.z, 18, 26, 4));
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 720;
    const tex = texFrom(cv);
    const scr = new T.Mesh(new T.PlaneGeometry(15, 21), new T.MeshBasicMaterial({ map: tex, toneMapped: false }));
    scr.position.set(0, 12.5, 0.65); g.add(scr);
    const head = textPlane([{ t: title, c: '#ffffff', s: '#16121f', px: 110 }], 17, 1024, new V3(), new V3(0, 0, 1));
    scene.remove(head); head.position.set(0, 29.5, 0.3); g.add(head);
    return { cv, tex };
}
function drawBoard(b, rows, kind) {
    const x = b.cv.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 720);
    g.addColorStop(0, '#2c3a9a'); g.addColorStop(1, '#151a52');
    x.fillStyle = g; x.fillRect(0, 0, 512, 720);
    x.font = '700 34px Fredoka, sans-serif'; x.textBaseline = 'middle';
    if (!rows.length) { x.textAlign = 'center'; x.fillStyle = '#ffffff'; x.fillText('Be the first!', 256, 360); }
    rows.forEach((r, i) => {
        const y = 40 + i * 68;
        if (i % 2 === 0) { x.fillStyle = 'rgba(255,255,255,0.06)'; x.fillRect(0, y - 34, 512, 68); }
        x.textAlign = 'left'; x.fillStyle = r.you ? '#7dff6b' : i < 3 ? ['#ffd028', '#e0e6f0', '#e8a060'][i] : '#ffffff';
        x.fillText('#' + (r.rank || i + 1), 14, y);
        x.fillText(r.n.slice(0, 13), 84, y);
        x.textAlign = 'right'; x.fillStyle = kind === 'wins' ? '#ffd028' : kind === 'rebirths' ? '#ff8af0' : kind === 'playtime' ? '#6fe0ff' : '#c46aff';
        x.fillText(kind === 'rebirths' ? fmt(r.v) : kind === 'playtime' ? hours(r.v) : big(r.v), 500, y);
    });
    b.tex.needsUpdate = true;
}
// 7380 s -> "2h 3m"
const hours = (secs) => { const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; };
let boardsNext = 0;
// msg = { power: [{n, v}], wins: [...], rebirths: [...], playtime: [...], next } from the server, top 10 each
export function renderBoards(msg) {
    if (!boards.power || !msg) return;
    for (const kind of ['power', 'wins', 'rebirths', 'playtime']) {
        const rows = (msg[kind] || []).map((r, i) => ({ n: r.n, v: r.v, rank: i + 1, you: r.n === S.name }));
        drawBoard(boards[kind], rows, kind);
    }
    if (msg.next) boardsNext = msg.next;
}
function updateText() {
    const left = Math.max(0, (boardsNext - net.now()) / 1000);
    return 'In: ' + Math.floor(left / 60) + 'm ' + String(Math.floor(left % 60)).padStart(2, '0') + 's';
}
function drawUpdateSign() {
    const s = signs.update, x = s.cv.getContext('2d');
    x.clearRect(0, 0, 1024, 256);
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const line = (t, y, px, c) => { x.font = `700 ${px}px Fredoka, sans-serif`; x.lineWidth = px * 0.18; x.strokeStyle = '#16121f'; x.strokeText(t, 512, y); x.fillStyle = c; x.fillText(t, 512, y); };
    line('Leaderboards Update', 80, 92, '#ffffff');
    line(s.last = updateText(), 186, 84, '#ffffff');
    s.tex.needsUpdate = true;
}
// Timers on lobby signs; cheap to call often, redraws only when the text changes
export function updateLobbySigns() {
    if (signs.update && updateText() !== signs.update.last) drawUpdateSign();
    if (signs.chest) {
        const lines = chestLines(), key = lines[0].t;
        if (key !== signs.chest.key) { signs.chest.key = key; signs.chest.userData.set(lines); }
    }
}
export function refreshShop() {
    for (const it of pogoItems) {
        const sig = S.pogo + '|' + (S.pogos && S.pogos[it.def.id] ? 1 : 0) + (it.def.pass ? PASSES[it.def.pass].price : '');
        if (sig !== it.sig) { it.sig = sig; it.sp.userData.set(pogoLines(it.def)); it.pad.material = mat(pogoPadColor(it.def), { neon: true }); }
    }
    for (const t of trampItems) {
        const sig = (trampLocked(t.def) ? 'l' : 'u') + (t.def.pass ? PASSES[t.def.pass].price : '');
        if (sig !== t.sig) { t.sig = sig; t.sp.userData.set(trampLines(t.def)); }
    }
}

// =====================================================================================
// Lobby: a light grey studded baseplate on the sea, the Rainbow Stairs straight ahead (+z).
// Pogo skins on the left (-x... seen from spawn: screen-left is +x), training on the right,
// leaderboards behind the spawn, the chest and the World 2 portal by the bridge.
// =====================================================================================
function buildLobby() {
    const rng = rngFrom(7);
    studBox(HX * 2, 10, HZ * 2, 0, -5, 0, LC.floor);
    // Lighter and darker panels in the floor, like the reference's tiles
    for (let x = -HX + 20; x < HX; x += 40) for (let z = -HZ + 18; z < HZ; z += 36) if ((x + z) % 3 === 0) box(18, 0.04, 16, x, 0.02, z, LC.floorDark, { decor: true });
    // A ring of bright blocks round the edge
    let k = 0;
    for (let x = -HX + 3; x <= HX - 3; x += 6, k++) for (const sz of [-1, 1]) {
        if (sz > 0 && Math.abs(x) < BRIDGE.width / 2 + 2) continue;
        deco(5.8, 1.2, 3, x, 0.6, sz * (HZ - 1.5), RAINBOW[k % RAINBOW.length]);
    }
    for (let z = -HZ + 3; z <= HZ - 3; z += 6, k++) for (const sx of [-1, 1]) deco(3, 1.2, 5.8, sx * (HX - 1.5), 0.6, z, RAINBOW[k % RAINBOW.length]);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) deco(4, 3, 4, sx * (HX - 2), 1.5, sz * (HZ - 2), 0xffffff);

    // Spawn: a glowing pad
    box(14, 0.3, 14, SPAWN.x, 0.15, SPAWN.z, 0x16121f, { decor: true });
    box(13, 0.36, 13, SPAWN.x, 0.18, SPAWN.z, 0x28c8ff, { neon: true, decor: true });
    box(10, 0.42, 10, SPAWN.x, 0.21, SPAWN.z, 0xffffff, { decor: true });
    // Yellow path from the spawn to the bridge with white chevrons
    box(BRIDGE.width - 6, 0.06, HZ - SPAWN.z - 8, 0, 0.03, (SPAWN.z + 8 + HZ) / 2, LC.path, { decor: true });
    for (let z = SPAWN.z + 14; z < HZ - 4; z += 12) arrow(0, 0.08, z, 0xffffff);

    buildPogoStand();
    buildTraining();
    buildSecret();

    // Back: leaderboards, their timer and the game logo
    boards.power = leaderboard(new V3(-45, 0, -HZ + 4), 'Top Power', new V3(0, 0, 1), 0x8a3ae8);
    boards.wins = leaderboard(new V3(-15, 0, -HZ + 4), 'Top Wins', new V3(0, 0, 1), 0xe8a018);
    boards.rebirths = leaderboard(new V3(15, 0, -HZ + 4), 'Top Rebirths', new V3(0, 0, 1), 0xd8288a);
    boards.playtime = leaderboard(new V3(45, 0, -HZ + 4), 'Top Playtime', new V3(0, 0, 1), 0x1a8ae8);
    signs.update = canvasPlane(20, 5, 1024, 256, new V3(0, 36, -HZ + 3), new V3(0, 0, 1));
    drawUpdateSign();
    gradientBanner('+1 JUMP POGO', ['#ffffff', '#7fe8ff'], 46, new V3(0, 48, -HZ + 2), new V3(0, 0, 1), 'Every bounce = +Power!', '#ffd028');

    groupChest(new V3(-30, 0, 54));
    world2Portal(new V3(32, 0, 60), new V3(0, 0, -1));

    // Islands and palms out in the sea
    for (let i = 0; i < 22; i++) {
        const a = rng() * Math.PI * 2, r = 190 + rng() * 260;
        const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8;
        if (Math.abs(x) < 80 && z > 40) continue;
        island(x, z, 10 + rng() * 14, rng);
    }
}
// White ">" chevron painted on the floor, pointing at the stairs (+z)
function arrow(x, y, z, color) {
    for (const s of [-1, 1]) {
        const m = new T.Mesh(UNIT, mat(color));
        m.scale.set(5, 0.08, 1.2); m.position.set(x + s * 1.75, y, z); m.rotation.y = s * 0.6;
        scene.add(m);
    }
}

// =====================================================================================
// The Rainbow Stairs. Step k is one giant studded block from below the sea up to its top, from
// its riser back to the far end, so the stairs read as a stepped pyramid. "N STUD" is painted on
// every riser and every top has a "+N Wins" pad on the right.
// =====================================================================================
const hsl = (h, s, l) => new T.Color().setHSL(h, s, l).getHex();
function riserLabel(text, w, h, pos) {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
    const x = cv.getContext('2d');
    let px = 190;
    x.font = `700 ${px}px Fredoka, sans-serif`;
    while (x.measureText(text).width > 960 && px > 60) { px -= 8; x.font = `700 ${px}px Fredoka, sans-serif`; }
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    x.lineWidth = px * 0.16; x.strokeStyle = '#16121f'; x.strokeText(text, 512, 136);
    x.fillStyle = '#ffffff'; x.fillText(text, 512, 136);
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.copy(pos); m.rotation.y = Math.PI;
    m.renderOrder = 1;
    scene.add(m);
    return m;
}
const PAD_BEAM = new T.CylinderGeometry(4.2, 4.8, 18, 24, 1, true);
const padBeamMat = new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main() {
            float a = (1.0 - vUv.y) * smoothstep(0.0, 0.08, vUv.y);
            float bands = 0.7 + 0.3 * sin(vUv.y * 18.0 - uTime * 4.0);
            gl_FragColor = vec4(vec3(1.0, 0.82, 0.25) * 1.4, a * 0.38 * bands);
        }`,
});
tickers.push((dt, t) => { padBeamMat.uniforms.uTime.value = t; });
function winsPad(k, wins) {
    const at = padPos(k);
    const pad = new T.Mesh(UNIT, mat(0xffd028, { neon: true }));
    pad.scale.set(9, 0.3, 9); pad.position.set(at.x, at.y + 0.15, at.z); pad.userData.dynamic = true; scene.add(pad);
    box(10.4, 0.24, 10.4, at.x, at.y + 0.1, at.z, 0x7a3aff, { decor: true });
    box(10.4, 0.5, 0.6, at.x, at.y + 0.25, at.z - 5, 0xa86aff, { neon: true, decor: true });
    box(10.4, 0.5, 0.6, at.x, at.y + 0.25, at.z + 5, 0xa86aff, { neon: true, decor: true });
    const sp = billboard([{ t: '+' + fmt(wins) + ' Wins', c: '#ffd028', s: '#16121f', px: 80 }], 9, 512, new V3(at.x, at.y + 5.5, at.z));
    sp.userData.hide = () => Math.abs(playerAt.y - at.y) > 140;
    // A soft gold light column so the pads are easy to spot from below
    const col = new T.Mesh(PAD_BEAM, padBeamMat); col.position.set(at.x, at.y + 9, at.z); col.userData.dynamic = true; col.renderOrder = 2; scene.add(col);
    const tr = aabb(at.x, at.y + 6, at.z, 9, 12, 9);
    tr.enter = () => actions.pad(k);
    triggers.push(tr);
}
function buildStairs() {
    // The bridge from the lobby: a yellow-edged grey walkway with a checkered start line
    studBox(BRIDGE.width, 10, BRIDGE.len + 2, 0, -5, BRIDGE.z0 + BRIDGE.len / 2, LC.floor);
    for (const sx of [-1, 1]) box(1.2, 1, BRIDGE.len, sx * (BRIDGE.width / 2 - 0.6), 0.5, BRIDGE.z0 + BRIDGE.len / 2, LC.path);
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
    const cx = cv.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = (i + j) % 2 ? '#16121f' : '#ffffff'; cx.fillRect(i * 16, j * 16, 16, 16); }
    const chk = new T.Mesh(new T.PlaneGeometry(BRIDGE.width - 2.4, 3.6), toLambert({ map: texFrom(cv), roughness: 0.6 }));
    chk.rotation.x = -Math.PI / 2; chk.position.set(0, 0.05, STAIRS_Z0 - 4); chk.receiveShadow = true; scene.add(chk);
    gradientBanner('RAINBOW STAIRS', ['#ffffff', '#ffe36b'], 26, new V3(0, 13, BRIDGE.z0 + 4), new V3(0, 0, -1), 'Bounce higher for more Wins!', '#7dff6b');

    STAIRS.forEach((s) => {
        const hue = stepColor(s.k);
        const color = hsl(hue, 0.82, 0.55);
        const depth = STAIRS_END - s.z0 + s.k * 0.02;
        const bottom = -14;
        const m = studBox(s.w, s.h - bottom, depth, 0, (s.h + bottom) / 2, s.z0 + depth / 2, color, { cast: true });
        m.castShadow = true;
        // A pale lip along the front edge of the top
        box(s.w + 0.2, 0.5, 0.8, 0, s.h - 0.2, s.z0 + 0.3, hsl(hue, 0.9, 0.78), { decor: true });
        const lw = Math.min(s.w * 0.86, s.rise * 3.4), lh = lw / 4;
        riserLabel(s.h + ' STUD', lw, lh, new V3(0, s.y0 + Math.max(lh * 0.5 + 0.6, s.rise * 0.5), s.z0 - 0.08));
        winsPad(s.k, s.wins);
    });
    buildSummit();
}
// The top: a gold platform with a giant trophy and the biggest pad
function buildSummit() {
    const s = SUMMIT, last = STAIRS[STAIRS.length - 1];
    studBox(last.w, s.h + 14, s.depth, 0, (s.h - 14) / 2, s.z0 + s.depth / 2, LC.gold, { cast: true });
    riserLabel(s.h + ' STUD', last.w * 0.6, last.w * 0.15, new V3(0, s.h - 6, s.z0 - 0.08));
    const tz = s.zEnd - 40, ty = s.h;
    deco(10, 3, 10, 0, ty + 1.5, tz, 0x7a5a20);
    deco(3, 7, 3, 0, ty + 6.5, tz, LC.gold);
    deco(12, 9, 12, 0, ty + 14.5, tz, LC.gold);
    deco(13, 1.6, 13, 0, ty + 19.6, tz, 0xffe36b);
    for (const sx of [-1, 1]) deco(2, 6, 2, sx * 7.4, ty + 15, tz, LC.gold);
    solids.push(aabb(0, ty + 10, tz, 13, 20, 13));
    textPlane([{ t: 'YOU MADE IT!', c: '#ffd028', s: '#16121f', px: 150 }, { t: 'Top of the Rainbow Stairs', c: '#ffffff', s: '#16121f', px: 70 }], 36, 1024,
        new V3(0, s.h + 34, tz - 8), new V3(0, s.h + 34, tz - 40));
    winsPad(STAIRS.length, s.wins);
}

// ----- Clouds: soft billboards round the lobby and up the stairs, one instanced draw call -----
function cloudTexture() {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    const puff = (px, py, r, a) => {
        const g = x.createRadialGradient(px, py - r * 0.2, r * 0.1, px, py, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(246,250,255,${a * 0.85})`); g.addColorStop(1, 'rgba(225,236,250,0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    };
    for (const [px, py, r] of [[70, 80, 42], [110, 62, 50], [155, 70, 46], [192, 84, 36], [128, 90, 44], [92, 92, 34]]) puff(px, py, r, 0.95);
    return texFrom(c);
}
function buildClouds(rng) {
    const spots = [];
    for (let i = 0; i < 40; i++) spots.push([(rng() * 2 - 1) * 700, 110 + rng() * 220, (rng() * 2 - 1) * 700 + 200, 70 + rng() * 90]);
    // Up the stairs: clouds drifting past every few steps, so bouncing up feels like rising through them
    for (const s of STAIRS) {
        for (let k = 0; k < 5; k++) {
            const side = rng() < 0.5 ? -1 : 1;
            spots.push([side * (80 + rng() * 380), s.h + (rng() - 0.3) * 80, s.z0 + (rng() * 2 - 1) * 300, 80 + rng() * 110]);
        }
    }
    const base = new T.PlaneGeometry(1, 0.5);
    const geo = new T.InstancedBufferGeometry();
    geo.index = base.index; geo.attributes.position = base.attributes.position; geo.attributes.uv = base.attributes.uv;
    const off = new Float32Array(spots.length * 4);
    spots.forEach((s, i) => off.set(s, i * 4));
    geo.setAttribute('cloud', new T.InstancedBufferAttribute(off, 4));
    geo.instanceCount = spots.length;
    const m = new T.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: { map: { value: cloudTexture() } },
        vertexShader: `attribute vec4 cloud; varying vec2 vUv; varying float vFade;
            void main() {
                vUv = uv;
                vec4 mv = viewMatrix * vec4(cloud.xyz, 1.0);
                mv.xy += position.xy * cloud.w;
                vFade = clamp(1.0 - (-mv.z - 1600.0) / 1200.0, 0.0, 1.0) * clamp((-mv.z - 30.0) / 80.0, 0.0, 1.0);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying float vFade;
            void main() { vec4 c = texture2D(map, vUv); c.a *= vFade * 0.92; if (c.a < 0.01) discard; gl_FragColor = c; }`,
    });
    const mesh = new T.Mesh(geo, m);
    mesh.frustumCulled = false; mesh.renderOrder = -5; mesh.userData.dynamic = true;
    scene.add(mesh);
}

// =====================================================================================
// Power Gems: spinning crystals over every step (a burst of Power, back after GEM_RESPAWN s)
// =====================================================================================
const gemItems = [];
const GEM_GEO = new T.OctahedronGeometry(1.5, 0);
const GEM_COLORS = [0x5af0ff, 0xc46aff, 0x7dff6b, 0xffd028, 0xff5ab8];
function buildGems() {
    GEMS.forEach((g) => {
        const color = GEM_COLORS[g.i % GEM_COLORS.length];
        const m = toLambert({ color, emissive: new T.Color(color).multiplyScalar(0.9), roughness: 0.15, metalness: 0.3, transparent: true });
        const mesh = new T.Mesh(GEM_GEO, m); mesh.scale.set(1, 1.5, 1); mesh.position.set(g.x, g.y, g.z); mesh.castShadow = true;
        mesh.userData.dynamic = true; scene.add(mesh);
        const halo = new T.Sprite(new T.SpriteMaterial({ map: haloTex, color, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.8 }));
        halo.material.color.multiplyScalar(1.6); halo.scale.setScalar(7); mesh.add(halo);
        gemItems.push({ g, mesh, back: 0, ph: g.i * 1.7 });
    });
}
const haloTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return texFrom(c);
})();
// Animates the gems near the camera; calls onTouch(i) when the player (feet at p) touches one
export function updateGems(dt, t, p, onTouch) {
    const now = performance.now() / 1000;
    for (const it of gemItems) {
        const m = it.mesh, g = it.g;
        if (Math.abs(g.y - p.y) > 300 && Math.abs(g.z - camera.position.z) > 300) { m.visible = false; continue; }
        const ready = now >= it.back;
        // Respawning gems grow back in
        const k = ready ? Math.min(1, m.scale.x + dt * 3) : 0;
        m.visible = k > 0.02;
        if (!m.visible) continue;
        m.scale.set(k, k * 1.5, k);
        m.rotation.y = t * 1.6 + it.ph;
        m.position.y = g.y + Math.sin(t * 2.2 + it.ph) * 0.6;
        if (onTouch && ready && Math.abs(p.x - g.x) < 3 && Math.abs(p.z - g.z) < 3 && p.y + 7.6 > g.y - 1.5 && p.y < g.y + 1.5) {
            it.back = now + GEM_RESPAWN;
            m.scale.setScalar(0.001);
            onTouch(g);
        }
    }
}

// ----- Drop shadow: a soft dark disc on whatever is right under the player, so landings are easy to judge -----
let blob = null;
function buildBlob() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    const geo = new T.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    blob = new T.Mesh(geo, new T.MeshBasicMaterial({ map: texFrom(c), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    blob.renderOrder = 1; blob.userData.dynamic = true; scene.add(blob);
}
export function updateBlob(p, visible) {
    if (!blob) return;
    let top = -Infinity;
    for (const c of solids) {
        if (p.x < c.min.x || p.x > c.max.x || p.z < c.min.z || p.z > c.max.z || c.max.y > p.y + 0.5) continue;
        if (c.max.y > top) top = c.max.y;
    }
    const gap = p.y - top;
    blob.visible = visible && top > -Infinity && gap < 400;
    if (!blob.visible) return;
    blob.position.set(p.x, top + 0.08, p.z);
    const s = 3.2 + Math.min(4, gap * 0.04);
    blob.scale.set(s, 1, s);
    blob.material.opacity = Math.max(0.25, 1 - gap / 300);
}

// =====================================================================================
// "Follow the beam": glowing chevrons streaming from the player to the current objective,
// and a pillar of light standing on it
// =====================================================================================
let guide = null;
function buildGuide() {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
    const x = cv.getContext('2d');
    x.fillStyle = 'rgba(255,230,80,0.0)'; x.fillRect(0, 0, 64, 64);
    x.lineJoin = 'round'; x.lineCap = 'round';
    x.strokeStyle = 'rgba(255,236,110,1)'; x.lineWidth = 12;
    x.beginPath(); x.moveTo(8, 18); x.lineTo(32, 42); x.lineTo(56, 18); x.stroke();
    const tex = texFrom(cv); tex.wrapS = tex.wrapT = T.RepeatWrapping;
    const geo = new T.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const m = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: T.DoubleSide, opacity: 0.9 });
    m.color.setScalar(1.6);
    const mesh = new T.Mesh(geo, m); mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.userData.dynamic = true; scene.add(mesh);
    const pm = new T.MeshBasicMaterial({ color: 0xffe36b, transparent: true, opacity: 0.28, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false });
    const pillar = new T.Mesh(new T.CylinderGeometry(2.6, 4.2, 70, 24, 1, true), pm); pillar.userData.dynamic = true; scene.add(pillar);
    guide = { mesh, tex, pillar, pm };
    mesh.visible = pillar.visible = false;
}
const gA = new V3(), gB = new V3();
// from: player feet; to: objective position or null to hide
export function updateGuide(from, to, dt, t) {
    if (!guide) return;
    const on = !!to && from.distanceTo(to) > 6;
    guide.mesh.visible = on; guide.pillar.visible = !!to;
    if (!to) return;
    guide.pillar.position.set(to.x, to.y + 35, to.z);
    guide.pm.opacity = 0.22 + Math.sin(t * 3) * 0.06;
    if (!on) return;
    gA.set(from.x, from.y + 0.5, from.z);
    gB.set(to.x, to.y + 0.5, to.z);
    const len = gA.distanceTo(gB);
    guide.mesh.position.lerpVectors(gA, gB, 0.5);
    guide.mesh.lookAt(gB);
    guide.mesh.scale.set(3.2, 1, len);
    guide.tex.repeat.set(1, len / 3.2);
    guide.tex.offset.y = (guide.tex.offset.y + dt * 1.6) % 1;
}
// Where an objective ({ tramp: i } / { step: k } / { pogo: i }) is in the world
export function questTarget(to) {
    if (!to) return null;
    if (to.tramp != null) { const p = trampPos(to.tramp); return new V3(p.x, TRAMP_GEO.top, p.z); }
    if (to.step != null) { const p = padPos(to.step); return new V3(p.x, p.y, p.z); }
    if (to.pogo != null) return new V3(POGO_GEO.x, 1.4, POGO_GEO.z0 + to.pogo * POGO_GEO.step);
    return null;
}

// Merges every static, opaque mesh that shares a material (and vertex layout) into one mesh per
// chunk of the world, so the steps, pads, rims, arrows and props cost a few draw calls each and
// far chunks are still frustum-culled. Anything that moves or swaps its material at runtime is
// tagged userData.dynamic and left alone.
const CHUNK = 320;
const chunkOf = (z) => Math.floor(z / CHUNK);
function bakeStatics() {
    scene.updateMatrixWorld(true);
    const groups = new Map();
    const isDynamic = (o) => { for (let p = o; p; p = p.parent) if (p.userData.dynamic) return true; return false; };
    const at = new V3();
    const classOf = (m) => [m.type, m.map ? m.map.uuid : '', m.normalMap ? m.normalMap.uuid : '', m.roughness, m.metalness,
        m.emissive ? m.emissive.getHex() : '', m.envMapIntensity, m.side, m.toneMapped].join('|');
    scene.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || o.material.transparent || isDynamic(o)) return;
        const m = o.material;
        if (!m.isMeshLambertMaterial && !m.isMeshBasicMaterial) return;
        if (m.isMeshBasicMaterial && m.map) return;
        const g = o.geometry, a = g.attributes;
        if (!a.position || !a.normal || !a.uv || a.color) return;
        o.getWorldPosition(at);
        const key = classOf(m) + (g.index ? 'i' : 'n') + (o.castShadow ? 'c' : '') + (o.receiveShadow ? 'r' : '') + '|' + chunkOf(at.z);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
    });
    const classMats = new Map();
    let removed = 0, added = 0;
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const geos = list.map((o) => {
            const g = o.geometry.clone();
            for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
            g.morphAttributes = {};
            g.applyMatrix4(o.matrixWorld);
            const c = o.material.color, n = g.attributes.position.count, col = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
            g.setAttribute('color', new T.BufferAttribute(col, 3));
            return g;
        });
        const merged = mergeGeometries(geos, false);
        geos.forEach((g) => g.dispose());
        if (!merged) continue;
        merged.computeBoundingSphere();
        const cls = classOf(list[0].material);
        let material = classMats.get(cls);
        if (!material) {
            material = list[0].material.clone();
            material.color.setRGB(1, 1, 1);
            material.vertexColors = true;
            classMats.set(cls, material);
        }
        const m = new T.Mesh(merged, material);
        m.castShadow = list[0].castShadow; m.receiveShadow = list[0].receiveShadow;
        m.matrixAutoUpdate = false;
        scene.add(m);
        for (const o of list) o.parent.remove(o);
        removed += list.length; added++;
    }
    if (import.meta.env.DEV) console.log('[world] merged', removed, 'meshes into', added, 'with', classMats.size, 'materials');
}
// Where the local player is (main.js keeps it current), for signs that hide around them
export const playerAt = new V3();
// World signs (billboards placed straight in the scene) are hidden when far from the camera
function cullSigns() {
    const list = scene.children.filter((o) => o.isSprite);
    let acc = 0;
    tickers.push((dt) => {
        acc -= dt;
        if (acc > 0) return;
        acc = 0.25;
        const c = camera.position;
        for (const sp of list) sp.visible = sp.position.distanceToSquared(c) < 360 * 360 && !(sp.userData.hide && sp.userData.hide());
    });
}

// Per-frame world animation: the sea, trampolines, the secret trampoline
export function updateWorld(dt, t) {
    if (water) {
        const u = water.material.uniforms;
        u.uTime.value = t;
        u.uFog.value.copy(scene.fog.color);
        u.uSky.value.copy(scene.fog.color).lerp(new T.Color(0xffffff), 0.25);
        u.uFogNear.value = scene.fog.near; u.uFogFar.value = scene.fog.far;
        // The sea follows the camera in whole tiles, so it never ends
        water.position.x = Math.round(camera.position.x / 100) * 100;
        water.position.z = Math.round(camera.position.z / 100) * 100;
    }
    updateTramps(dt);
    if (secret) updateSecret(t);
}

export function buildWorld() {
    buildWater();
    buildLobby();
    buildStairs();
    rainbowPillar(-150, STAIRS_Z0 + 160, 16, 1800);
    rainbowPillar(170, STAIRS_Z0 + 420, 18, 2600);
    rainbowPillar(-120, -260, 14, 1400);
    rainbowPillar(0, STAIRS_END + 260, 26, 5200);
    buildClouds(rngFrom(55));
    buildGuide();
    buildGems();
    buildBlob();
    flushDecor();
    bakeStatics();
    cullSigns();
    refreshShop();
    // every box that never moves drawn together with the others that look the same
    batchStatic(scene);
}
