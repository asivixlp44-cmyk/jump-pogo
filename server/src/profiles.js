import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Player progress, keyed by uid ('legion_<id>' for Bloxity users, 'guest_...' / browser ids otherwise).
// On Bloxity hosting Legion provides MONGODB_URI: profiles live in MongoDB, shared by every pod,
// and this process only caches the players it is hosting right now.
// Without MONGODB_URI (local dev) everything is kept in a JSON file.
const MONGODB_URI = process.env.MONGODB_URI || '';
export const USE_DB = !!MONGODB_URI;

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'profiles.json');

const profiles = new Map();
let dirty = false;
let db = null;          // { profiles, grants, txs } collections once connected
let dbReady = null;     // promise of the connection

if (USE_DB) {
    dbReady = connectDb();
} else {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const [uid, p] of Object.entries(raw)) profiles.set(uid, p);
        console.log(`Loaded ${profiles.size} profiles`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('Could not read profiles:', e.message);
    }
}

async function connectDb() {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const d = client.db(process.env.MONGODB_DB || undefined);
    db = { profiles: d.collection('profiles'), grants: d.collection('grants'), txs: d.collection('transactions') };
    await Promise.all([
        db.profiles.createIndex({ power: -1 }),
        db.profiles.createIndex({ wins: -1 }),
        db.profiles.createIndex({ rebirths: -1 }),
        db.profiles.createIndex({ playtime: -1 }),
        db.grants.createIndex({ uid: 1 }),
    ]).catch((e) => console.warn('[DB] index:', e.message));
    console.log('[DB] connected to MongoDB');
    return db;
}
// Resolves once the store can be used (instantly in file mode)
export async function storeReady() {
    if (!USE_DB) return;
    try { await dbReady; } catch (e) {
        console.warn('[DB] connect failed, retrying:', e.message);
        dbReady = connectDb();
        await dbReady;
    }
}

export function defaultProfile(uid, name) {
    return {
        uid, name,
        power: 0, wins: 0, level: 0, xp: 0, rebirths: 0,
        // Pogo skins owned / equipped, trampolines bounced on (quests), highest step reached
        pogos: { Basic: true }, pogo: 'Basic', tramps: {}, trail: 'Starter', quest: 0, best: 0, daily: {},
        // Lifetime Wins, seconds played, bounces, summit pads claimed
        winsTotal: 0, playtime: 0, bounces: 0, summits: 0, passes: {},
        boostUntil: 0, customJP: 0, claimedPack: false, chestAt: 0,
        firstPlay: Date.now(),
    };
}

const fromDoc = (doc) => { const { _id, ...p } = doc; return { ...p, uid: _id }; };

// Pulls a player's saved profile into the cache. Call before getProfile in DB mode.
export async function loadProfile(uid) {
    if (!USE_DB || !uid || profiles.has(uid)) return;
    await storeReady();
    const doc = await db.profiles.findOne({ _id: uid });
    if (doc && !profiles.has(uid)) profiles.set(uid, fromDoc(doc));
}

// A blank name keeps the saved one; new players without a name get a random one
export function getProfile(uid, name, fallbackName) {
    let p = profiles.get(uid);
    if (!p) {
        p = defaultProfile(uid, name || fallbackName);
    } else {
        // Reconcile profiles saved by older versions
        p = Object.assign(defaultProfile(uid, name), p);
    }
    profiles.set(uid, p);
    if (name) p.name = name;
    dirty = true;
    return p;
}

// First Bloxity login on a browser that already played as a guest keeps that progress
export async function adoptGuestProgress(legionUid, guestUid, name) {
    if (!guestUid) return;
    await Promise.all([loadProfile(legionUid), loadProfile(guestUid)]);
    if (profiles.has(legionUid) || !profiles.has(guestUid)) return;
    const g = profiles.get(guestUid);
    profiles.set(legionUid, { ...JSON.parse(JSON.stringify(g)), uid: legionUid, name: name || g.name });
    dirty = true;
}

// Whether this uid is known here (in DB mode: call loadProfile first)
export function hasProfile(uid) { return profiles.has(uid); }
export function markDirty() { dirty = true; }
// Profiles cached in this process (in DB mode: the players online on this pod)
export function allProfiles() { return profiles.values(); }

