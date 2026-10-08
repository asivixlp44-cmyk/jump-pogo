import { Room } from 'colyseus';
import { GameState, PlayerState } from './schema.js';
import {
    getProfile, hasProfile, markDirty, saveProfiles, adoptGuestProgress, loadProfile, releaseProfile,
    topProfiles, claimGrants, queueGrant, USE_DB,
} from './profiles.js';
import { sealProfile, openSave } from './saves.js';
import { verifyBloxityToken, BUX_MODE } from './bloxity.js';
import {
    CFG, LOBBY, STAIRS, SUMMIT, PRODUCTS, PASSES, POGOS, pogoById, TRAILS, trailById, TRAMPS, QUESTS,
    FREE, DAILY, KITS, SKINS, GROUP_CHEST, GEMS, GEM_RESPAWN, gemValue, xpFor, rebirthLevel, jumpPowerFor, powerMult, bounceBase, trampAt, padPos,
    dailyStatus, dayKey, rewardText, fmt, clamp,
} from '../../shared/config.js';

const GREEN = '#7dff6b', RED = '#ff5a5a', GOLD = '#ffd028', BLUE = '#6fe0ff';

// Empty string when the player left the name box blank
function cleanName(name) {
    return String(name || '').replace(/[^\w .\-]/g, '').trim().slice(0, 20);
}
const randomName = () => 'Player' + Math.floor(1000 + Math.random() * 9000);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// Guest ids come from the browser; they can never claim a Bloxity identity
const guestUid = (uid, fallback) => String(uid || fallback).replace(/^legion_/, 'guest_').slice(0, 64);
const cleanAvatar = (av) => (typeof av === 'string' && av.length <= 2000 ? av : '');
const inLobby = (pl) => pl.z < LOBBY.halfZ + 2 && pl.y < 6;

export const liveRooms = new Set();

// One shared world: the lobby + the Rainbow Stairs. Movement is client-side, everything that
// changes progress (Power, Wins, pogos, unlocks, purchases) is decided here.
export class PogoRoom extends Room {
    maxClients = CFG.maxPlayers;

    onCreate() {
        liveRooms.add(this);
        this.setState(new GameState());
        this.setPatchRate(50);
        this.sessions = new Map();
        this.joinCount = 0;

        this.onMessage('move', (client, m) => this.onMove(client, m));
        this.onMessage('bounce', (client) => this.onBounce(client));
        this.onMessage('pad', (client, m) => this.onPad(client, m));
        this.onMessage('gem', (client, m) => this.onGem(client, m));
        this.onMessage('chest', (client) => this.onChest(client));
        this.onMessage('pogo', (client, m) => this.onPogo(client, m));
        this.onMessage('trail', (client, m) => this.onTrail(client, m));
        this.onMessage('rebirth', (client) => this.onRebirth(client));
        this.onMessage('free', (client, m) => this.onFree(client, m));
        this.onMessage('daily', (client) => this.onDaily(client));
        this.onMessage('buy', (client, m) => this.onBuy(client, m));
        this.onMessage('custom', (client, m) => this.onCustom(client, m));
        this.onMessage('auth', (client, m) => this.onBloxityLogin(client, m));
        this.onMessage('avatar', (client, m) => this.onAvatar(client, m));
        this.onMessage('emote', (client, m) => this.onEmote(client, m));
        this.onMessage('chat', (client, m) => this.onChat(client, m));
        this.onMessage('friends', (client, m) => this.onFriends(client, m));

        this.setSimulationInterval((dt) => this.tick(dt), 250);
        // Leaderboards refresh once a minute; the lobby sign counts down to the next one
        this.boardsAt = Date.now() + CFG.boardsEvery * 1000;
        this.clock.setInterval(() => { this.boardsAt = Date.now() + CFG.boardsEvery * 1000; this.broadcastBoards(); }, CFG.boardsEvery * 1000);
        // Bux purchases made while the player was on another pod (or offline)
        if (USE_DB) this.clock.setInterval(() => this.applyQueuedGrants(), 5000);
    }

