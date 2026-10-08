import crypto from 'node:crypto';

// Signed progress backups kept in the player's browser. Hosts with a temporary disk
// (Render's free tier) lose profiles.json whenever the service restarts; on the next join
// the browser hands its last backup back and we restore it. The HMAC stops edited backups.
const SECRET = process.env.SAVE_SECRET || 'jump-pogo-dev-only';
if (!process.env.SAVE_SECRET) console.warn('[saves] SAVE_SECRET is not set; using the dev-only key');

const FIELDS = [
    'power', 'wins', 'level', 'xp', 'rebirths', 'pogos', 'pogo', 'tramps', 'trail', 'quest', 'best', 'winsTotal', 'playtime', 'bounces', 'summits', 'passes',
    'boostUntil', 'customJP', 'claimedPack', 'firstPlay', 'daily', 'chestAt',
];
const MAX_LEN = 8000;

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

export function sealProfile(p) {
    const data = { uid: p.uid };
    for (const k of FIELDS) data[k] = p[k];
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    return payload + '.' + sign(payload);
}

// Returns the saved fields when the backup is genuine and belongs to one of the uids, else null
export function openSave(save, uids) {
    if (typeof save !== 'string' || save.length > MAX_LEN) return null;
    const dot = save.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = save.slice(0, dot), sig = Buffer.from(save.slice(dot + 1));
    const want = Buffer.from(sign(payload));
    if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!data || !uids.includes(data.uid)) return null;
    const out = {};
    for (const k of FIELDS) if (data[k] !== undefined) out[k] = data[k];
    return out;
}
