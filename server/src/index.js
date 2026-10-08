import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config, { listen } from '@colyseus/tools';
import { defineRoom } from 'colyseus';
import express from 'express';
import { PogoRoom, grantPurchase } from './PogoRoom.js';
import { WEBHOOK_SECRET, installStatReporter } from './bloxity.js';
import { saveProfiles, firstDelivery } from './profiles.js';
import { skuLookup } from '../../shared/config.js';

// Serves the built client (client/dist) and the game room on the same port,
// so one Node host is enough to run the whole game.
const CLIENT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

// Bloxity calls this after deducting Bux; answer 2xx within 10 s or the Bux are refunded
async function buxWebhook(req, res) {
    if (WEBHOOK_SECRET && req.get('x-legion-webhook-secret') !== WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'bad secret' });
    }
    const b = req.body || {};
    const item = skuLookup(b.sku);
    if (!b.transactionId || !b.userId || !item) return res.status(400).json({ error: 'unknown purchase' });
    const tx = String(b.transactionId);
    try {
        if (!(await firstDelivery(tx))) return res.json({ ok: true, duplicate: true });
    } catch (e) {
        // Database down: a non-2xx makes Bloxity refund instead of charging for nothing
        console.warn('[Bux]', tx, e.message);
        return res.status(503).json({ error: 'storage unavailable' });
    }
    const ok = await grantPurchase('legion_' + b.userId, String(b.username || '').slice(0, 20), item.kind, item.key, tx).catch(() => false);
    saveProfiles();
    console.log('[Bux]', b.transactionId, b.username, b.sku, ok ? 'granted' : 'rejected');
    return ok ? res.json({ ok: true }) : res.status(400).json({ error: 'grant failed' });
}

const app = config({
    rooms: {
        pogo: defineRoom(PogoRoom),
    },
    initializeExpress: (expressApp) => {
        expressApp.get('/health', (req, res) => res.json({ ok: true }));
        expressApp.post('/api/legion-webhook', express.json({ limit: '32kb' }), buxWebhook);
        if (fs.existsSync(CLIENT_DIST)) expressApp.use(express.static(CLIENT_DIST));
    },
});

const reporter = installStatReporter();
process.once('beforeExit', () => { reporter.flush(); });

listen(app, Number(process.env.PORT) || 2567);