    // A Bloxity token is verified with the Bloxity API; anyone else joins as a guest
    async onAuth(client, options) {
        const legion = options && options.token ? await verifyBloxityToken(options.token) : null;
        return legion ? { legion } : { guest: true };
    }

    async onJoin(client, options, auth) {
        options = options || {};
        const guest = guestUid(options.uid, client.sessionId);
        let uid = guest, name = cleanName(options.name);
        if (auth && auth.legion) {
            uid = 'legion_' + auth.legion.id;
            name = cleanName(auth.legion.name) || name;
            await adoptGuestProgress(uid, guest, name);
        }
        await loadProfile(uid);
        // A fresh server on a temporary disk restores the browser's signed backup.
        // With a database the profile is never lost, so backups are not accepted at all.
        const restore = !USE_DB && !hasProfile(uid) && openSave(options.save, [uid, guest]);
        const profile = getProfile(uid, name, randomName());
        if (restore) { Object.assign(profile, restore); markDirty(); }
        const player = new PlayerState();
        player.name = profile.name;
        player.av = cleanAvatar(options.av);
        player.x = LOBBY.spawn.x; player.y = LOBBY.spawn.y; player.z = LOBBY.spawn.z; player.ry = 0;
        player.kit = this.joinCount % KITS.length;
        player.skin = (this.joinCount * 3) % SKINS.length;
        this.joinCount++;
        this.state.players.set(client.sessionId, player);
        this.sessions.set(client.sessionId, {
            client, profile, player,
            lastBounce: 0, friends: 0, trampMult: 0, trampSeen: 0,
            joinedAt: Date.now(), freeClaimed: {}, gems: new Map(), cooldowns: new Map(), guest, lastChat: 0, padArmed: true, playAcc: 0,
        });
        this.syncPublic(client.sessionId);
        client.send('hello', { now: Date.now(), bux: BUX_MODE, bloxity: uid.startsWith('legion_') });
        this.payOffline(this.sessions.get(client.sessionId));
        this.sendProfile(client.sessionId);
        this.broadcastBoards(client);
        if (USE_DB) this.applyQueuedGrants();
    }

    // A dropped connection keeps the player in the world for 30 s so the client can reconnect
    onDrop(client) {
        this.allowReconnection(client, 30);
    }
    onReconnect(client) {
        const s = this.sessions.get(client.sessionId);
        if (!s) return;
        s.client = client;
        client.send('hello', { now: Date.now(), bux: BUX_MODE, bloxity: s.profile.uid.startsWith('legion_') });
        this.sendProfile(client.sessionId);
        this.broadcastBoards(client);
    }

    onLeave(client) {
        const s = this.sessions.get(client.sessionId);
        // Left while bouncing on a trampoline: it keeps earning until they come back (payOffline)
        if (s && Date.now() - s.trampSeen < 3000 && s.trampMult > 0) s.profile.offline = { mult: s.trampMult, at: Date.now() };
        this.state.players.delete(client.sessionId);
        this.sessions.delete(client.sessionId);
        markDirty();
        if (s && !isOnline(s.profile.uid)) releaseProfile(s.profile.uid, isOnline);
    }

    // Colyseus awaits this on SIGTERM, which is how Legion stops a pod on every deploy
    onDispose() { liveRooms.delete(this); markDirty(); return saveProfiles(); }

    async applyQueuedGrants() {
        const uids = [...this.sessions.values()].map((s) => s.profile.uid);
        let grants = [];
        try { grants = await claimGrants(uids); } catch (e) { return console.warn('[DB] grants:', e.message); }
        for (const g of grants) {
            const entry = [...this.sessions].find(([, s]) => s.profile.uid === g.uid);
            if (entry) { this.grant({ ...entry[1], id: entry[0] }, g.kind, g.key); continue; }
            // Left between the query and now: put it back for their next visit
            queueGrant(g.uid, g.name, g.kind, g.key, g.tx).catch(() => {});
        }
        if (grants.length) saveProfiles();
    }

