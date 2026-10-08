import { $ } from './engine.js';
import { S, actions, net } from './state.js';
import * as BX from './bloxity.js';
import { sfx, getVolumes, setVolume } from './audio.js';
import { QUALITIES, getQuality, setQuality } from './fx.js';
import { pad, SETUP_STEPS, startSetup, skipSetupStep, cancelSetup, resetLayout, setupActive } from './gamepad.js';
import {
    CFG, STAIRS, SUMMIT, PRODUCTS, PASSES, OFFERS, POGOS, TRAILS, QUESTS, FREE, DAILY, dailyStatus, rewardText, xpFor, jumpPowerFor,
    rebirthLevel, powerMult, powerButtons, fmt, clock, clamp,
} from '../../shared/config.js';

// Bux coin + amount (our own strings only; never user text)
const bux = (n) => '<i class="bx" aria-hidden="true"></i>' + fmt(n);
function setHtml(node, html) { if (node && node.innerHTML !== html) node.innerHTML = html; }
function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }

const el = {
    wins: $('#winsVal'), online: $('#onlineVal'), jp: $('#jpTxt'), total: $('#totalTxt'),
    xpFill: $('#xpFill'), levelTxt: $('#levelTxt'), xpTxt: $('#xpTxt'), maxJp: $('#maxJpTxt'), input: $('#jpInput'),
    price2x: $('#price2x'), totalBoost: $('#totalBoost'), boost: $('#boost'), freeBadge: $('#freeBadge'), dailyBadge: $('#dailyBadge'),
    offer: $('#offer'), offerIc: $('#offerIc'), offerTitle: $('#offerTitle'), offerSub: $('#offerSub'),
    prompt: $('#promptBtn'), promptTxt: $('#promptTxt'), rebBadge: $('#rebirthBadge'), quest: $('#quest'), run: $('#runInfo'), runTxt: $('#runTxt'), altFill: $('#altFill'), altBest: $('#altBest'),
    buys: [...document.querySelectorAll('#powerBuys [data-slot]')],
};
export const promptEl = el.prompt, promptTxtEl = el.promptTxt;

