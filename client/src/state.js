// Local mirror of this player's progress. The server owns the real values:
// public stats arrive through the room state, private ones in "profile" messages.
export const S = {
    power: 0, wins: 0, level: 0, xp: 0, rebirths: 0, friends: 0,
    pogos: { Basic: true }, pogo: 'Basic', tramps: {}, trail: 'Starter', quest: 0, best: 0, passes: {}, daily: null,
    boostUntil: 0, customJP: 0, claimedPack: false, firstPlay: Date.now(),
    freeClaimed: {}, joinedAt: Date.now(), name: '', chestAt: 0, winsTotal: 0,
};

// Game actions that world objects (pads, pogo stands, chests) trigger; filled in by main.js
export const actions = {};

export const net = {
    room: null,
    offset: 0,
    send(type, msg) { if (this.room) this.room.send(type, msg || {}); },
    // Server clock in ms, so timed things (the secret trampoline) line up for everyone
    now() { return Date.now() + this.offset; },
};