    // ----- helpers -----
    syncPublic(id) {
        const s = this.sessions.get(id);
        if (!s) return;
        const p = s.profile, pl = s.player;
        pl.power = p.power; pl.wins = p.wins; pl.level = p.level; pl.xp = p.xp;
        pl.rebirths = p.rebirths; pl.trail = p.trail || ''; pl.pogo = p.pogo || 'Basic';
    }
    sendProfile(id) {
        const s = this.sessions.get(id);
        if (!s) return;
        const p = s.profile;
        s.client.send('profile', {
            pogos: p.pogos, pogo: p.pogo, trail: p.trail, passes: p.passes, quest: p.quest, best: p.best, tramps: p.tramps,
            boostUntil: p.boostUntil, customJP: p.customJP, claimedPack: p.claimedPack,
            firstPlay: p.firstPlay, freeClaimed: s.freeClaimed, joinedAt: s.joinedAt, daily: p.daily,
            chestAt: p.chestAt, playtime: p.playtime | 0, bounces: p.bounces | 0,
            winsTotal: Math.max(p.winsTotal || 0, p.wins || 0), save: sealProfile(p),
        });
    }
    toast(s, text, color) { s.client.send('toast', { text, color }); }
    cooldown(s, key, seconds) {
        const now = Date.now();
        if ((s.cooldowns.get(key) || 0) > now) return false;
        s.cooldowns.set(key, now + seconds * 1000);
        return true;
    }
    changed(id) {
        const s = this.sessions.get(id);
        if (s) this.checkQuest(s);
        this.syncPublic(id); this.sendProfile(id); markDirty();
    }

    addPower(s, amount, boosted) {
        const p = s.profile;
        if (!(amount > 0)) return 0;
        if (boosted) amount = Math.max(1, Math.floor(amount * powerMult(p, Date.now(), s.friends) + 0.5));
        p.power += amount;
        // XP is earned 1:1 with Power; at MAX level the bar keeps filling up to its cap
        const old = p.level;
        p.xp += amount;
        while (p.level < CFG.maxLevel && p.xp >= xpFor(p.level)) { p.xp -= xpFor(p.level); p.level++; }
        if (p.level >= CFG.maxLevel) p.xp = Math.min(p.xp, xpFor(CFG.maxLevel));
        if (p.level > old) this.sendLevelUp(s, old);
        markDirty();
        return amount;
    }
    sendLevelUp(s, old) {
        const p = s.profile;
        s.client.send('levelUp', { from: old, to: p.level, jp: [jumpPowerFor(old, p.rebirths), jumpPowerFor(p.level, p.rebirths)] });
    }
    addWins(s, n, boosted) {
        const p = s.profile;
        if (boosted && p.passes.DoubleWins) n *= 2;
        if (p.winsTotal == null || p.winsTotal < p.wins) p.winsTotal = p.wins;
        p.wins += n;
        p.winsTotal += n;
        markDirty();
        return n;
    }
    // Power / Wins / a timed x2 boost / Rebirths from rewards (quests, FREE, Daily)
    giveReward(s, r) {
        const p = s.profile;
        if (r.power) this.addPower(s, r.power, false);
        if (r.wins) this.addWins(s, r.wins, false);
        if (r.boost) p.boostUntil = Math.max(Date.now(), p.boostUntil || 0) + r.boost * 60000;
        if (r.rebirths) p.rebirths += r.rebirths;
        markDirty();
    }
    // Objective line: pays out and moves on as soon as a step is done
    checkQuest(s) {
        const p = s.profile;
        let q;
        while ((q = QUESTS[p.quest | 0])) {
            const [have, need] = q.done(p);
            if (have < need) break;
            p.quest = (p.quest | 0) + 1;
            this.giveReward(s, q.reward);
            s.client.send('quest', { n: p.quest, text: q.text, reward: rewardText(q.reward) });
            this.syncPublic(s.client.sessionId);
            this.sendProfile(s.client.sessionId);
            markDirty();
        }
    }

    // ----- simulation -----
    tick(dt) {
        for (const s of this.sessions.values()) {
            // Playtime (Top Playtime board)
            s.playAcc += dt / 1000;
            if (s.playAcc >= 1) { const whole = Math.floor(s.playAcc); s.playAcc -= whole; s.profile.playtime = (s.profile.playtime | 0) + whole; }
        }
    }