// ----- HUD -----
const shown = { wins: null, power: null };
function bump(node) { node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop'); }
// Wins and Total Power count up smoothly to their new values
export function animateCounters(dt) {
    for (const key of ['wins', 'power']) {
        const target = S[key];
        if (shown[key] === null) shown[key] = target;
        if (shown[key] === target) continue;
        const diff = target - shown[key];
        shown[key] = Math.abs(diff) < 1 ? target : shown[key] + diff * Math.min(1, dt * 8);
        if (Math.abs(target - shown[key]) < Math.max(1, target * 0.002)) shown[key] = target;
        if (key === 'wins') el.wins.textContent = fmt(shown.wins);
        else setText(el.total, 'Total Power: ' + fmt(shown.power));
    }
}

// h = { jp: current Jump Power, step: step index under the player or -1, y: height }
export function updateHud(h, online) {
    el.online.textContent = online;
    const need = xpFor(Math.min(S.level, CFG.maxLevel));
    el.xpFill.style.width = clamp(S.xp / need * 100, 0, 100) + '%';
    setText(el.levelTxt, S.level >= CFG.maxLevel ? 'Level MAX' : 'Level ' + S.level);
    setText(el.xpTxt, fmt(S.xp) + ' / ' + fmt(need));
    setText(el.jp, 'Jump Power: ' + h.jp.toFixed(1));
    const max = jumpPowerFor(S.level, S.rebirths);
    setText(el.maxJp, 'MAX: ' + fmt(max));
    if (document.activeElement !== el.input) el.input.value = S.customJP > 0 && S.customJP <= max ? S.customJP : max;
    setText(el.totalBoost, '(Total boost) x' + fmtMult(powerMult(S, net.now(), S.friends)));
    setHtml(el.price2x, S.passes.DoublePower ? '✅ OWNED' : 'ONLY ' + bux(PASSES.DoublePower.price) + '!');
    el.rebBadge.hidden = S.level < rebirthLevel(S.rebirths);
    const boostLeft = (S.boostUntil - net.now()) / 1000;
    el.boost.hidden = boostLeft <= 0;
    if (boostLeft > 0) setText(el.boost, '⚡2x ' + clock(boostLeft));
    const mins = (net.now() - S.joinedAt) / 60000;
    el.freeBadge.hidden = !FREE.some((r, i) => mins >= r.min && !S.freeClaimed[i]);
    el.dailyBadge.hidden = !dailyStatus(S.daily, net.now()).can;
    // The +Power buttons get bigger from Level 50 (+1M / +10M / +25M)
    const keys = powerButtons(S.level);
    el.buys.forEach((b, i) => { if (b.dataset.key !== keys[i]) { b.dataset.key = keys[i]; b.textContent = '⚡' + PRODUCTS[keys[i]].name; } });
    // On the stairs: which step and how high
    if (h.y > 6) {
        const st = h.step >= 0 ? 'Step ' + (h.step + 1) + '/' + STAIRS.length + '  ·  ' : '';
        setText(el.runTxt, st + '⛰️ ' + Math.round(h.y) + ' STUD');
        el.run.hidden = false;
        // Altitude bar: where you are on the stairs, and a marker for your best
        el.altFill.style.width = clamp(h.y / SUMMIT.h * 100, 0, 100).toFixed(1) + '%';
        const best = S.best > STAIRS.length ? SUMMIT.h : S.best > 0 ? STAIRS[S.best - 1].h : 0;
        el.altBest.style.left = clamp(best / SUMMIT.h * 100, 0, 100).toFixed(1) + '%';
    } else el.run.hidden = true;
    updateQuest();
    updateOffer();
    if (!$('#modal').hidden && modalKind === 'free') renderFree();
    if (!$('#daily').hidden) renderDaily();
    if (!$('#modal').hidden && modalKind === 'settings') renderPadStatus();
}
const fmtMult = (m) => (m >= 100 ? fmt(Math.round(m)) : String(Math.round(m * 10) / 10));
el.buys.forEach((b) => b.addEventListener('click', () => buy('product', b.dataset.key || 'Power10K')));
el.input.addEventListener('change', () => net.send('custom', { v: Number(el.input.value) || 0 }));

// Live controller check in Settings: is one detected, which layout, what it's sending
function renderPadStatus() {
    const st = $('#padStatus'), live = $('#padLive'), acts = $('#padActs');
    if (!st) return;
    const i = pad.info;
    if (acts) acts.hidden = !i || setupActive();
    if (setupActive()) return;
    if (!i) {
        let seen = 0;
        try { seen = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean).length; } catch (e) { seen = 0; }
        setText(st, 'Not detected');
        setText(live, seen ? 'The browser sees a controller but it is not connected yet: press any button on it.'
            : 'The browser sees no controller. Click the game, then press a button on the controller. Using DS4Windows? Its Xbox 360 output (ViGEmBus) must be on, and HidHide must not hide controllers from your browser.');
        return;
    }
    setText(st, i.id.replace(/\s*\(.*$/, '').slice(0, 34) + (i.custom ? ' (your setup)' : i.mapping === 'standard' ? '' : ' (generic)'));
    setText(live, 'Sticks: ' + i.axes.join(', ') + '  ·  Buttons: ' + (i.down.join(' ') || '-') +
        (i.mapping !== 'standard' && !i.custom ? '  ·  Buttons mixed up? Press "Set up controller".' : ''));
}
// Controller setup: one prompt per button / stick direction; the gamepad module listens and saves the map
function runPadSetup() {
    const box = $('#padSetup');
    if (!box) return;
    const show = (st) => {
        if (st.done) {
            box.hidden = true;
            toast('🎮 Controller set up!', '#7dff6b');
            renderPadStatus();
            return;
        }
        const step = SETUP_STEPS[st.step];
        box.hidden = false;
        box.querySelector('.ps-step').textContent = 'Step ' + (st.step + 1) + ' / ' + SETUP_STEPS.length;
        box.querySelector('.ps-text').textContent = step.text;
        sfx('click');
    };
    if (!startSetup(show)) { toast('Press a button on your controller first', '#ffb51c'); return; }
    renderPadStatus();
}

// The objective line at the top
function updateQuest() {
    const q = QUESTS[S.quest | 0];
    if (!q) { setText(el.quest, 'All done! Keep bouncing for the leaderboards!'); el.quest.classList.add('done'); return; }
    const [have, need] = q.done(S);
    setText(el.quest, q.text + (need > 1 ? ' (' + fmt(Math.min(have, need)) + '/' + fmt(need) + ')' : '') + '!');
    el.quest.classList.remove('done');
}
export function questDone(m) {
    toast('✅ ' + m.text + '! ' + m.reward, '#ffd028');
    bump(el.quest);
}

// Rotating offer on the right
let offerIdx = 0, offerT = 0, offerDismissed = false;
function updateOffer() {
    const packLeft = CFG.starterPackDuration - (net.now() - S.firstPlay) / 1000;
    const list = OFFERS.filter((o) => (o.key !== 'StarterPack' || (packLeft > 0 && !S.claimedPack)) && !(o.kind === 'pass' && S.passes[o.key]));
    offerT += 0.1;
    if (offerT > CFG.offerRotate) { offerT = 0; offerIdx++; offerDismissed = false; }
    if (!list.length || offerDismissed) { el.offer.hidden = true; return; }
    const o = list[offerIdx % list.length];
    el.offer.hidden = false;
    setText(el.offerIc, o.ic);
    setText(el.offerTitle, o.title);
    const price = o.kind === 'pass' ? PASSES[o.key].price : PRODUCTS[o.key].price;
    setHtml(el.offerSub, (o.key === 'StarterPack' ? '⏰ ' + clock(packLeft) + ' · ' : '') + 'ONLY ' + bux(price));
    el.offer.dataset.kind = o.kind; el.offer.dataset.key = o.key;
}
$('#offerYes').addEventListener('click', () => buy(el.offer.dataset.kind, el.offer.dataset.key));
$('#offerNo').addEventListener('click', () => { offerDismissed = true; el.offer.hidden = true; });

export function toast(text, color) {
    const d = document.createElement('div');
    d.className = 'toast o'; d.textContent = text; d.style.color = color || '#fff';
    const box = $('#toasts');
    box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => d.remove(), 2400);
}
// "NEW HEIGHT! 175 STUD"
export function showRecord(h, top) {
    const r = $('#record');
    $('#recordVal').textContent = top ? 'TOP REACHED!' : h + ' STUD';
    r.hidden = false;
    r.classList.remove('show'); void r.offsetWidth; r.classList.add('show');
    clearTimeout(showRecord.t);
    showRecord.t = setTimeout(() => { r.hidden = true; }, 2500);
}
// Big "+N WINS!" when a Wins pad pays out
export function showGoal(n, summit) {
    const g = $('#goalBanner');
    $('#goalTitle').textContent = '+' + fmt(n) + ' WINS!';
    $('#goalSub').textContent = summit ? 'You reached the top!' : 'Bounce higher for more Wins!';
    g.hidden = false;
    g.classList.remove('show'); void g.offsetWidth; g.classList.add('show');
    clearTimeout(showGoal.t);
    showGoal.t = setTimeout(() => { g.hidden = true; }, 2600);
}
// "Level 2 > Level 3" / "Jump Power 55 > 57.5 (+2.5)", as in the reference
export function levelUp(a, b, jp) {
    const f = $('#flash');
    f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
    $('#levelA').textContent = 'Level ' + a + ' > Level ' + b;
    $('#levelB').textContent = jp ? 'Jump Power ' + jp[0] + ' > ' + jp[1] + ' (+' + (Math.round((jp[1] - jp[0]) * 10) / 10) + ')' : '';
    const d = $('#levelBanner');
    d.classList.remove('show'); void d.offsetWidth; d.classList.add('show');
}

