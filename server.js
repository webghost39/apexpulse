const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { addRecord } = require('./records');
const { computeOutcome, wheelSlices, pickWinner, landAngle } = require('./team-logic');
const { auditPlayerBehavior } = require('./audit-logic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));

const MATCH_WINDOW = Number(process.env.MATCH_WINDOW) || 60;     // global deadline after lock (s)
const PLAYER_DURATION = Number(process.env.PLAYER_DURATION) || 30; // each player's own run length (s)
const GRACE = 3;           // extra seconds before server force-ends the window

// Anti-cheat thresholds (override via env to tune sensitivity)
const AC = {
    PERFECT_PX:   Number(process.env.AC_PERFECT_PX)   || 1.2,  // <= this px from center counts as pixel-perfect
    AIMBOT_RATIO: Number(process.env.AC_AIMBOT_RATIO) || 0.8,  // ban if pixelPerfect/hits exceeds this
    AIMBOT_MIN_HITS: Number(process.env.AC_AIMBOT_MIN_HITS) || 8, // ...with at least this many hits
    FAST_MS:      Number(process.env.AC_FAST_MS)      || 45,   // clicks closer than this (ms) are "extreme fast"
    FAST_MAX:     Number(process.env.AC_FAST_MAX)     || 8,    // ban if more than this many extreme-fast intervals
};

// ===== All-time top-8 records (persisted; max 8 entries so sync writes are fine) =====
const RECORDS_FILE = process.env.RECORDS_FILE || path.join(__dirname, 'records.json');
let records = [];
try {
    records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    if (!Array.isArray(records)) records = [];
} catch (e) {
    if (e.code !== 'ENOENT') console.log(`[WARN] ${RECORDS_FILE} unreadable (${e.message}), starting with empty records`);
}
function saveRecords() {
    try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2)); }
    catch (e) { console.log(`[WARN] failed to write ${RECORDS_FILE}: ${e.message}`); }
}

app.get('/api/leaderboard', (req, res) => res.json(records));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leaderboard.html')));

// Real-time In-memory Database Room Registry
const rooms = {};

function leaderboardOf(room) {
    return Object.values(room.players);
}

// Build { A:{count,total}, B:{count,total} } from a room's players (cheaters already 0).
function teamSummary(room) {
    const teams = { A: { count: 0, total: 0 }, B: { count: 0, total: 0 } };
    Object.values(room.players).forEach(p => {
        if (p.team === 'A' || p.team === 'B') {
            teams[p.team].count++;
            teams[p.team].total += (p.isCheater ? 0 : p.score);
        }
    });
    return teams;
}

// End the whole match for everyone, broadcast final standings.
function endMatch(roomId) {
    const room = rooms[roomId];
    if (!room || room.status !== 'open') return;
    room.status = 'ended';
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    // anyone who never started / never finished is locked in at their current score
    Object.values(room.players).forEach(p => { if (p.status !== 'finished') p.status = 'finished'; });
    let base;
    if (room.teamMode) {
        const teams = teamSummary(room);
        room.teams = teams;
        room.outcome = computeOutcome(teams);
        base = { players: leaderboardOf(room), teamMode: true, teams, outcome: room.outcome };
    } else {
        base = { players: leaderboardOf(room), teamMode: false };
    }
    // per-socket: everyone gets all summaries (via players), plus their OWN full click log
    Object.values(room.players).forEach(p => {
        io.to(p.id).emit('match_over', { ...base, myLog: room.logs[p.id] || null });
    });
}

// End early only if EVERY player already finished their own run.
function checkAllFinished(roomId) {
    const room = rooms[roomId];
    if (!room || room.status !== 'open') return;
    const players = Object.values(room.players);
    if (players.length === 0) return;
    if (players.every(p => p.status === 'finished')) endMatch(roomId);
}

