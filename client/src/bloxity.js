// Bloxity (Legion) SDK integration, kept in one place.
// The SDK is loaded by a <script> tag in index.html and exposes window.Legion.SDK.
// Every call is guarded, so the game still runs when the SDK is missing
// (blocked network, older SDK build, local dev without internet).

import { SKUS, PRODUCTS, PASSES } from '../../shared/config.js';

export const GAME_SLUG = import.meta.env.VITE_BLOXITY_GAME_SLUG || import.meta.env.VITE_BLOXITY_GAME_ID || 'jump-pogo';

const sdk = () => (window.Legion && window.Legion.SDK) || null;
const has = (path) => {
    let o = sdk();
    for (const k of path.split('.')) { if (!o) return false; o = o[k]; }
    return typeof o === 'function';
};
function call(path, ...args) {
    if (!has(path)) return undefined;
    const parts = path.split('.');
    const fn = parts.pop();
    let o = sdk();
    for (const k of parts) o = o[k];
    try { return o[fn](...args); } catch (e) { console.warn('[Bloxity]', path, e); return undefined; }
}

export const bloxity = {
    ready: false,
    user: null,       // LegionUser when logged in
    guest: null,      // GuestIdentity when signed out
    embedded: false,
    available: () => !!sdk(),
};

const userListeners = [];
export function onIdentity(cb) { userListeners.push(cb); cb(identity()); }

// Who the player is right now: a Bloxity user, a Bloxity guest, or nobody (no SDK)
export function identity() {
    const u = bloxity.user;
    if (u) return { loggedIn: true, id: u._id, name: u.displayName || u.username, username: u.username, pfp: u.pfp || '', token: call('auth.getToken') || '' };
    const g = bloxity.guest;
    if (g) return { loggedIn: false, id: '', name: g.displayName || g.username, username: g.username, pfp: g.pfp || '', token: '' };
    return { loggedIn: false, id: '', name: '', username: '', pfp: '', token: '' };
}

export function initBloxity() {
    if (!sdk() || bloxity.ready) return false;
    try { call('init', { gameSlug: GAME_SLUG }); } catch (e) { console.warn('[Bloxity] init failed', e); return false; }
    bloxity.ready = true;
    bloxity.embedded = !!call('portal.isEmbeddedInLegion');
    // Emote button in the portal overlay: register as soon as init returns
    call('game.registerFeature', 'emotes');
    call('auth.onUserChanged', (user) => {
        bloxity.user = user || null;
        bloxity.guest = user ? null : (call('auth.getGuest') || null);
        const id = identity();
        for (const cb of userListeners) cb(id);
    });
    return true;
}

// ----- auth -----
export const login = () => call('auth.showAuthPopup');
export const logout = () => call('auth.logout');

// ----- avatar -----
export function getEquipped() { return call('avatar.getEquipped') || null; }
export function getProportions() { return call('avatar.getProportions') || null; }
export function getSkinTextureUrl() { return call('avatar.getSkinTextureUrl') || ''; }
export function onAvatarChanged(cb) { return call('avatar.onAvatarChanged', cb); }
export function onProportionsChanged(cb) { return call('avatar.onProportionsChanged', cb); }
export function showCustomizer() { return call('avatar.showCustomizer'); }
// The avatar a guest customised is on getGuest().avatar; a logged-in user's is on getEquipped()
export function currentAvatar() {
    const eq = getEquipped() || (bloxity.user && bloxity.user.avatar) || (bloxity.guest && bloxity.guest.avatar) || null;
    const props = getProportions() || (eq && eq.proportions) || null;
    return eq ? { ...eq, proportions: props || undefined } : null;
}

// ----- settings (values are strings) -----
export function listenSetting(key, cb) { return call('settings.listen', key, cb); }
export function triggerAllSettings() { call('settings.triggerAll'); }

