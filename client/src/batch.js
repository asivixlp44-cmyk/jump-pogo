// Draws the world in as few draw calls as possible, like Bloxity's top games.
//
// batchStatic(scene): every static box / shape is baked into world space and merged with the others
// that look the same, in chunks on a grid so chunks off screen are still skipped. Plain coloured
// materials become vertex colours on one shared material, and a tiled texture's repeat is baked
// into the UVs, so boxes of every size and colour share a handful of materials. Static means: placed
// straight in the scene with matrixAutoUpdate off (the world builders' box helpers), not
// transparent, not skinned or instanced, not marked userData.dynamic (a builder can mark a plain
// mesh userData.static to have it frozen and merged too).
//
// skinRig(group): a blocky figure (a group of boxes whose limbs turn on pivot groups) becomes one
// skinned mesh: each pivot is a bone, so the game animates it exactly as before with one draw call
// for the whole figure instead of one per box.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const shared = new Map(); // shared material per look
// a merged texture follows the offset of the one it came from, so belts and lava keep scrolling
const sourceOf = new Map();
const sourceMatOf = new Map();
function followOffset() {
    const t = this.material.map, s = t && sourceOf.get(t);
    if (s) t.offset.copy(s.offset);
    const sm = sourceMatOf.get(this.material);
    if (sm) { this.material.color.copy(sm.color); this.material.opacity = sm.opacity; }
}
// one material per kind and use: a material shared by skinned and plain meshes, or by meshes that
// do and don't take shadows, makes the renderer switch its shader for each of them every frame
const vcMat = (kind) => {
    let m = shared.get(kind);
    if (!m) {
        m = kind.startsWith('basic') ? new THREE.MeshBasicMaterial({ vertexColors: true }) : new THREE.MeshLambertMaterial({ vertexColors: true });
        m.name = 'batch-' + kind;
        shared.set(kind, m);
    }
    return m;
};
// only the game's shared colour materials (its mat() cache marks them userData.fold) become vertex
// colours: a material made for one object may have its colour animated later
const plain = (m) => m.userData.fold === true && !m.map && !m.alphaMap && !m.aoMap && !m.lightMap && !m.emissiveMap && (!m.emissive || m.emissive.getHex() === 0) && m.side === THREE.FrontSide && m.opacity === 1 && !m.transparent && m.fog && m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && (m.type === 'MeshLambertMaterial' || m.type === 'MeshBasicMaterial');
// the material a part is drawn with once merged, and how its geometry must change for it
const tintable = (m) => m.userData.fold === true && m.map && !m.map.rotation && !m.alphaMap && !m.aoMap && !m.lightMap && !m.emissiveMap && (!m.emissive || m.emissive.getHex() === 0) && !m.transparent && !m.vertexColors && m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && (m.type === 'MeshLambertMaterial' || m.type === 'MeshBasicMaterial');
function canonical(m, use) {
    if (plain(m) && !m.userData.noFold) { const kind = (m.type === 'MeshBasicMaterial' ? 'basic' : 'lambert') + '|' + use; return { m: vcMat(kind), key: 'vc-' + kind, color: m.color, map: null }; }
    // a shared tinted texture (stud, brick... in any colour): the tint becomes vertex colour, so one
    // material per texture serves every colour and size
    if (tintable(m) && !m.userData.noFold) {
        const tiled = !(m.map.repeat.x === 1 && m.map.repeat.y === 1);
        const src = m.map.source ? m.map.source.uuid : m.map.uuid;
        const key = ['tint', m.type, src, tiled ? 'tiled' : 'wrap' + m.map.wrapS + '.' + m.map.wrapT + '.' + m.map.magFilter, m.side, m.alphaTest, m.map.offset.x.toFixed(3), m.map.offset.y.toFixed(3), use].join('|');
        let c = shared.get(key);
        if (!c) {
            c = m.clone();
            c.color.set(0xffffff); c.vertexColors = true;
            if (tiled) {
                const t = m.map.clone();
                t.repeat.set(1, 1); t.offset.set(0, 0);
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.needsUpdate = true;
                c.map = t;
                sourceOf.set(t, m.map);
            }
            shared.set(key, c);
        }
        return { m: c, key, color: m.color, map: tiled ? m.map : null };
    }
    // an untiled or rotated texture keeps its own material (merged only with meshes that share it)
    if (!m.map || (m.map.repeat.x === 1 && m.map.repeat.y === 1) || m.map.rotation) return { m, key: m.uuid, color: null, map: null };
    // a tiled texture on a material of its own (its colour may change later): the repeat is baked
    // into the UVs and the copy keeps following the original's colour and scroll
    const key = 'tiled|' + m.uuid + '|' + use;
    let c = shared.get(key);
    if (!c) {
        c = m.clone();
        const t = m.map.clone();
        t.repeat.set(1, 1); t.offset.set(0, 0); t.rotation = 0;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.needsUpdate = true;
        c.map = t;
        sourceOf.set(t, m.map);
        sourceMatOf.set(c, m);
        shared.set(key, c);
    }
    return { m: c, key, color: null, map: m.map };
}