    // "Get Power While Offline!": time away after leaving on a trampoline pays out at a reduced rate
    payOffline(s) {
        const p = s && s.profile, off = p && p.offline;
        if (!off) return;
        delete p.offline;
        const secs = Math.min(CFG.offlineHours * 3600, (Date.now() - (off.at || 0)) / 1000);
        if (!(secs > 60)) return markDirty();
        // A trampoline bounce takes about 0.8 s
        const bounces = secs / 0.8;
        const amount = Math.floor(bounces * clamp(off.mult, 1, 250) * CFG.offlineRate * powerMult(p, Date.now(), 0));
        if (amount <= 0) return markDirty();
        this.addPower(s, amount, false);
        s.client.send('offline', { power: amount, secs: Math.floor(secs), mult: off.mult });
    }

    trampLocked(p, def) {
        if (def.pass) return !p.passes[def.pass];
        return p.rebirths < (def.reb || 0);
    }

    broadcastBoards(target) {
        // Database leaders (every pod) merged with the players online here
        const top = (key) => topProfiles(key).map((p) => ({ n: p.name, v: Math.floor(p[key] || 0) }));
        const msg = { power: top('power'), wins: top('wins'), rebirths: top('rebirths'), playtime: top('playtime'), next: this.boardsAt };
        if (target) target.send('boards', msg); else this.broadcast('boards', msg);
    }