// Trampoline earnings while the player was away
export function showOffline(m) {
    const h = Math.floor(m.secs / 3600), mm = Math.floor((m.secs % 3600) / 60);
    $('#offlineText').textContent = 'Your ' + m.mult + 'x trampoline kept bouncing for ' + (h ? h + 'h ' : '') + mm + 'm while you were away!';
    $('#offlineGain').textContent = '+' + fmt(m.power) + ' Power';
    $('#offlinePop').hidden = false;
    sfx('buy');
}
$('#offlineOk').addEventListener('click', () => { $('#offlinePop').hidden = true; });

// ----- purchases (free in the web demo; the server grants them) -----
let pendingBuy = null;
export function buy(kind, key) {
    if (kind === 'pass' && S.passes[key]) { toast(PASSES[key].name + ' already owned!', '#6fe0ff'); return; }
    const item = kind === 'pass' ? PASSES[key] : PRODUCTS[key];
    if (!item) return;
    if (net.bux) { buyBux(kind, key); return; }
    pendingBuy = { kind, key };
    $('#buyItem').textContent = item.name;
    setHtml($('#buyCost'), bux(item.price) + ' Bux');
    $('#buy').hidden = false;
}
// Bloxity shows its own confirm modal; the grant arrives from the server after its webhook
async function buyBux(kind, key) {
    const r = await BX.buyWithBux(kind, key);
    if (r.success) { toast('Purchase complete!', '#7dff6b'); return; }
    if (r.error && !/cancel/i.test(r.error)) toast(r.error, '#ff5a5a');
}
$('#buyOk').addEventListener('click', () => {
    $('#buy').hidden = true;
    if (pendingBuy) net.send('buy', pendingBuy);
    pendingBuy = null;
});
$('#buyCancel').addEventListener('click', () => { $('#buy').hidden = true; pendingBuy = null; });
$('#btn2x').addEventListener('click', () => buy('pass', 'DoublePower'));
$('#gift').addEventListener('click', () => {
    const packLeft = CFG.starterPackDuration - (net.now() - S.firstPlay) / 1000;
    if (!S.claimedPack && packLeft > 0) buy('product', 'StarterPack'); else openModal('store');
});