async function writeDocs(list) {
    if (!list.length) return;
    await storeReady();
    await db.profiles.bulkWrite(list.map((p) => {
        const { uid, ...rest } = p;
        return { replaceOne: { filter: { _id: uid }, replacement: { ...rest, updatedAt: Date.now() }, upsert: true } };
    }), { ordered: false });
}

let saving = null;
export function saveProfiles() {
    if (!dirty) return saving || Promise.resolve();
    dirty = false;
    if (USE_DB) {
        const list = [...profiles.values()].map((p) => JSON.parse(JSON.stringify(p)));
        saving = writeDocs(list).catch((e) => { dirty = true; console.warn('[DB] save failed:', e.message); })
            .finally(() => { saving = null; });
        return saving;
    }
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        const tmp = FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(profiles)));
        fs.renameSync(tmp, FILE);
    } catch (e) {
        dirty = true;
        console.warn('Could not save profiles:', e.message);
    }
    return Promise.resolve();
}

// A player left this pod: save them and drop them from the cache, so a later visit
// (maybe after playing on another pod) reads fresh data from the database.
// stillOnline is checked again after the write: the player may have rejoined while it ran,
// and dropping their live profile from the cache then would lose everything they earn next.
export async function releaseProfile(uid, stillOnline) {
    if (!USE_DB) return;
    const p = profiles.get(uid);
    if (!p) return;
    try {
        await writeDocs([JSON.parse(JSON.stringify(p))]);
        if (!(stillOnline && stillOnline(uid)) && profiles.get(uid) === p) profiles.delete(uid);
    } catch (e) {
        console.warn('[DB] release failed:', e.message);
    }
}

// Best players across every pod, refreshed in the background
const BOARD_KEYS = ['power', 'wins', 'rebirths', 'playtime'];
const board = { power: [], wins: [], rebirths: [], playtime: [] };
async function refreshBoards() {
    if (!USE_DB || !db) return;
    try {
        for (const key of BOARD_KEYS) {
            const docs = await db.profiles.find({}, { projection: { name: 1, power: 1, wins: 1, rebirths: 1, playtime: 1 } }).sort({ [key]: -1 }).limit(10).toArray();
            board[key] = docs.map(fromDoc);
        }
    } catch (e) { console.warn('[DB] boards:', e.message); }
}
// Top 10 by key: database leaders merged with the (fresher) players online here
export function topProfiles(key) {
    const byUid = new Map();
    for (const p of board[key] || []) byUid.set(p.uid, p);
    for (const p of profiles.values()) byUid.set(p.uid, p);
    return [...byUid.values()].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 10);
}

// ----- Bux purchases that must reach a player on any pod -----
// Webhook deliveries are retried by Bloxity; the transaction id is recorded once across all pods
const seenTx = new Map();
export async function firstDelivery(txId) {
    if (USE_DB) {
        await storeReady();
        try { await db.txs.insertOne({ _id: txId, at: new Date() }); return true; } catch (e) {
            if (e.code === 11000) return false;
            throw e;
        }
    }
    const now = Date.now();
    for (const [k, t] of seenTx) if (now - t > 24 * 3600e3) seenTx.delete(k);
    if (seenTx.has(txId)) return false;
    seenTx.set(txId, now);
    return true;
}
// Queue a purchase for a player who isn't on this pod; whichever pod hosts them applies it
export async function queueGrant(uid, name, kind, key, tx) {
    await storeReady();
    await db.grants.insertOne({ uid, name, kind, key, tx, at: new Date() });
}
// Claims (removes and returns) queued purchases for the given players
export async function claimGrants(uids) {
    if (!USE_DB || !db || !uids.length) return [];
    const out = [];
    const pending = await db.grants.find({ uid: { $in: uids } }, { projection: { _id: 1 } }).toArray();
    for (const { _id } of pending) {
        const g = await db.grants.findOneAndDelete({ _id });
        const doc = g && g.value !== undefined ? g.value : g;   // driver v5 wraps, v6 doesn't
        if (doc && doc.uid) out.push(doc);
    }
    return out;
}

// Rooms also save on dispose: Colyseus disposes rooms (and awaits onDispose) on SIGTERM,
// which is how a pod is stopped on every deploy
setInterval(saveProfiles, USE_DB ? 10000 : 30000).unref();
if (USE_DB) {
    storeReady().then(refreshBoards).catch(() => {});
    setInterval(refreshBoards, 30000).unref();
}
