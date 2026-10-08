import { schema, t } from '@colyseus/schema';

// Public, synced to every client. Private progress (passes, pogos,
// boosts...) is sent only to its owner with the "profile" message.
export const PlayerState = schema({
    name: t.string().default(''),
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    ry: t.angle(),
    anim: t.uint8().default(0), // 0 idle, 1 moving, 2 air (rising), 3 splashed, 4 falling
    power: t.number().default(0),
    wins: t.number().default(0),
    level: t.uint8().default(0),
    xp: t.number().default(0),
    rebirths: t.uint16().default(0),
    trail: t.string().default(''),
    pogo: t.string().default('Basic'), // equipped pogo skin
    friends: t.uint8().default(0), // Friend Boost: Bloxity friends in this server
    kit: t.uint8().default(0),
    skin: t.uint8().default(0),
    av: t.string().default(''), // packed Bloxity avatar (equipped ids + proportions)
}, 'PlayerState');

export const GameState = schema({
    players: t.map(PlayerState),
}, 'GameState');