// ----- panels -----
let modalKind = null;
export function openModal(kind) { modalKind = kind; renderModal(); $('#modal').hidden = false; }
export function closeModal() { $('#modal').hidden = true; modalKind = null; }
export function refreshModal() { if (!$('#modal').hidden) renderModal(); }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#btnRebirth').addEventListener('click', () => openModal('rebirth'));
$('#btnTrails').addEventListener('click', () => openModal('trails'));
$('#btnReward').addEventListener('click', () => openModal('free'));
$('#btnDaily').addEventListener('click', () => openDaily());
$('#btnStore').addEventListener('click', () => openModal('store'));
$('#winsPlus').addEventListener('click', () => openModal('store'));
$('#btnFriends').addEventListener('click', () => openModal('friends'));
$('#btnWardrobe').addEventListener('click', () => {
    if (BX.bloxity.ready) BX.showCustomizer(); else toast('Bloxity avatars are not available right now', '#ffb51c');
});
$('#btnSettings').addEventListener('click', () => openModal('settings'));
// Every chunky button clicks
document.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('.btn, .rbx, .qb, #gift, #btnSettings')) sfx('click'); });

function renderSettings(body) {
    const vols = getVolumes();
    const w = document.createElement('div');
    w.className = 'settings';
    w.innerHTML = `
        <label class="set-row o1" for="volMusic"><span>🎵 Music</span><input id="volMusic" type="range" min="0" max="100" value="${Math.round(vols.music * 100)}"></label>
        <label class="set-row o1" for="volSfx"><span>🔊 Sound effects</span><input id="volSfx" type="range" min="0" max="100" value="${Math.round(vols.sfx * 100)}"></label>
        <div class="set-row o1"><span>✨ Graphics</span><div class="seg" role="radiogroup" aria-label="Graphics quality"></div></div>
        <p class="set-note">Low turns off glow and shadows for older phones.</p>
        <div class="set-row o1"><span>🎮 Controller</span><span class="pad-status" id="padStatus"></span></div>
        <p class="set-note" id="padLive"></p>
        <div class="pad-acts" id="padActs" hidden><button class="btn g-blue o1" id="padSetupBtn">Set up controller</button><button class="btn g-grey o1" id="padResetBtn">Reset</button></div>
        <div class="pad-setup" id="padSetup" hidden><div class="ps-step o1"></div><div class="ps-text o"></div>
            <div class="pad-acts"><button class="btn g-grey o1" id="padSkipBtn">Skip</button><button class="btn g-red o1" id="padCancelBtn">Cancel</button></div></div>`;
    w.querySelector('#padSetupBtn').addEventListener('click', runPadSetup);
    w.querySelector('#padResetBtn').addEventListener('click', () => { resetLayout(); toast('Controller layout reset', '#6fe0ff'); renderPadStatus(); });
    w.querySelector('#padSkipBtn').addEventListener('click', () => skipSetupStep());
    w.querySelector('#padCancelBtn').addEventListener('click', () => { cancelSetup(); w.querySelector('#padSetup').hidden = true; renderPadStatus(); });
    w.querySelector('#volMusic').addEventListener('input', (e) => setVolume('music', e.target.value / 100));
    w.querySelector('#volSfx').addEventListener('input', (e) => setVolume('sfx', e.target.value / 100));
    const seg = w.querySelector('.seg');
    for (const [key, q] of Object.entries(QUALITIES)) {
        const b = document.createElement('button');
        b.className = 'btn o1 ' + (getQuality() === key ? 'g-green' : 'g-grey');
        b.textContent = q.label;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(getQuality() === key));
        b.addEventListener('click', () => { setQuality(key); renderModal(); });
        seg.appendChild(b);
    }
    body.appendChild(w);
    renderPadStatus();
}

