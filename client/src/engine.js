import * as THREE from 'three';
import { skinRig } from './batch.js';

export const T = THREE;
export const V3 = THREE.Vector3;
export const $ = (s) => document.querySelector(s);
export const hexCss = (h) => '#' + h.toString(16).padStart(6, '0');

// ----- renderer, scene, camera, lights -----
export const canvas = $('#view');
export const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;

export const scene = new T.Scene();
scene.fog = new T.Fog(0xbfe6ff, 520, 3400);
scene.background = new T.Color(0xbfe6ff);

// ----- sky: a dome that follows the camera -----
// Bright Roblox day sky down at the sea; the higher you bounce up the Rainbow Stairs, the deeper
// the blue gets, until stars come out near the top. A soft sun with a halo sits in the north-east.
const SUN_DIR = new T.Vector3(0.35, 0.55, 0.76).normalize();
const skyMat = new T.ShaderMaterial({
    side: T.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    uniforms: { uAlt: { value: 0 }, uSun: { value: SUN_DIR }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir;
        void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform float uAlt; uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main() {
            vec3 d = normalize(vDir);
            float a = clamp(uAlt, 0.0, 1.0);
            vec3 zen = mix(vec3(0.13, 0.45, 0.98), vec3(0.03, 0.06, 0.24), a);
            vec3 hor = mix(vec3(0.76, 0.91, 1.0), vec3(0.36, 0.5, 0.88), a);
            vec3 low = mix(vec3(0.62, 0.82, 1.0), vec3(0.2, 0.28, 0.6), a);
            float h = d.y;
            vec3 col = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor, low, pow(-h, 0.4));
            float s = max(dot(d, uSun), 0.0);
            col += vec3(1.0, 0.95, 0.8) * (pow(s, 900.0) * 3.0 + pow(s, 60.0) * 0.35 + pow(s, 8.0) * 0.12 * (1.0 - a));
            // Stars appear as the sky darkens
            vec3 q = floor(d * 380.0);
            float st = step(0.9965, hash(q)) * smoothstep(0.35, 0.8, a) * smoothstep(-0.05, 0.25, h);
            col += vec3(st) * (0.7 + 0.3 * sin(uTime * 2.0 + hash(q + 3.1) * 40.0));
            gl_FragColor = vec4(col, 1.0);
        }`,
});
const skyDome = new T.Mesh(new T.SphereGeometry(3600, 32, 16), skyMat);
skyDome.renderOrder = -10;
skyDome.frustumCulled = false;
scene.add(skyDome);
// Altitude (0 at the lobby, 1 near the top of the tower) drives the sky and fog colours
const fogLow = new T.Color(0xbfe6ff), fogHigh = new T.Color(0x5a80e0);
export const SKY_TOP = 4200;
export function updateSky(pos, t) {
    const a = Math.min(1, Math.max(0, pos.y / SKY_TOP));
    skyMat.uniforms.uAlt.value = a;
    skyMat.uniforms.uTime.value = t;
    skyDome.position.copy(pos);
    scene.fog.color.copy(fogLow).lerp(fogHigh, a);
    scene.background.copy(scene.fog.color);
}
export const SUN_DIRECTION = SUN_DIR;

export const camera = new T.PerspectiveCamera(70, 1, 0.3, 4200);
function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < h ? 85 : 70;
    camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// No environment map or reflections (like Bloxity's top games): matte materials lit by the sky
// light, a little ambient and the sun
scene.add(new T.HemisphereLight(0xeaf4ff, 0x7a8a5a, 1.1));
scene.add(new T.AmbientLight(0xffffff, 0.45));
export const sun = new T.DirectionalLight(0xfff3e0, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 320 });
sun.shadow.bias = -0.0008;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

// ----- materials & textures -----
export const UNIT = new T.BoxGeometry(1, 1, 1);
// Neon is pushed well above 1.0 so only it crosses the bloom threshold (fx.js)
export const NEON_BOOST = 2.0;
// Matte materials only: PBR settings (roughness, metal, normal maps, environment) are dropped
const PBR_ONLY = ['roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'normalMap', 'normalScale', 'normalMapType', 'envMap', 'envMapIntensity', 'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenColor', 'sheenRoughness', 'ior', 'transmission', 'thickness', 'iridescence', 'specularIntensity', 'specularColor'];
export function toLambert(p) {
    const q = { ...(p || {}) };
    for (const k of PBR_ONLY) delete q[k];
    return new T.MeshLambertMaterial(q);
}
const matCache = new Map();
// Matte plastic (Lambert), lit by the sky light, ambient and sun like the top games
export function mat(color, o) {
    o = o || {};
    const key = color + '|' + (o.neon ? 1 : 0) + '|' + (o.opacity || 1);
    let m = matCache.get(key);
    if (!m) {
        m = o.neon ? new T.MeshBasicMaterial({ color }) : toLambert({ color, roughness: 0.55, metalness: 0 });
        if (o.neon) m.color.multiplyScalar(NEON_BOOST);
        if (o.opacity && o.opacity < 1) { m.transparent = true; m.opacity = o.opacity; m.depthWrite = false; }
        m.userData.fold = true; // a shared colour: the world batcher may bake it into vertex colours
        matCache.set(key, m);
    }
    return m;
}
export function texFrom(cv) {
    const t = new T.CanvasTexture(cv);
    t.colorSpace = T.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

// ----- Roblox studs -----
// One texture tile is 8 x 8 studs (8 x 8 units, a stud per unit, like Roblox). Each stud is a
// raised square with bevelled edges: a height field turned into a normal map, so the studs catch
// the sun and the sky light from any angle, plus a soft albedo with darker grooves.
const STUD_TEX = (() => {
    const N = 256, C = 32, INSET = 4, BEVEL = 5;
    const h = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const lx = x % C + 0.5, ly = y % C + 0.5;
        const d = Math.min(lx - INSET, C - INSET - lx, ly - INSET, C - INSET - ly);
        h[y * N + x] = d <= 0 ? 0 : Math.min(1, d / BEVEL) ** 0.8;
    }
    const albedo = document.createElement('canvas'); albedo.width = albedo.height = N;
    const normal = document.createElement('canvas'); normal.width = normal.height = N;
    const ai = albedo.getContext('2d').createImageData(N, N), ni = normal.getContext('2d').createImageData(N, N);
    const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4, v = at(x, y);
        // Groove between studs a little darker, stud tops a touch brighter
        const lx = x % C, ly = y % C, edge = lx < 1 || ly < 1;
        const g = edge ? 205 : v === 0 ? 228 : 236 + v * 19;
        ai.data[i] = ai.data[i + 1] = ai.data[i + 2] = g; ai.data[i + 3] = 255;
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2, dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
        const len = Math.hypot(dx, dy, 1);
        // Canvas y runs down, texture v runs up: flip the y slope
        ni.data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
        ni.data[i + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
        ni.data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
        ni.data[i + 3] = 255;
    }
    albedo.getContext('2d').putImageData(ai, 0, 0);
    normal.getContext('2d').putImageData(ni, 0, 0);
    const map = texFrom(albedo), nrm = new T.CanvasTexture(normal);
    nrm.colorSpace = T.NoColorSpace;
    for (const t of [map, nrm]) { t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
    return { map, nrm };
})();
const studRepeat = new Map();
function studMaps(rx, ry) {
    const key = rx + 'x' + ry;
    let r = studRepeat.get(key);
    if (!r) {
        r = { map: STUD_TEX.map.clone(), nrm: STUD_TEX.nrm.clone() };
        for (const t of [r.map, r.nrm]) { t.repeat.set(rx, ry); t.needsUpdate = true; }
        studRepeat.set(key, r);
    }
    return r;
}
// Studded plastic in a colour. With tiling UVs (1 UV unit = 8 world units) use the default repeat;
// o.rx / o.ry repeat the tile for plain 0..1 UVs. o.ice makes it glassy.
export function studMaterial(color, o) {
    o = o || {};
    const rx = Math.max(1, Math.round(o.rx || 1)), ry = Math.max(1, Math.round(o.ry || 1));
    const key = 'studpbr|' + color + '|' + rx + '|' + ry + '|' + (o.ice ? 1 : 0);
    let m = matCache.get(key);
    if (!m) {
        const t = studMaps(rx, ry);
        m = toLambert({ color, map: t.map, normalMap: t.nrm, normalScale: new T.Vector2(0.9, 0.9), roughness: o.ice ? 0.08 : 0.5, metalness: o.ice ? 0.12 : 0 });
        if (o.ice) { m.envMapIntensity = 1.8; m.emissive = new T.Color(0x16384a); }
        else m.userData.fold = true; // a shared tinted tile: the world batcher may bake the tint
        matCache.set(key, m);
    }
    return m;
}
function studMat(color, rx, rz) { return studMaterial(color, { rx: rx / 4, ry: rz / 4 }); }

// ----- world collections -----
export const solids = [];   // {min,max,belt,tread}
export const kills = [];    // {min,max,active}
export const triggers = []; // {min,max,enter,inside}
export const prompts = [];  // {pos,r,label(),act()}
export const tickers = [];  // per-frame callbacks (dt, t)

export function aabb(x, y, z, sx, sy, sz) {
    return { min: new V3(x - sx / 2, y - sy / 2, z - sz / 2), max: new V3(x + sx / 2, y + sy / 2, z + sz / 2) };
}

// box(sx,sy,sz, x,y,z, color, {studs, neon, opacity, decor, kill, cast})
export function box(sx, sy, sz, x, y, z, color, o) {
    o = o || {};
    let m;
    if (o.studs) {
        const side = mat(color), top = studMat(color, sx / 2, sz / 2);
        m = new T.Mesh(UNIT, [side, side, top, side, side, side]);
    } else {
        m = new T.Mesh(UNIT, mat(color, o));
    }
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    if (!o.neon) m.receiveShadow = true;
    if (o.cast) m.castShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
    if (o.kill) {
        const k = aabb(x, y, z, sx, sy, sz); k.active = true; kills.push(k);
    } else if (!o.decor) {
        solids.push(aabb(x, y, z, sx, sy, sz));
    }
    return m;
}

// ----- text -----
export function textCanvas(lines, W) {
    const pad = 10;
    let H = pad * 2;
    for (const l of lines) H += l.px * 1.2;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Math.ceil(H);
    const x = cv.getContext('2d');
    let y = pad;
    for (const l of lines) {
        let px = l.px;
        const font = (p) => `${l.w || 700} ${p}px Fredoka, "Arial Rounded MT Bold", sans-serif`;
        x.font = font(px);
        while (x.measureText(l.t).width > W - 24 && px > 8) { px -= 2; x.font = font(px); }
        x.textAlign = 'center'; x.textBaseline = 'middle';
        const cy = y + l.px * 0.62;
        if (l.s) { x.lineJoin = 'round'; x.lineWidth = Math.max(4, px * 0.22); x.strokeStyle = l.s; x.strokeText(l.t, W / 2, cy); }
        x.fillStyle = l.c || '#fff';
        x.fillText(l.t, W / 2, cy);
        y += l.px * 1.2;
    }
    return cv;
}
export function billboard(lines, worldW, W, pos, parent) {
    W = W || 512;
    const cv = textCanvas(lines, W);
    const sp = new T.Sprite(new T.SpriteMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, toneMapped: false }));
    sp.scale.set(worldW, worldW * cv.height / cv.width, 1);
    if (pos) sp.position.copy(pos);
    sp.userData.set = (nl) => {
        const c2 = textCanvas(nl, W);
        sp.material.map.dispose();
        sp.material.map = texFrom(c2);
        sp.material.needsUpdate = true;
        sp.scale.set(worldW, worldW * c2.height / c2.width, 1);
    };
    (parent || scene).add(sp);
    return sp;
}
export function textPlane(lines, worldW, W, pos, look) {
    const cv = textCanvas(lines, W || 512);
    const h = worldW * cv.height / cv.width;
    const m = new T.Mesh(new T.PlaneGeometry(worldW, h), new T.MeshBasicMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, toneMapped: false }));
    m.position.copy(pos);
    m.lookAt(look);
    scene.add(m);
    return m;
}
// Board facing `dir` (horizontal unit vector) with a border and text
export function signBoard(center, dir, w, h, lines, boardColor) {
    const g = new T.Group();
    g.position.copy(center); g.rotation.y = Math.atan2(dir.x, dir.z);
    const b1 = new T.Mesh(UNIT, mat(0x78372d)); b1.scale.set(w + 2, h + 2, 0.4); b1.position.z = -0.4; g.add(b1);
    const b2 = new T.Mesh(UNIT, mat(boardColor)); b2.scale.set(w, h, 0.4); b2.position.z = -0.1; g.add(b2);
    const cv = textCanvas(lines, 1024);
    const th = Math.min(h - 1, (w - 2) * cv.height / cv.width);
    const tw = th * cv.width / cv.height;
    const tp = new T.Mesh(new T.PlaneGeometry(tw, th), new T.MeshBasicMaterial({ map: texFrom(cv), transparent: true, depthWrite: false, toneMapped: false }));
    tp.position.z = 0.15; g.add(tp);
    scene.add(g);
    return g;
}

// ----- blocky rider rigs -----
// Name + number printed on the back of a shirt
const backTexCache = new Map();
function backTex(label, n, color) {
    const key = label + '|' + n + '|' + color;
    if (!backTexCache.has(key)) {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const x = c.getContext('2d');
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.lineJoin = 'round';
        if (label) {
            let px = 44;
            x.font = `700 ${px}px Fredoka, sans-serif`;
            while (x.measureText(label).width > 236 && px > 18) { px -= 2; x.font = `700 ${px}px Fredoka, sans-serif`; }
            x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,0.35)'; x.strokeText(label, 128, 48);
            x.fillStyle = color; x.fillText(label, 128, 48);
        }
        x.font = '700 150px Fredoka, sans-serif';
        x.lineWidth = 10; x.strokeStyle = 'rgba(0,0,0,0.35)'; x.strokeText(String(n), 128, 160);
        x.fillStyle = color; x.fillText(String(n), 128, 160);
        backTexCache.set(key, texFrom(c));
    }
    return backTexCache.get(key);
}

// Blocky hair styles built from boxes on top of the 1.2-stud head (top at y 5.2)
function buildHair(part, style, c) {
    switch (style) {
        case 'buzz':
            part(1.24, 0.1, 1.24, 0, 5.24, 0, c);
            part(1.24, 0.55, 0.08, 0, 4.95, -0.62, c);
            break;
        case 'curly': {
            part(1.26, 0.25, 1.26, 0, 5.28, 0, c);
            for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
                const h = 0.3 + ((i * 7 + j * 13 + 20) % 5) * 0.05;
                part(0.44, h, 0.44, i * 0.42, 5.4 + h / 2 - 0.1, j * 0.42, c);
            }
            part(1.26, 0.7, 0.2, 0, 4.95, -0.56, c);
            break;
        }
        case 'mohawk':
            part(1.24, 0.1, 1.24, 0, 5.24, 0, 0x3a2618);
            part(0.42, 0.5, 1.22, 0, 5.5, 0, c);
            part(0.42, 0.3, 0.3, 0, 5.4, 0.55, c);
            break;
        case 'quiff':
            part(1.3, 0.32, 1.3, 0, 5.34, -0.02, c);
            part(1.3, 0.7, 0.3, 0, 4.95, -0.5, c);
            part(1.0, 0.42, 0.5, 0, 5.62, 0.34, c);
            break;
        case 'slick':
            part(1.3, 0.3, 1.3, 0, 5.33, -0.02, c);
            part(1.3, 1.1, 0.3, 0, 4.72, -0.5, c);
            part(0.14, 0.6, 1.0, -0.64, 4.95, -0.1, c);
            part(0.14, 0.6, 1.0, 0.64, 4.95, -0.1, c);
            break;
        case 'fade':
            part(1.24, 0.1, 1.24, 0, 5.24, 0, c);
            part(1.1, 0.3, 1.1, 0, 5.42, 0.02, c);
            part(1.24, 0.45, 0.08, 0, 5.0, -0.62, c);
            break;
        case 'long':
            part(1.3, 0.35, 1.3, 0, 5.35, -0.02, c);
            part(1.3, 1.5, 0.3, 0, 4.55, -0.52, c);
            part(0.16, 1.1, 0.9, -0.66, 4.7, -0.12, c);
            part(0.16, 1.1, 0.9, 0.66, 4.7, -0.12, c);
            part(1.3, 0.18, 0.2, 0, 5.13, 0.56, c);
            break;
        case 'crop':
        case 'short':
        default:
            part(1.3, 0.35, 1.3, 0, 5.33, -0.02, c);
            part(1.3, 0.75, 0.3, 0, 4.95, -0.5, c);
            part(1.3, 0.16, 0.2, 0, 5.16, 0.56, c);
            break;
    }
}

export function buildRig(d) {
    const g = new T.Group();
    const part = (sx, sy, sz, x, y, z, c, parent) => {
        const m = new T.Mesh(UNIT, mat(c)); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true; (parent || g).add(m); return m;
    };
    const accent = new T.Color(d.numC || '#ffffff').getHex();
    // Torso: shirt, stripes, collar, crest, name + number on the back
    part(2, 2, 1, 0, 3, 0, d.shirt);
    if (d.stripes) { part(0.35, 2.02, 1.02, -0.5, 3, 0, d.stripes); part(0.35, 2.02, 1.02, 0.5, 3, 0, d.stripes); }
    part(0.9, 0.14, 1.04, 0, 3.94, 0, accent);
    part(0.3, 0.34, 0.04, 0.5, 3.55, 0.51, accent);
    part(2.02, 0.12, 1.02, 0, 2.06, 0, d.shorts);
    const back = new T.Mesh(new T.PlaneGeometry(1.8, 1.8), new T.MeshBasicMaterial({ map: backTex(d.label || '', d.num || 10, d.numC || '#fff'), transparent: true, toneMapped: false }));
    back.position.set(0, 2.98, -0.52); back.rotation.y = Math.PI; g.add(back);
    // Head: face, ears, hair, optional beard
    const head = new T.Group(); g.add(head);
    part(1.2, 1.2, 1.2, 0, 4.6, 0, d.skin, head);
    part(0.12, 0.3, 0.26, -0.64, 4.62, 0, d.skin, head);
    part(0.12, 0.3, 0.26, 0.64, 4.62, 0, d.skin, head);
    for (const sx of [-0.26, 0.26]) {
        part(0.26, 0.24, 0.04, sx, 4.72, 0.605, 0xffffff, head);
        part(0.13, 0.18, 0.04, sx + (sx > 0 ? -0.04 : 0.04), 4.71, 0.625, 0x1a1420, head);
        part(0.3, 0.07, 0.04, sx, 4.93, 0.61, d.hair, head);
    }
    part(0.36, 0.07, 0.04, 0, 4.34, 0.64, 0x6b2a2a, head);
    if (d.beard) {
        part(1.22, 0.3, 0.14, 0, 4.15, 0.56, d.hair, head);
        part(0.14, 0.55, 0.7, -0.6, 4.35, 0.2, d.hair, head);
        part(0.14, 0.55, 0.7, 0.6, 4.35, 0.2, d.hair, head);
    }
    buildHair((sx, sy, sz, x, y, z, c) => part(sx, sy, sz, x, y, z, c, head), d.hairStyle, d.hair);
    // Legs (pivot at the hip) and arms (pivot at the shoulder)
    const legs = [], arms = [];
    for (const side of [-0.5, 0.5]) {
        const p = new T.Group(); p.position.set(side, 2, 0); g.add(p);
        part(1, 0.9, 1, 0, -0.45, 0, d.shorts, p);
        part(0.04, 0.8, 0.5, side > 0 ? 0.51 : -0.51, -0.42, 0, accent, p);
        part(0.98, 1.1, 0.98, 0, -1.45, 0, d.socks, p);
        part(1.0, 0.14, 1.0, 0, -1.0, 0, 0xffffff, p);
        part(1.05, 0.38, 1.3, 0, -1.84, 0.12, d.shoes || 0x141418, p);
        legs.push(p);
    }
    for (const side of [-1.5, 1.5]) {
        const p = new T.Group(); p.position.set(side, 3.9, 0); g.add(p);
        part(1, 0.8, 1, 0, -0.4, 0, d.shirt, p);
        part(1.02, 0.1, 1.02, 0, -0.78, 0, accent, p);
        part(0.98, 1.2, 0.98, 0, -1.4, 0, d.gloves || d.skin, p);
        arms.push(p);
    }
    g.userData.legs = legs; g.userData.arms = arms; g.userData.head = head;
    return g;
}

export function animRig(g, phase, amt) {
    const s = Math.sin(phase) * amt;
    const u = g.userData;
    for (const p of [...u.legs, ...u.arms]) p.rotation.set(0, 0, 0);
    u.legs[0].rotation.x = s; u.legs[1].rotation.x = -s;
    u.arms[0].rotation.x = -s * 0.9; u.arms[1].rotation.x = s * 0.9;
}
export function airPose(g) {
    const u = g.userData;
    for (const p of [...u.legs, ...u.arms]) p.rotation.set(0, 0, 0);
    u.legs[0].rotation.x = 0.5; u.legs[1].rotation.x = -0.3;
    u.arms[0].rotation.x = -2.6; u.arms[1].rotation.x = -2.6;
}
// Climbing: hands reaching up the wall one after the other, knees stepping
export function climbPose(g, phase, moving) {
    const u = g.userData, s = moving ? Math.sin(phase) : 0;
    u.arms[0].rotation.set(-2.7 + s * 0.45, 0, -0.15); u.arms[1].rotation.set(-2.7 - s * 0.45, 0, 0.15);
    u.legs[0].rotation.set(-0.35 - s * 0.4, 0, 0); u.legs[1].rotation.set(-0.35 + s * 0.4, 0, 0);
}

// Riding the pogo: hands on the handlebar, feet on the pegs; tucks the knees a little in the air
export function pogoPose(g, air, t) {
    const u = g.userData, k = air ? 0.25 : 0.08;
    u.arms[0].rotation.set(-0.62, 0, 0.12); u.arms[1].rotation.set(-0.62, 0, -0.12);
    u.legs[0].rotation.set(-k, 0, 0.04); u.legs[1].rotation.set(-k, 0, -0.04);
    u.head.rotation.x = air ? -0.08 + Math.sin(t * 2) * 0.03 : 0;
}

// ----- pogo sticks -----
// Rider's feet stand on the pegs at y 0.15; the rubber tip is POGO_TIP studs below. The lower tube and
// spring are their own group so the stick can compress when it lands (setPogoCompress).
export const POGO_TIP = 2.5;
const SPRING_GEO = (() => {
    const pts = [];
    for (let i = 0; i <= 120; i++) { const a = i / 120 * Math.PI * 2 * 7; pts.push(new T.Vector3(Math.cos(a) * 0.36, i / 120, Math.sin(a) * 0.36)); }
    return new T.TubeGeometry(new T.CatmullRomCurve3(pts), 160, 0.07, 6, false);
})();
const CYL = new T.CylinderGeometry(1, 1, 1, 14);
const metalCache = new Map();
function metal(color, rough) {
    const key = color + '|' + rough;
    if (!metalCache.has(key)) { const m = toLambert({ color }); m.userData.fold = true; metalCache.set(key, m); }
    return metalCache.get(key);
}
export function buildPogo(def) {
    const g = new T.Group();
    const rainbow = def.glow === -1;
    const add = (geo, m, sx, sy, sz, x, y, z, parent) => { const o = new T.Mesh(geo, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); o.castShadow = true; (parent || g).add(o); return o; };
    const Z = 0.95;
    const glowM = def.glow ? new T.MeshBasicMaterial({ color: rainbow ? 0xffffff : def.glow, toneMapped: false }) : null;
    if (glowM && !rainbow) glowM.color.multiplyScalar(NEON_BOOST);
    // Upper tube, handlebar with grips, foot pegs
    add(CYL, metal(def.pole), 0.2, 2.5, 0.2, 0, 1.15, Z);
    add(CYL, metal(def.pole), 0.17, 3.3, 0.17, 0, 2.45, Z).rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) add(CYL, mat(def.grip), 0.24, 0.9, 0.24, s * 1.45, 2.45, Z).rotation.z = Math.PI / 2;
    add(CYL, metal(def.pole), 0.32, 0.3, 0.32, 0, 2.45, Z);
    const peg = add(UNIT, metal(0x3a3a48, 0.5), 2.4, 0.16, 0.5, 0, 0.12, Z - 0.05);
    for (const s of [-1, 1]) add(UNIT, mat(def.grip), 0.7, 0.1, 0.54, s * 0.95, 0.24, Z - 0.05);
    peg.castShadow = true;
    if (glowM) {
        add(CYL, glowM, 0.23, 0.12, 0.23, 0, 1.9, Z);
        add(CYL, glowM, 0.23, 0.12, 0.23, 0, 0.55, Z);
        for (const s of [-1, 1]) add(CYL, glowM, 0.27, 0.1, 0.27, s * 1.92, 2.45, Z).rotation.z = Math.PI / 2;
    }
    // Lower part: spring over the plunger, rubber foot at the bottom
    const low = new T.Group(); low.position.set(0, 0, Z); g.add(low);
    const spring = add(SPRING_GEO, metal(def.spring, 0.22), 1, 1.6, 1, 0, -1.7, 0, low);
    add(CYL, metal(def.pole), 0.14, 2.4, 0.14, 0, -1.25, 0, low);
    add(CYL, mat(0x16121f), 0.3, 0.32, 0.3, 0, -POGO_TIP + 0.16, 0, low);
    add(CYL, metal(def.pole), 0.25, 0.22, 0.25, 0, -0.08, 0, low);
    g.userData = { low, spring, glowM, rainbow };
    // one skinned mesh for the stick (the plunger moves as a bone); the spring stretches on its own
    spring.userData.dynamic = true;
    skinRig(g);
    return g;
}
// k = 0 rest .. 1 fully squashed: the body drops by up to 1.1 studs while the foot stays on the ground
export const POGO_SQUASH = 1.1;
export function setPogoCompress(pogo, k, t) {
    const u = pogo.userData, d = k * POGO_SQUASH;
    u.low.position.y = d;
    // The spring's top stays under the pegs while its foot rides up with the plunger
    u.spring.scale.y = 1.6 - d;
    if (u.rainbow && u.glowM) u.glowM.color.setHSL((t * 0.4) % 1, 1, 0.6).multiplyScalar(NEON_BOOST);
}

// Glowing ring + orbiting cubes, attached to a rig
export function buildAuraFx(parent) {
    const fx = new T.Group();
    const ringM = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
    const ring = new T.Mesh(new T.RingGeometry(1.6, 2.6, 32), ringM);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.15; fx.add(ring);
    const bits = [];
    for (let i = 0; i < 8; i++) {
        const b = new T.Mesh(UNIT, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
        b.scale.setScalar(0.35); fx.add(b); bits.push(b);
    }
    fx.userData = { ringM, bits };
    fx.visible = false;
    parent.add(fx);
    return fx;
}
const tmpColor = new T.Color();
export function updateAuraFx(fx, aura, t) {
    fx.visible = !!aura;
    if (!aura) return;
    const u = fx.userData;
    const rainbow = aura.id === 'Rainbow';
    u.ringM.color.copy(rainbow ? tmpColor.setHSL((t * 0.3) % 1, 1, 0.6) : tmpColor.set(aura.color)).multiplyScalar(NEON_BOOST);
    u.ringM.opacity = 0.4 + Math.sin(t * 4) * 0.15;
    u.bits.forEach((b, i) => {
        const ang = t * 2.2 + i * Math.PI / 4;
        b.material.color.copy(rainbow ? tmpColor.setHSL(((t * 0.3) + i / 8) % 1, 1, 0.6) : tmpColor.set(aura.color)).multiplyScalar(NEON_BOOST);
        b.position.set(Math.cos(ang) * 2.2, 1 + ((i * 0.7 + t * 1.5) % 5), Math.sin(ang) * 2.2);
        b.rotation.set(t * 3, t * 2, 0);
    });
}

// ----- particles & floating text -----
const particles = [];
export function burst(pos, color, size, count) {
    for (let i = 0; i < (count || 26); i++) {
        const m = new T.Mesh(UNIT, mat(i % 3 ? color : 0xffffff));
        m.scale.setScalar((size || 1) * (0.5 + Math.random() * 0.5));
        m.position.copy(pos);
        scene.add(m);
        particles.push({ m, v: new V3((Math.random() * 2 - 1) * 25, Math.random() * 30 + 5, (Math.random() * 2 - 1) * 25), t: 1.2 });
    }
}
export function confettiAt(pos) {
    for (const c of [0xffd028, 0x46ec50, 0x28c8ff, 0xe82434, 0xc428ff]) burst(pos, c, 0.4, 12);
}
const floaters = [];
export function floatText(text, color, pos) {
    const sp = billboard([{ t: text, c: color, s: '#16121f', px: 70 }], 5, 512, pos);
    floaters.push({ sp, t: 1.1 });
}
export function updateEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.t -= dt; p.v.y -= 80 * dt;
        p.m.position.addScaledVector(p.v, dt);
        p.m.rotation.x += dt * 5; p.m.rotation.y += dt * 4;
        if (p.t <= 0) { scene.remove(p.m); particles.splice(i, 1); }
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
        const f = floaters[i];
        f.t -= dt; f.sp.position.y += dt * 4; f.sp.material.opacity = Math.min(1, f.t * 2);
        if (f.t <= 0) { scene.remove(f.sp); f.sp.material.map.dispose(); f.sp.material.dispose(); floaters.splice(i, 1); }
    }
}

export function lerpAngle(a, b, k) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
}