io.on('connection', (socket) => {

    // 1. Join Room Event (blocked once host has locked the match)
    socket.on('join_room', ({ roomId, playerName }) => {
        const existing = rooms[roomId];
        if (existing && existing.locked) {
            socket.emit('join_denied', { reason: 'Match already started' });
            return;
        }
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { players: {}, host: socket.id, locked: false, status: 'lobby', seed: 0, startAt: 0, timer: null, createdAt: Date.now(), teamMode: false, wheelSpun: false, outcome: null, teamNames: { A: 'A', B: 'B' }, logs: {}, emojiMode: false };
        }
        const room = rooms[roomId];
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            status: 'waiting',
            isCheater: false,
            team: null
        };
        socket.emit('room_state', { hostId: room.host, status: room.status });
        socket.emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // Host toggles team mode (lobby only). Clears all team picks.
    socket.on('set_team_mode', ({ roomId, enabled }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'lobby') return;
        room.teamMode = !!enabled;
        Object.values(room.players).forEach(p => { p.team = null; });
        io.to(roomId).emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // Host renames the teams (lobby only). Empty / blank falls back to A / B.
    socket.on('set_team_names', ({ roomId, names }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'lobby') return;
        const clean = (v, fallback) => {
            const s = (typeof v === 'string' ? v : '').trim().slice(0, 14);
            return s.length ? s : fallback;
        };
        room.teamNames = { A: clean(names && names.A, 'A'), B: clean(names && names.B, 'B') };
        io.to(roomId).emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
    });

    // Host toggles emoji mode (lobby only): every click advances; miss shows 🤣 next.
    socket.on('set_emoji_mode', ({ roomId, enabled }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'lobby') return;
        room.emojiMode = !!enabled;
        io.to(roomId).emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
    });

    // Any player picks a team while in team mode (lobby only).
    socket.on('select_team', ({ roomId, team }) => {
        const room = rooms[roomId];
        if (!room || !room.teamMode || room.status !== 'lobby') return;
        if (team !== 'A' && team !== 'B') return;
        const player = room.players[socket.id];
        if (!player) return;
        player.team = team;
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // 2. Host locks the room and opens the 60s match window. Players start their own 30s runs individually.
    socket.on('lock_start', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.locked) return;
        if (room.teamMode) {
            const counts = { A: 0, B: 0 };
            Object.values(room.players).forEach(p => { if (p.team === 'A' || p.team === 'B') counts[p.team]++; });
            if (counts.A < 1 || counts.B < 1) {
                socket.emit('lock_denied', { reason: 'Each team needs at least 1 player before starting.' });
                return;
            }
        }
        room.locked = true;
        room.status = 'open';
        room.wheelSpun = false;
        room.outcome = null;
        room.seed = Math.floor(Math.random() * 1000000); // shared seed => same target sequence
        room.startAt = Date.now();
        room.deadline = room.startAt + MATCH_WINDOW * 1000;
        Object.values(room.players).forEach(p => {
            p.status = 'ready';   // can start their own run any time within the window
            p.score = 0;
            p.isCheater = false;
            p.summary = null;
        });
        room.logs = {};
        io.to(roomId).emit('match_open', {
            seed: room.seed,
            window: MATCH_WINDOW,
            playerDuration: PLAYER_DURATION,
            startAt: room.startAt,
            deadline: room.deadline,
            emojiMode: room.emojiMode
        });
        io.to(roomId).emit('room_update', leaderboardOf(room));
        // Hard deadline: end the whole window even if some never start/submit.
        room.timer = setTimeout(() => endMatch(roomId), (MATCH_WINDOW + GRACE) * 1000);
    });

    // 2b. A player begins their individual run.
    socket.on('player_start', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'open' || !room.players[socket.id]) return;
        const player = room.players[socket.id];
        if (player.status !== 'ready') return; // can only start once
        player.status = 'playing';
        player.score = 0;
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // 3. Score Real-time Synchronization (only for players mid-run)
    socket.on('sync_score', ({ roomId, currentScore }) => {
        const room = rooms[roomId];
        if (room && room.status === 'open' && room.players[socket.id] && room.players[socket.id].status === 'playing') {
            room.players[socket.id].score = currentScore;
            io.to(roomId).emit('room_update', leaderboardOf(room));
        }
    });

    // 4. Secure Score Submission and Anti-Cheat Matrix Check
    socket.on('submit_score', ({ roomId, verifyStream, finalScore }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'open' || !room.players[socket.id]) return;
        const player = room.players[socket.id];
        if (player.status !== 'playing') return; // must be mid-run; ignore double submit

        // room's flag (never client-supplied) drives the replay's advance rule
        const auditResult = auditPlayerBehavior(verifyStream, room.seed, AC, room.emojiMode);

        if (auditResult.passed) {
            // server-authoritative: trust the replayed score, not the client's claim
            player.score = auditResult.score;
            player.summary = auditResult.summary;
            room.logs[socket.id] = auditResult.clickLog;
            // historical top 8: verified competitive runs only (no emoji-mode, no zero scores;
            // JT mode never submits, cheaters take the else branch)
            if (!room.emojiMode && auditResult.score > 0) {
                records = addRecord(records, {
                    name: String(player.name).slice(0, 20),
                    score: auditResult.score,
                    accuracy: auditResult.summary.accuracy,
                    date: new Date().toISOString()
                });
                saveRecords();
            }
            if (Math.abs(auditResult.score - finalScore) > 0) {
                console.log(`[WARN] Score mismatch for ${player.name}: claimed ${finalScore}, server ${auditResult.score}. Using server value.`);
            }
        } else {
            player.score = 0;
            player.isCheater = true;
            console.log(`[ALERT] Player ${player.name} banned. Reason: ${auditResult.reason} | ${JSON.stringify(auditResult.stats || auditResult)}`);
        }
        player.status = 'finished';
        io.to(roomId).emit('room_update', leaderboardOf(room));
        checkAllFinished(roomId); // whichever comes first: all done -> end now
    });

    // Host spins the tie-break wheel. Server decides the winner authoritatively.
    socket.on('spin_wheel', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'ended') return;
        if (!room.teamMode || !room.outcome || room.outcome.type !== 'WHEEL_ELIGIBLE') return;
        if (room.wheelSpun) return;
        room.wheelSpun = true;
        const { sliceA, sliceB } = wheelSlices(room.teams.A.total, room.teams.B.total);
        const winner = pickWinner(sliceA, Math.random);
        const angle = landAngle(winner, sliceA, Math.random);
        room.finalWinner = winner;
        io.to(roomId).emit('wheel_result', { sliceA, sliceB, winner, landAngle: angle });
    });

    // Host declines the wheel and decides by raw totals (only meaningful when totals differ).
    socket.on('decide_by_score', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'ended') return;
        if (!room.teamMode || !room.outcome || room.outcome.type !== 'WHEEL_ELIGIBLE') return;
        if (room.wheelSpun) return;
        room.wheelSpun = true;
        const a = room.teams.A.total, b = room.teams.B.total;
        const winner = a === b ? null : (a > b ? 'A' : 'B');
        room.finalWinner = winner;
        io.to(roomId).emit('team_result', { winner });
    });

    // 5. Host resets the room back to lobby for another round.
    socket.on('reset_room', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        room.locked = false;
        room.status = 'lobby';
        room.wheelSpun = false;
        room.outcome = null;
        room.finalWinner = null;
        if (room.timer) { clearTimeout(room.timer); room.timer = null; }
        room.logs = {};
        Object.values(room.players).forEach(p => {
            p.status = 'waiting';
            p.score = 0;
            p.isCheater = false;
            p.summary = null;
        });
        io.to(roomId).emit('room_reset');
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // 6. Connection Drop Lifecycles
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players[socket.id]) {
                const wasHost = room.host === socket.id;
                delete room.players[socket.id];
                const remaining = Object.keys(room.players);
                if (remaining.length === 0) {
                    if (room.timer) clearTimeout(room.timer);
                    delete rooms[roomId];
                } else {
                    if (wasHost) {
                        room.host = remaining[0]; // migrate host to next player
                        io.to(roomId).emit('host_changed', { hostId: room.host });
                    }
                    io.to(roomId).emit('room_update', leaderboardOf(room));
                    checkAllFinished(roomId); // a leaver may have been the last one playing
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`  APEXPULSE CORE SERVER IS RUNNING ON PORT: ${PORT}`);
    console.log(`  Local Domain: http://localhost:${PORT}`);
    console.log(`  Build: team-mode+wheel, anti-cheat v2 (pixel-perfect)`);
    console.log(`  Anti-cheat thresholds: ${JSON.stringify(AC)}`);
    console.log(`====================================================`);
});
