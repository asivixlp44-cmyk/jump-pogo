// Server-side Bloxity integration: identity verification, Bux webhook helpers and stat reporting.
import { allProfiles } from './profiles.js';

export const API_URL = process.env.BLOXITY_API_URL || 'https://api.bloxity.io';
// Bux mode: purchases are only granted by the Bloxity webhook (set on the live host)
export const BUX_MODE = !!process.env.LEGION_WEBHOOK_SECRET || process.env.BUX_MODE === '1';
export const WEBHOOK_SECRET = process.env.LEGION_WEBHOOK_SECRET || '';

async function fetchJson(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 6000);
    try {
        const r = await fetch(url, { ...opts, signal: ctl.signal });
        const body = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, body };
    } finally { clearTimeout(timer); }
}

// Verifies a Bloxity JWT by asking the Bloxity API who it belongs to.
// Returns { id, name } or null. Never throws.
export async function verifyBloxityToken(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    try {
        const r = await fetchJson(`${API_URL}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok || !r.body) return null;
        const u = r.body.user || r.body;
        if (!u || !u._id) return null;
        return { id: String(u._id), name: String(u.displayName || u.username || '').slice(0, 20), username: String(u.username || '') };
    } catch (e) {
        return null;
    }
}

// ----- Stat reporting to Bloxity profiles ("Only in this game") -----
const STAT_DEFS = [
    { key: 'top_power', label: 'Power', type: 'number', sortOrder: 1 },
    { key: 'wins', label: 'Wins', type: 'number', sortOrder: 2 },
    { key: 'rebirths', label: 'Rebirths', type: 'number', sortOrder: 3 },
];
const LIMIT = { number: 1e9, seconds: 31536000000, currency: 1e12, percent: 100 };
const okValue = (v, type) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LIMIT[type];

export function installStatReporter() {
    const token = process.env.BLOXITY_REPORT_TOKEN, gameId = process.env.BLOXITY_GAME_ID;
    if (!token || !gameId) return { flush: async () => {} };
    const url = `${API_URL}/v1/games/${gameId}/stats`;
    async function flush() {
        try {
            const players = [];
            // Values come from server-owned profiles only; guests are skipped
            for (const p of allProfiles()) {
                if (!p.uid || !p.uid.startsWith('legion_')) continue;
                const values = {};
                const raw = { top_power: Math.floor(p.power || 0), wins: Math.floor(p.wins || 0), rebirths: Math.floor(p.rebirths || 0) };
                for (const d of STAT_DEFS) if (okValue(raw[d.key], d.type)) values[d.key] = raw[d.key];
                if (Object.keys(values).length) players.push({ userId: p.uid.split('#m')[0], values });
            }
            for (let i = 0; i < Math.max(1, players.length); i += 200) {
                const batch = players.slice(i, i + 200);
                if (!batch.length && i > 0) break;
                const r = await fetchJson(url, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ definitions: STAT_DEFS, players: batch }),
                }, 8000);
                console.log('[Bloxity stats]', r.status, JSON.stringify(r.body));
            }
        } catch (e) {
            console.warn('[Bloxity stats] report failed:', e.message);
        }
    }
    setInterval(flush, 60000).unref();
    setTimeout(flush, 5000).unref();
    return { flush };
}