    // ----- messages -----
    onMove(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m || !finite(m.x) || !finite(m.y) || !finite(m.z)) return;
        const pl = s.player;
        pl.x = clamp(m.x, -400, 400);
        pl.y = clamp(m.y, -50, SUMMIT.h + 400);
        pl.z = clamp(m.z, -400, SUMMIT.zEnd + 200);
        pl.ry = finite(m.ry) ? m.ry : 0;
        pl.anim = clamp(m.a | 0, 0, 4);
        // Back in the lobby re-arms the Wins pads (one claim per trip up the stairs)
        if (inLobby(pl)) s.padArmed = true;
        // Highest step reached: number of step tops stood on (the summit counts as one more)
        const p = s.profile;
        let best = 0;
        for (const st of STAIRS) if (pl.y >= st.h - 1.5 && pl.z >= st.z0 - 1) best = st.k + 1;
        if (pl.y >= SUMMIT.h - 1.5 && pl.z >= SUMMIT.z0 - 1) best = STAIRS.length + 1;
        if (best > (p.best | 0)) {
            p.best = best;
            markDirty();
            this.checkQuest(s);
            this.sendProfile(client.sessionId);
        }
    }

    // One pogo bounce landed: +Power, more the higher you are, times the trampoline under you
    onBounce(client) {
        const s = this.sessions.get(client.sessionId);
        if (!s) return;
        const now = Date.now();
        if (now - s.lastBounce < CFG.minBounce * 1000) return;
        s.lastBounce = now;
        const p = s.profile, pl = s.player;
        let mult = 1;
        const tr = trampAt(pl.x, pl.y, pl.z, now);
        if (tr) {
            if (tr.secret || !this.trampLocked(p, TRAMPS[tr.i])) {
                mult = tr.mult;
                s.trampMult = mult; s.trampSeen = now;
                if (tr.i >= 0 && !(p.tramps && p.tramps[tr.i])) { p.tramps = { ...(p.tramps || {}), [tr.i]: true }; this.checkQuest(s); this.sendProfile(client.sessionId); }
            }
        }
        p.bounces = (p.bounces | 0) + 1;
        this.addPower(s, bounceBase(Math.max(0, pl.y)) * mult, true);
        this.syncPublic(client.sessionId);
        if ((p.bounces & 7) === 0) this.checkQuest(s);
    }

    // "+N Wins" pad on top of step i (i = STAIRS.length is the summit): pays and sends you to the lobby
    onPad(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m) return;
        const i = m.i | 0, summit = i === STAIRS.length;
        if (i < 0 || i > STAIRS.length) return;
        const pl = s.player, at = padPos(i);
        if (Math.abs(pl.y - at.y) > 6 || Math.abs(pl.z - at.z) > 14 || Math.abs(pl.x - at.x) > 14) return;
        if (!s.padArmed || !this.cooldown(s, 'pad', 2)) return;
        s.padArmed = false;
        const got = this.addWins(s, summit ? SUMMIT.wins : STAIRS[i].wins, true);
        if (summit) s.profile.summits = (s.profile.summits | 0) + 1;
        this.changed(client.sessionId);
        client.send('wins', { n: got, summit });
    }

    // Power Gem i touched: position-checked, each gem pays a player once per GEM_RESPAWN seconds
    onGem(client, m) {
        const s = this.sessions.get(client.sessionId);
        const g = m && GEMS[m.i | 0];
        if (!s || !g) return;
        const pl = s.player, now = Date.now();
        if (Math.abs(pl.x - g.x) > 8 || Math.abs(pl.y + 3 - g.y) > 10 || Math.abs(pl.z - g.z) > 8) return;
        if ((s.gems.get(g.i) || 0) > now) return;
        s.gems.set(g.i, now + GEM_RESPAWN * 1000);
        const got = this.addPower(s, gemValue(g), true);
        this.syncPublic(client.sessionId);
        client.send('gem', { i: g.i, n: got });
    }

    // Group Chest in the lobby: once every GROUP_CHEST.hours
    onChest(client) {
        const s = this.sessions.get(client.sessionId);
        if (!s) return;
        const p = s.profile, left = (p.chestAt || 0) + GROUP_CHEST.hours * 3600000 - Date.now();
        if (left > 0) return this.toast(s, 'Chest refills in ' + Math.ceil(left / 3600000) + 'h', BLUE);
        p.chestAt = Date.now();
        this.addPower(s, GROUP_CHEST.power, false);
        this.addWins(s, GROUP_CHEST.wins, false);
        this.toast(s, 'Chest claimed! +' + fmt(GROUP_CHEST.power) + ' Power & +' + GROUP_CHEST.wins + ' Wins', GOLD);
        client.send('fx', { kind: 'confetti' });
        this.changed(client.sessionId);
    }

    // Pogo skins: unlock with Wins (spends them) or a pass, then equip
    onPogo(client, m) {
        const s = this.sessions.get(client.sessionId);
        const def = m && pogoById[m.id];
        if (!s || !def) return;
        const p = s.profile;
        p.pogos = p.pogos || { Basic: true };
        if (!p.pogos[def.id]) {
            if (def.pass) {
                if (!p.passes[def.pass]) return this.toast(s, def.name + ' is a game pass!', BLUE);
            } else {
                if (p.wins < def.cost) return this.toast(s, 'You need ' + Math.max(1, Math.round((1 - p.wins / def.cost) * 100)) + '% more Wins!', RED);
                p.wins -= def.cost;
            }
            p.pogos[def.id] = true;
            p.pogo = def.id;
            this.toast(s, 'x' + def.mult + ' Power unlocked and equipped!', GREEN);
            client.send('fx', { kind: 'confetti' });
        } else {
            if (p.pogo === def.id) return;
            p.pogo = def.id;
            this.toast(s, 'x' + def.mult + ' Power equipped!', GREEN);
        }
        this.changed(client.sessionId);
    }

    onTrail(client, m) {
        const s = this.sessions.get(client.sessionId);
        const t = m && trailById[m.id];
        if (!s || !t) return;
        const p = s.profile;
        const unlocked = t.pass ? p.passes[t.pass] : p.rebirths >= t.reb;
        if (!unlocked) return this.toast(s, t.pass ? 'Game pass trail!' : 'Need ' + t.reb + ' Rebirths!', RED);
        p.trail = t.id;
        this.toast(s, t.name + ' equipped! x' + t.mult + ' Power', BLUE);
        this.changed(client.sessionId);
    }

    onRebirth(client) {
        const s = this.sessions.get(client.sessionId);
        if (!s) return;
        const p = s.profile, need = rebirthLevel(p.rebirths);
        if (p.level < need) return this.toast(s, 'Reach Level ' + need + ' to Rebirth!', RED);
        p.rebirths++;
        p.level = 0; p.xp = 0; p.customJP = 0;
        // Newly unlocked rebirth trail goes straight on if it's better
        const best = TRAILS.filter((t) => !t.pass && p.rebirths >= t.reb).pop();
        if (best && best.mult > (trailById[p.trail] || TRAILS[0]).mult) p.trail = best.id;
        this.toast(s, 'REBIRTH! +' + Math.round(p.rebirths * CFG.rebirthStep * 100) + '% Power, +' + CFG.jpPerRebirth * p.rebirths + ' Jump Power', BLUE);
        client.send('fx', { kind: 'confetti' });
        client.send('rebirthed', {});
        this.changed(client.sessionId);
    }

    onFree(client, m) {
        const s = this.sessions.get(client.sessionId);
        const i = m ? m.i | 0 : -1;
        const r = FREE[i];
        if (!s || !r || s.freeClaimed[i]) return;
        if ((Date.now() - s.joinedAt) / 60000 < r.min) return;
        s.freeClaimed[i] = true;
        this.giveReward(s, r);
        this.toast(s, 'Claimed ' + rewardText(r) + '!', GREEN);
        client.send('fx', { kind: 'confetti' });
        this.changed(client.sessionId);
    }

    onDaily(client) {
        const s = this.sessions.get(client.sessionId);
        if (!s) return;
        const p = s.profile, now = Date.now();
        const st = dailyStatus(p.daily, now);
        if (!st.can) return this.toast(s, 'Come back tomorrow for more!', BLUE);
        const r = DAILY[st.day];
        p.daily = { last: dayKey(now), streak: st.streak + 1 };
        this.giveReward(s, r);
        this.toast(s, 'Day ' + p.daily.streak + ' streak! ' + rewardText(r), GREEN);
        client.send('fx', { kind: 'confetti' });
        this.changed(client.sessionId);
    }

    // Demo mode grants for free. In Bux mode (LEGION_WEBHOOK_SECRET set) only the webhook grants.
    onBuy(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m) return;
        if (BUX_MODE) return this.toast(s, 'Purchases use Bux - log in to Bloxity', BLUE);
        this.grant({ ...s, id: client.sessionId }, m.kind, m.key);
    }

    // s is a live session, or a stand-in { profile, client: { send() {} } } for offline players
    grant(s, kind, key) {
        const client = s.client;
        const p = s.profile;
        if (kind === 'pass') {
            const pass = PASSES[key];
            if (!pass) return false;
            if (p.passes[key]) { this.toast(s, pass.name + ' already owned!', BLUE); return true; }
            p.passes[key] = true;
            // Pogo passes unlock and equip their pogo, trail passes their trail
            const pg = POGOS.find((x) => x.pass === key);
            if (pg) { p.pogos = { ...(p.pogos || {}), [pg.id]: true }; p.pogo = pg.id; }
            const t = TRAILS.find((x) => x.pass === key);
            if (t) p.trail = t.id;
            this.toast(s, pass.name + ' unlocked!', GREEN);
        } else {
            const prod = PRODUCTS[key];
            if (!prod) return false;
            if (key === 'PowerBoost') {
                p.boostUntil = Math.max(Date.now(), p.boostUntil) + CFG.boostMinutes * 60000;
                this.toast(s, 'x2 Power Boost active!', GOLD);
            }
            if (key === 'StarterPack') {
                if (p.claimedPack) { this.toast(s, 'Starter Pack already claimed!', BLUE); return true; }
                p.claimedPack = true;
            }
            if (prod.levels && p.level < CFG.maxLevel) {
                const old = p.level;
                p.level = Math.min(CFG.maxLevel, p.level + prod.levels);
                p.xp = 0;
                if (s.client && s.client.send) this.sendLevelUp(s, old);
            }
            if (prod.power) { this.addPower(s, prod.power, false); this.toast(s, '+' + fmt(prod.power) + ' Power!', GREEN); }
            if (prod.wins) { this.addWins(s, prod.wins, false); this.toast(s, '+' + fmt(prod.wins) + ' Wins!', GOLD); }
        }
        client.send('fx', { kind: 'confetti' });
        if (s.id) this.changed(s.id); else markDirty();
        return true;
    }

    // Custom Jump Power: anything from 20 up to your max (0 = max)
    onCustom(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m) return;
        const p = s.profile;
        const max = jumpPowerFor(p.level, p.rebirths);
        const v = Math.floor(Number(m.v) || 0);
        p.customJP = v <= 0 || v >= max ? 0 : clamp(v, 20, max);
        this.toast(s, 'Jump Power set to ' + (p.customJP || max), BLUE);
        this.changed(client.sessionId);
    }

    // ----- Bloxity -----
    // Logged in to Bloxity after joining: move this session onto the Bloxity profile
    async onBloxityLogin(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m || s.authing) return;
        s.authing = true;
        const legion = await verifyBloxityToken(m.token);
        s.authing = false;
        if (!legion || !this.sessions.has(client.sessionId)) return;
        const uid = 'legion_' + legion.id;
        if (s.profile.uid === uid) return;
        const name = cleanName(legion.name) || s.profile.name;
        const guestProfile = s.profile;
        await adoptGuestProgress(uid, guestProfile.uid, name);
        await loadProfile(uid);
        if (!this.sessions.has(client.sessionId)) return;
        s.profile = getProfile(uid, name, randomName());
        if (!isOnline(guestProfile.uid)) releaseProfile(guestProfile.uid, isOnline);
        s.player.name = s.profile.name;
        this.changed(client.sessionId);
        client.send('authed', { name: s.profile.name });
        this.toast(s, 'Logged in as ' + s.profile.name, GREEN);
        this.broadcastBoards();
    }
    onAvatar(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (s && m) s.player.av = cleanAvatar(m.av);
    }
    // Emote ids are opaque catalogue ids; other players play the same clip
    onEmote(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m || typeof m.id !== 'string' || m.id.length > 40) return;
        this.broadcast('emote', { s: client.sessionId, id: m.id }, { except: client });
    }
    onChat(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m || typeof m.text !== 'string') return;
        const now = Date.now();
        if (now - s.lastChat < 800) return;
        s.lastChat = now;
        const text = m.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (text) this.broadcast('chat', { s: client.sessionId, name: s.profile.name, text });
    }
    // Friend Boost: the client counts its Bloxity friends among the names in this room.
    // Only names actually present here are counted, and the bonus is capped.
    onFriends(client, m) {
        const s = this.sessions.get(client.sessionId);
        if (!s || !m || !Array.isArray(m.names)) return;
        const here = new Set([...this.sessions.values()].filter((o) => o !== s).map((o) => o.profile.name));
        const n = new Set(m.names.slice(0, 50).map(String).filter((x) => here.has(x))).size;
        const friends = Math.min(CFG.friendMax, n);
        if (friends === s.friends) return;
        s.friends = friends;
        s.player.friends = friends;
    }
}

function isOnline(uid) {
    for (const room of liveRooms) for (const s of room.sessions.values()) if (s.profile.uid === uid) return true;
    return false;
}

// Grants a Bux purchase confirmed by the Bloxity webhook, whether or not the player is online
export async function grantPurchase(uid, name, kind, key, tx) {
    for (const room of liveRooms) {
        for (const [id, s] of room.sessions) {
            if (s.profile.uid === uid) return room.grant({ ...s, id }, kind, key);
        }
    }
    // Not on this pod: the pod hosting them (or their next join) applies it
    if (USE_DB) { await queueGrant(uid, name, kind, key, tx); return true; }
    await loadProfile(uid);
    const profile = getProfile(uid, name, randomName());
    const stub = { profile, client: { send() {} } };
    const proto = PogoRoom.prototype;
    return proto.grant.call({ toast() {}, addPower: proto.addPower, addWins: proto.addWins, giveReward: proto.giveReward, sendLevelUp() {}, changed() {} }, stub, kind, key);
}