function rowCard(ic, name, desc, btnText, btnClass, onClick, disabled) {
    const d = document.createElement('div');
    d.className = 'row-card';
    d.innerHTML = '<div class="ic"></div><div><div class="nm o1"></div><div class="ds"></div></div><button class="btn o1"></button>';
    d.querySelector('.ic').textContent = ic;
    d.querySelector('.nm').textContent = name;
    d.querySelector('.ds').textContent = desc;
    const b = d.querySelector('button');
    b.classList.add(btnClass);
    setHtml(b, btnText); b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return d;
}
function sec(text) { const d = document.createElement('div'); d.className = 'sec'; d.textContent = text; return d; }

function renderModal() {
    const body = $('#modalBody');
    const title = $('#modalTitle');
    body.innerHTML = '';
    if (modalKind === 'rebirth') {
        title.textContent = 'Rebirth';
        const cur = Math.round(S.rebirths * CFG.rebirthStep * 100), next = cur + Math.round(CFG.rebirthStep * 100);
        const need = rebirthLevel(S.rebirths), ready = S.level >= need;
        const w = document.createElement('div');
        w.className = 'rebirth-box';
        w.innerHTML = `<div class="big o">🔄 ${S.rebirths} Rebirths</div>
            <div class="mult o"><span style="color:#6fe0ff">+${cur}% Power</span><span>➜</span><span style="color:#7dff6b">+${next}% Power</span></div>
            <p>Each rebirth adds +${Math.round(CFG.rebirthStep * 100)}% to all Power you earn and +${CFG.jpPerRebirth} Jump Power, and unlocks new trampolines and trails. Your level resets to 0. You keep Power, Wins and your pogos.</p>
            <p style="color:${ready ? '#7dff6b' : '#ffb51c'};font-weight:700">${ready ? 'Ready to rebirth!' : 'Reach Level ' + need + ' to rebirth (now Level ' + S.level + ')'}</p>`;
        const b = document.createElement('button');
        b.className = 'btn o ' + (ready ? 'g-green' : 'g-grey');
        b.textContent = 'REBIRTH';
        b.disabled = !ready;
        b.addEventListener('click', () => net.send('rebirth'));
        w.appendChild(b);
        body.appendChild(w);
    } else if (modalKind === 'trails') {
        title.textContent = 'Trails';
        for (const t of TRAILS) {
            const owned = t.pass ? S.passes[t.pass] : S.rebirths >= t.reb;
            const on = S.trail === t.id;
            const desc = 'x' + t.mult + ' Power · ' + (t.pass ? 'Game pass' : t.reb ? t.reb + (t.reb === 1 ? ' Rebirth' : ' Rebirths') : 'Free');
            let btn, cls, fn;
            if (on) { btn = 'Equipped'; cls = 'g-grey'; fn = () => {}; }
            else if (owned) { btn = 'Equip'; cls = 'g-green'; fn = () => net.send('trail', { id: t.id }); }
            else if (t.pass) { btn = bux(PASSES[t.pass].price); cls = 'g-pink'; fn = () => buy('pass', t.pass); }
            else { btn = '🔒 Locked'; cls = 'g-grey'; fn = () => toast('Need ' + t.reb + ' Rebirths!', '#ff5a5a'); }
            const card = rowCard(t.id === 'Rainbow' ? '🌈' : '💫', t.name, desc, btn, cls, fn, on);
            card.querySelector('.ic').style.color = '#' + t.color.toString(16).padStart(6, '0');
            if (on) card.classList.add('on');
            body.appendChild(card);
        }
    } else if (modalKind === 'free') {
        title.textContent = 'FREE Rewards';
        renderFree();
    } else if (modalKind === 'friends') {
        title.textContent = 'Friends';
        renderFriends(body);
    } else if (modalKind === 'settings') {
        title.textContent = 'Settings';
        renderSettings(body);
    } else if (modalKind === 'store') {
        title.textContent = 'Shop';
        body.appendChild(sec('Pogos'));
        for (const p of POGOS) {
            const owned = S.pogos && S.pogos[p.id], on = S.pogo === p.id;
            let btn, cls, fn;
            if (on) { btn = 'Equipped'; cls = 'g-grey'; fn = () => {}; }
            else if (owned) { btn = 'Equip'; cls = 'g-green'; fn = () => net.send('pogo', { id: p.id }); }
            else if (p.pass) { btn = bux(PASSES[p.pass].price); cls = 'g-pink'; fn = () => buy('pass', p.pass); }
            else { btn = '🏆 ' + fmt(p.cost); cls = S.wins >= p.cost ? 'g-yellow' : 'g-grey'; fn = () => actions.pogo(p); }
            const card = rowCard(p.pass ? '💎' : '🦘', p.name, 'x' + p.mult + ' Power' + (p.pass ? ' · Game pass' : ''), btn, cls, fn, on);
            if (on) card.classList.add('on');
            body.appendChild(card);
        }
        body.appendChild(sec('Power & Levels'));
        for (const k of ['Power10K', 'Power100K', 'Power1M', 'Power10M', 'Power25M']) {
            const p = PRODUCTS[k];
            body.appendChild(rowCard('⚡', p.name, 'Instant Power (and XP)', bux(p.price), 'g-yellow', () => buy('product', k)));
        }
        body.appendChild(rowCard('⬆️', PRODUCTS.Level5.name, 'Instant levels: +' + CFG.jpPerLevel * 5 + ' Jump Power', bux(PRODUCTS.Level5.price), 'g-red', () => buy('product', 'Level5')));
        body.appendChild(rowCard('⏱️', 'x2 Power Boost', '15 minutes of double Power', bux(PRODUCTS.PowerBoost.price), 'g-yellow', () => buy('product', 'PowerBoost')));
        body.appendChild(sec('Wins'));
        for (const k of ['Wins500', 'Wins5K']) {
            const p = PRODUCTS[k];
            body.appendChild(rowCard('🏆', p.name, 'Spend them on better pogos', bux(p.price), 'g-yellow', () => buy('product', k)));
        }
        body.appendChild(sec('Game passes'));
        for (const k of Object.keys(PASSES)) {
            const p = PASSES[k], owned = !!S.passes[k];
            body.appendChild(rowCard(p.ic, p.name, p.desc, owned ? 'OWNED' : bux(p.price), owned ? 'g-grey' : 'g-green', () => buy('pass', k), owned));
        }
    }
}
// ----- Daily Reward popup (seven cards, a day track, CLAIM REWARD, time left) -----
// Opens by itself once per session when a reward is waiting
let dailyAuto = false;
export function openDailyOnJoin() {
    if (dailyAuto || !S.daily || !net.room) return;
    dailyAuto = true;
    if (dailyStatus(S.daily, net.now()).can) setTimeout(openDaily, 1500);
}
function openDaily() { renderDaily(true); $('#daily').hidden = false; }
$('#dailyClose').addEventListener('click', () => { $('#daily').hidden = true; });
$('#daily').addEventListener('pointerdown', (e) => { if (e.target.id === 'daily') $('#daily').hidden = true; });
$('#dailyClaim').addEventListener('click', () => { net.send('daily'); setTimeout(() => { $('#daily').hidden = true; }, 700); });
let dailySig = '';
function renderDaily(force) {
    const st = dailyStatus(S.daily, net.now());
    const sig = st.can + '|' + st.streak + '|' + st.day;
    if (force || sig !== dailySig) {
        dailySig = sig;
        const cards = $('#dailyCards'), track = $('#dailyTrack');
        cards.innerHTML = ''; track.innerHTML = '';
        DAILY.forEach((r, i) => {
            const done = i < st.streak && (i < st.day || !st.can);
            const d = document.createElement('div');
            d.className = 'dcard' + (done ? ' done' : '') + (i === st.day && st.can ? ' today' : '');
            d.innerHTML = '<span class="di"></span><span class="dr o"></span>';
            d.querySelector('.di').textContent = r.rebirths ? '🔄' : r.wins ? '🏆' : '⚡';
            d.querySelector('.dr').textContent = r.rebirths ? r.rebirths : '+' + fmt(r.power || r.wins);
            d.title = 'Day ' + (i + 1) + ': ' + rewardText(r);
            cards.appendChild(d);
            const dot = document.createElement('div');
            dot.className = 'dot o1' + (i < st.streak + (st.can ? 1 : 0) ? ' on' : '');
            dot.innerHTML = '<i></i><span></span>';
            dot.querySelector('span').textContent = 'Day ' + (i + 1);
            track.appendChild(dot);
        });
        const b = $('#dailyClaim');
        b.disabled = !st.can;
        b.textContent = st.can ? 'CLAIM REWARD' : 'CLAIMED!';
    }
    // Time until the next UTC day (the claim window rolls over at midnight UTC)
    const now = net.now(), next = Math.ceil((now + 1) / 86400000) * 86400000;
    $('#dailyLeft').textContent = (st.can ? 'Time left to claim: ' : 'Next reward in: ') + clock((next - now) / 1000);
}

