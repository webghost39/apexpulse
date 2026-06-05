const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

// Real-time In-memory Database Room Registry
const rooms = {};

function leaderboardOf(room) {
    return Object.values(room.players);
}

// End the whole match for everyone, broadcast final standings.
function endMatch(roomId) {
    const room = rooms[roomId];
    if (!room || room.status !== 'open') return;
    room.status = 'ended';
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    // anyone who never started / never finished is locked in at their current score
    Object.values(room.players).forEach(p => { if (p.status !== 'finished') p.status = 'finished'; });
    io.to(roomId).emit('match_over', leaderboardOf(room));
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
            rooms[roomId] = { players: {}, host: socket.id, locked: false, status: 'lobby', seed: 0, startAt: 0, timer: null, createdAt: Date.now() };
        }
        const room = rooms[roomId];
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            score: 0,
            status: 'waiting',
            isCheater: false
        };
        socket.emit('room_state', { hostId: room.host, status: room.status });
        io.to(roomId).emit('room_update', leaderboardOf(room));
    });

    // 2. Host locks the room and opens the 60s match window. Players start their own 30s runs individually.
    socket.on('lock_start', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.locked) return;
        room.locked = true;
        room.status = 'open';
        room.seed = Math.floor(Math.random() * 1000000); // shared seed => same target sequence
        room.startAt = Date.now();
        room.deadline = room.startAt + MATCH_WINDOW * 1000;
        Object.values(room.players).forEach(p => {
            p.status = 'ready';   // can start their own run any time within the window
            p.score = 0;
            p.isCheater = false;
        });
        io.to(roomId).emit('match_open', {
            seed: room.seed,
            window: MATCH_WINDOW,
            playerDuration: PLAYER_DURATION,
            startAt: room.startAt,
            deadline: room.deadline
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

        const auditResult = auditPlayerBehavior(verifyStream, room.seed, finalScore);

        if (auditResult.passed) {
            player.score = finalScore;
        } else {
            player.score = 0;
            player.isCheater = true;
            console.log(`[ALERT] Telemetry fraud caught! Player ${player.name} banned. Reason: ${auditResult.reason}`);
        }
        player.status = 'finished';
        io.to(roomId).emit('room_update', leaderboardOf(room));
        checkAllFinished(roomId); // whichever comes first: all done -> end now
    });

    // 5. Host resets the room back to lobby for another round.
    socket.on('reset_room', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        room.locked = false;
        room.status = 'lobby';
        if (room.timer) { clearTimeout(room.timer); room.timer = null; }
        Object.values(room.players).forEach(p => {
            p.status = 'waiting';
            p.score = 0;
            p.isCheater = false;
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

// Telemetry Heuristics Anti-Cheat Analytics
function auditPlayerBehavior(stream, seed, claimedScore) {
    if (!stream || stream.length === 0) return { passed: false, reason: "NO_TELEMETRY_DATA" };
    let perfectCenterCount = 0;
    let extremeFastCount = 0;
    for (let i = 0; i < stream.length; i++) {
        const action = stream[i];
        if (action.hit && action.offset_r <= 0.5) perfectCenterCount++;
        if (i > 0 && (action.t - stream[i-1].t) < 80) extremeFastCount++;
    }
    if ((perfectCenterCount / stream.length) > 0.4) return { passed: false, reason: "AIBOT_LOCKON_DETECTED" };
    if (extremeFastCount > 3) return { passed: false, reason: "MACRO_AUTOCLICKER_DETECTED" };
    return { passed: true };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`  APEXPULSE CORE SERVER IS RUNNING ON PORT: ${PORT}`);
    console.log(`  Local Domain: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