// one piece: the triangles of one material of a mesh, moved by `matrix`, with plain attributes
function piece(geo, matrix, start, count, map, color, srcColors, colors) {
    const idx = geo.index, n = geo.attributes.position.count;
    const out = new THREE.BufferGeometry();
    const put = (name, size, src) => {
        const arr = new Float32Array(n * size);
        if (src) for (let i = 0; i < n; i++) { arr[i * size] = src.getX(i); if (size > 1) arr[i * size + 1] = src.getY(i); if (size > 2) arr[i * size + 2] = src.getZ(i); }
        out.setAttribute(name, new THREE.BufferAttribute(arr, size));
        return arr;
    };
    put('position', 3, geo.attributes.position);
    if (geo.attributes.normal) put('normal', 3, geo.attributes.normal);
    put('uv', 2, geo.attributes.uv);
    if (colors) {
        const c = put('color', 3, srcColors ? geo.attributes.color : null);
        if (!srcColors || !geo.attributes.color) c.fill(1);
        if (color) for (let i = 0; i < n; i++) { c[i * 3] *= color.r; c[i * 3 + 1] *= color.g; c[i * 3 + 2] *= color.b; }
    }
    if (!geo.attributes.normal) out.computeVertexNormals();
    if (map) {
        const uv = out.attributes.uv, r = map.repeat;
        // the repeat is baked in; the offset stays on the texture (it follows the original's, scrolling too)
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * r.x, uv.getY(i) * r.y);
    }
    const tri = [];
    const end = Math.min(start + count, idx ? idx.count : n);
    for (let i = start; i < end; i++) tri.push(idx ? idx.getX(i) : i);
    if (matrix.determinant() < 0) for (let i = 0; i < tri.length; i += 3) { const t = tri[i + 1]; tri[i + 1] = tri[i + 2]; tri[i + 2] = t; }
    out.setIndex(tri);
    out.applyMatrix4(matrix);
    return out;
}
const partsOf = (o) => {
    const geo = o.geometry;
    if (!Array.isArray(o.material)) return [{ start: 0, count: Infinity, mat: o.material }];
    const gs = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    return gs.map((g) => ({ start: g.start, count: g.count, mat: o.material[g.materialIndex] })).filter((p) => p.mat);
};

const OK_TYPES = new Set(['MeshLambertMaterial', 'MeshBasicMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshToonMaterial']);
const okMat = (m) => m && OK_TYPES.has(m.type) && !m.transparent && !m.userData.noBatch && !(m.map && m.map.isVideoTexture);
const TMP = new THREE.Vector3();
export const batchStats = { meshes: 0, merged: 0, rigs: 0 };

export function batchStatic(root, { cell = 160, minCount = 2 } = {}) {
    // meshes the builders marked userData.static are frozen where they stand now
    for (const o of root.children) if (o.userData.static && o.matrixAutoUpdate) { o.updateMatrix(); o.matrixAutoUpdate = false; }
    root.updateMatrixWorld(true);
    const groups = new Map(), take = [];
    for (const o of root.children) {
        if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.matrixAutoUpdate || !o.visible || o.userData.dynamic || o.children.length) continue;
        if (o.morphTargetInfluences || !o.geometry || !o.geometry.attributes.position) continue;
        const parts = partsOf(o);
        if (!parts.length || parts.some((p) => !okMat(p.mat))) continue;
        o.geometry.computeBoundingSphere();
        TMP.copy(o.geometry.boundingSphere.center).applyMatrix4(o.matrixWorld);
        const cx = Math.floor(TMP.x / cell), cz = Math.floor(TMP.z / cell);
        for (const p of parts) {
            const c = canonical(p.mat, 'static' + (o.receiveShadow ? 'R' : ''));
            const key = c.key + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0) + '|' + o.renderOrder + '|' + cx + ',' + cz;
            let gr = groups.get(key);
            if (!gr) { gr = { mat: c.m, cast: o.castShadow, recv: o.receiveShadow, order: o.renderOrder, items: [] }; groups.set(key, gr); }
            gr.items.push({ o, start: p.start, count: p.count, map: c.map, color: c.color, src: !!p.mat.vertexColors, colors: !!c.m.vertexColors });
        }
        take.push(o);
    }
    // a mesh is merged only when every part of it found company; a lone mesh stays as it is
    const lonely = new Set();
    for (const gr of groups.values()) if (gr.items.length < minCount) for (const it of gr.items) lonely.add(it.o);
    let merged = 0;
    for (const gr of groups.values()) {
        const items = gr.items.filter((it) => !lonely.has(it.o));
        if (!items.length) continue;
        const geos = items.map((it) => piece(it.o.geometry, it.o.matrixWorld, it.start, it.count, it.map, it.color, it.src, it.colors));
        const g = mergeGeometries(geos, false);
        for (const x of geos) x.dispose();
        if (!g) continue;
        const m = new THREE.Mesh(g, gr.mat);
        m.castShadow = gr.cast; m.receiveShadow = gr.recv; m.renderOrder = gr.order;
        m.matrixAutoUpdate = false; m.updateMatrix();
        m.name = 'static-batch';
        if (gr.mat.map && sourceOf.has(gr.mat.map)) m.onBeforeRender = followOffset;
        root.add(m);
        merged++;
    }
    let removed = 0;
    for (const o of take) if (!lonely.has(o)) { root.remove(o); removed++; }
    batchStats.meshes += removed; batchStats.merged += merged;
    return { removed, merged };
}