// Bloxity friends with presence, a shareable invite link and per-friend invites
function renderFriends(body) {
    const note = (text) => { const p = document.createElement('p'); p.className = 'set-note'; p.textContent = text; body.appendChild(p); return p; };
    if (!BX.bloxity.ready) { note('Bloxity is not available right now.'); return; }
    const id = BX.identity();
    const link = document.createElement('div');
    link.className = 'invite-row';
    link.innerHTML = '<input id="inviteLink" readonly aria-label="Invite link"><button class="btn g-green o1" id="copyInvite">Copy link</button>';
    body.appendChild(link);
    const input = link.querySelector('input');
    input.value = BX.getInviteLink();
    link.querySelector('button').addEventListener('click', async () => {
        input.select();
        try { await navigator.clipboard.writeText(input.value); toast('Invite link copied!', '#7dff6b'); }
        catch (e) { document.execCommand && document.execCommand('copy'); toast('Select the link and copy it', '#ffb51c'); }
    });
    if (!id.loggedIn) {
        note('Log in with Bloxity to see your friends and invite them into this server.');
        const b = document.createElement('button');
        b.className = 'btn g-blue o1'; b.textContent = 'Log in with Bloxity';
        b.addEventListener('click', () => BX.login());
        body.appendChild(b);
        return;
    }
    const loading = note('Loading friends…');
    BX.getFriends().then((friends) => {
        if (modalKind !== 'friends') return;
        loading.remove();
        if (!friends.length) { note('No friends yet. Share the invite link above!'); return; }
        const order = { 'in-game': 0, online: 1, away: 2, offline: 3 };
        friends.sort((a, b) => (order[a.presence && a.presence.status] ?? 4) - (order[b.presence && b.presence.status] ?? 4));
        for (const f of friends) {
            const st = (f.presence && f.presence.status) || 'offline';
            const where = st === 'in-game' && f.presence.gameName ? 'Playing ' + f.presence.gameName : st;
            const dot = st === 'offline' ? '⚫' : st === 'away' ? '🟡' : '🟢';
            body.appendChild(rowCard(dot, f.displayName || f.username, where, 'Invite', 'g-green', async (e) => {
                e.currentTarget.disabled = true;
                const ok = await BX.inviteFriend(f._id);
                toast(ok ? 'Invite sent to ' + (f.displayName || f.username) : 'Could not send the invite', ok ? '#7dff6b' : '#ff5a5a');
            }));
        }
    });
}

function renderFree() {
    const body = $('#modalBody');
    body.innerHTML = '';
    const mins = (net.now() - S.joinedAt) / 60000;
    FREE.forEach((r, i) => {
        const claimed = !!S.freeClaimed[i];
        const ready = mins >= r.min;
        const name = rewardText(r);
        const btn = claimed ? 'Claimed' : ready ? 'CLAIM' : clock(r.min * 60 - mins * 60);
        body.appendChild(rowCard(r.power ? '⚡' : r.wins ? '🏆' : '⏱️', name, 'Play for ' + r.min + ' min', btn,
            claimed ? 'g-grey' : ready ? 'g-green' : 'g-blue', () => { if (!claimed && ready) net.send('free', { i }); }, claimed || !ready));
    });
}