// ----- lifecycle & rooms -----
export const loadingStep = (text) => call('game.loadingStep', text);
export const loadingEnd = () => call('game.loadingEnd');
export const gameplayStart = () => call('game.gameplayStart');
export const updateRoom = (roomId) => call('game.updateRoom', roomId || '');

// ----- multiplayer matchmaker (Bloxity hosting) -----
// Resolves { endpoint, roomId, cold }, or null when the SDK/matchmaker isn't reachable
export async function resolveEndpoint(gameId, version) {
    if (!has('net.resolveEndpoint')) return null;
    try {
        const u = bloxity.user;
        const opts = {};
        if (u) opts.userId = u._id;
        if (version) opts.version = version;
        const r = (await call('net.resolveEndpoint', gameId, opts)) || null;
        console.info('[Bloxity] matchmaker', JSON.stringify(r));
        return r;
    } catch (e) {
        console.warn('[Bloxity] matchmaker', e);
        return null;
    }
}
export const playerJoined = (name) => call('game.playerJoined', name);
export const playerInRoom = (name) => call('game.playerInRoom', name);

// ----- portal -----
export const showPortalMenu = () => call('portal.showMenu', false);
export const isEmbedded = () => bloxity.embedded;

// ----- player events from the portal: respawn, chat, emotes -----
export function onPortalEvent(cb) {
    if (has('player.onEvent')) return call('player.onEvent', cb);
    // Older SDK builds expose per-event helpers instead
    call('player.onRespawnRequest', () => cb('respawn_request'));
    call('player.onChatMessageSent', (m) => cb('chat_message_sent', m));
    return undefined;
}

// ----- social -----
export async function getFriends() { try { return (await call('social.getFriends')) || []; } catch (e) { return []; } }
export const getInviteLink = () => call('social.getInviteFriendsLink') || location.href;
export async function inviteFriend(id) { try { return !!(await call('social.inviteFriend', id)); } catch (e) { return false; } }

// ----- Bux -----
// Every store button maps to a SKU in the game's Bloxity IAP catalog (shared/config.js).
// Prices live in that catalog (Bloxity developer panel), never in the game.
export async function buyWithBux(kind, key, metadata) {
    const sku = SKUS[kind] && SKUS[kind][key];
    if (!sku || !has('bux.requestPurchase')) return { success: false, error: 'Bux unavailable' };
    try { return (await call('bux.requestPurchase', sku, metadata || {})) || { success: false }; } catch (e) { return { success: false, error: e.message }; }
}
// Replace the default prices with the live Bux prices from this game's IAP catalog.
// Items the catalog doesn't have yet keep their defaults.
export async function loadCatalogPrices() {
    if (!has('api.get')) return false;
    let changed = false;
    const jobs = [];
    for (const kind of ['product', 'pass']) {
        for (const [key, sku] of Object.entries(SKUS[kind])) {
            jobs.push(Promise.resolve(call('api.get', `/v1/games/${GAME_SLUG}/iaps/${sku}`)).then((r) => {
                const price = r && (r.price ?? (r.product && r.product.price) ?? (r.iap && r.iap.price));
                if (typeof price === 'number' && price >= 0) {
                    (kind === 'pass' ? PASSES : PRODUCTS)[key].price = price;
                    changed = true;
                }
            }).catch(() => {}));
        }
    }
    await Promise.all(jobs);
    return changed;
}
export async function getBuxBalance() { try { return (await call('bux.getBalance')) || 0; } catch (e) { return 0; } }

// ----- emote catalogue (public endpoint) -----
let emoteCatalog = null;
export async function loadEmotes() {
    if (emoteCatalog) return emoteCatalog;
    try {
        const r = await fetch('https://api.bloxity.io/v1/avatar/emotes');
        const { emotes } = await r.json();
        emoteCatalog = new Map((emotes || []).map((e) => [e.id, e]));
    } catch (e) { emoteCatalog = new Map(); }
    return emoteCatalog;
}