// A blocky figure as one skinned mesh per look (usually one): each mesh is bound wholly to the
// group it hangs from, which becomes a bone; transparent or textured parts stay as they are. A
// group whose meshes all hang from it directly (a pickup, a prop) just becomes one plain mesh.
const INV = new THREE.Matrix4(), REL = new THREE.Matrix4();
export function skinRig(g) {
    if (!g || g.userData.skinned) return g;
    g.updateMatrixWorld(true);
    INV.copy(g.matrixWorld).invert();
    let list = [];
    g.traverse((o) => {
        if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || !o.geometry || o.userData.dynamic || o.children.length) return;
        const parts = partsOf(o);
        if (parts.length && parts.every((p) => okMat(p.mat))) list.push({ o, parts });
    });
    // all hanging from the group itself: one plain mesh per material. With moving pivots: a skinned
    // mesh, for the plain colour parts only (a skinned mesh must not share a material with plain ones)
    let rigid = list.every(({ o }) => o.parent === g);
    if (!rigid) list = list.filter(({ parts }) => parts.every((p) => plain(p.mat) && !p.mat.userData.noFold));
    if (list.length < 2) return g;
    const bones = [g], boneIdx = new Map([[g, 0]]);
    for (const { o } of list) if (!boneIdx.has(o.parent)) { boneIdx.set(o.parent, bones.length); bones.push(o.parent); }
    rigid = bones.length === 1;
    const groups = new Map();
    for (const { o, parts } of list) {
        const bi = boneIdx.get(o.parent);
        REL.multiplyMatrices(INV, o.matrixWorld); // the mesh in the figure's own space
        for (const p of parts) {
            const c = canonical(p.mat, (rigid ? 'rigid' : 'skin') + (o.receiveShadow ? 'R' : ''));
            const key = c.key + '|' + (o.castShadow ? 1 : 0) + (o.receiveShadow ? 1 : 0);
            let gr = groups.get(key);
            if (!gr) { gr = { mat: c.m, cast: o.castShadow, recv: o.receiveShadow, geos: [] }; groups.set(key, gr); }
            const geo = piece(o.geometry, REL, p.start, p.count, c.map, c.color, !!p.mat.vertexColors, !!c.m.vertexColors);
            if (!rigid) {
                const n = geo.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
                for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
                geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
                geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
            }
            gr.geos.push(geo);
        }
    }
    const skeleton = rigid ? null : new THREE.Skeleton(bones); // inverses from the pivots as they stand now
    for (const gr of groups.values()) {
        const geo = mergeGeometries(gr.geos, false);
        for (const x of gr.geos) x.dispose();
        if (!geo) continue;
        const m = rigid ? new THREE.Mesh(geo, gr.mat) : new THREE.SkinnedMesh(geo, gr.mat);
        m.castShadow = gr.cast; m.receiveShadow = gr.recv;
        m.name = rigid ? 'rig-batch' : 'rig-skin';
        g.add(m);
        if (!rigid) {
            m.updateMatrixWorld(true);
            m.bind(skeleton, m.matrixWorld);
            // a fixed sphere round the figure in any pose
            geo.computeBoundingSphere();
            m.boundingSphere = geo.boundingSphere.clone(); m.boundingSphere.radius *= 1.6;
            geo.computeBoundingBox(); m.boundingBox = geo.boundingBox.clone().expandByScalar(m.boundingSphere.radius * 0.4);
        }
    }
    for (const { o } of list) o.parent.remove(o);
    g.userData.skinned = true;
    batchStats.rigs++;
    return g;
}
