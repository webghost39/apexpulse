const fs = require('fs');
const path = require('path');

// Project file structure and contents
const files = {
  'package.json': "{\n  \"name\": \"apexpulse\",\n  \"version\": \"1.0.0\",\n  \"description\": \"ApexPulse - Multiplayer Esports Talent Analytics with Anti-Cheat Matrix\",\n  \"main\": \"server.js\",\n  \"scripts\": {\n    \"start\": \"node server.js\",\n    \"prod\": \"pm2 start server.js --name 'apexpulse'\"\n  },\n  \"dependencies\": {\n    \"express\": \"^4.19.2\",\n    \"socket.io\": \"^4.7.5\"\n  },\n  \"author\": \"Esports Developer\",\n  \"license\": \"ISC\"\n}",

  'server.js': `const express = require('express');
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
            console.log(\`[ALERT] Telemetry fraud caught! Player \${player.name} banned. Reason: \${auditResult.reason}\`);
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
    console.log(\`====================================================\`);
    console.log(\`  APEXPULSE CORE SERVER IS RUNNING ON PORT: \${PORT}\`);
    console.log(\`  Local Domain: http://localhost:\${PORT}\`);
    console.log(\`====================================================\`);
});
`,

  'public/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>ApexPulse - Multiplayer Esports Talent Analytics</title>
    <script src="/socket.io/socket.io.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --bg-color: #0a0b0d; --panel-bg: #13151a; --primary: #00ff88; --accent: #00e5ff; --danger: #ff3860; --text: #e3e6ed; }
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        body { background-color: var(--bg-color); color: var(--text); font-family: 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
        header { background: linear-gradient(90deg, #181b22 0%, #13151a 100%); padding: 15px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #222631; box-shadow: 0 4px 20px rgba(0,0,0,0.5); gap: 12px; }
        .logo { font-size: 22px; font-weight: 800; letter-spacing: 2px; color: var(--primary); font-style: italic; white-space: nowrap; }
        .logo i { margin-right: 8px; font-style: normal; }
        #room-link-box { font-size: 13px; color: #888; background: #20242f; padding: 6px 12px; border-radius: 4px; border: 1px solid #313747; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #copy-link { cursor: pointer; color: var(--accent); margin-left: 6px; }
        main { display: flex; flex: 1; padding: 20px; gap: 20px; height: calc(100vh - 65px); min-height: 0; }
        .panel { background: var(--panel-bg); border-radius: 8px; border: 1px solid #222631; padding: 20px; display: flex; flex-direction: column; min-height: 0; }
        .panel-title { font-size: 15px; font-weight: 700; text-transform: uppercase; margin-bottom: 15px; border-left: 4px solid var(--accent); padding-left: 10px; letter-spacing: 1px; }
        #left-sidebar { width: 300px; }
        .leaderboard-list { flex: 1; overflow-y: auto; list-style: none; }
        .player-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #1a1d26; margin-bottom: 8px; border-radius: 4px; border-left: 3px solid #3a4155; transition: all 0.3s; }
        .player-item.playing { border-left-color: var(--accent); animation: pulse 1.5s infinite; }
        .player-item.finished { border-left-color: var(--primary); }
        .player-item.cheater { border-left-color: var(--danger); background: rgba(255,56,96,0.1); }
        .player-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .rank-num { font-weight: bold; color: #888; width: 20px; }
        .player-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .player-score { font-family: monospace; font-weight: 700; color: var(--primary); }
        .cheater-tag { color: var(--danger); font-size: 11px; font-weight: bold; }
        #center-zone { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; }
        .game-hud { width: 100%; max-width: 800px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding: 0 10px; }
        .hud-item { font-size: 16px; font-weight: bold; letter-spacing: 1px; color: #888; }
        .hud-item span { color: var(--accent); font-family: monospace; font-size: 22px; }
        .btn-finish { background: linear-gradient(135deg, var(--accent) 0%, #00a3b3 100%); color: #001014; font-weight: 800; font-size: 13px; text-transform: uppercase; padding: 8px 18px; border: none; border-radius: 4px; cursor: pointer; letter-spacing: 1px; }
        #canvas-wrapper { position: relative; width: 100%; max-width: 800px; box-shadow: 0 0 30px rgba(0, 255, 136, 0.05); border-radius: 8px; overflow: hidden; }
        canvas { background-color: #111318; border: 2px solid #222631; display: block; cursor: crosshair; width: 100%; height: auto; touch-action: none; }
        .game-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(10,11,13,0.9); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; z-index: 10; padding: 40px; text-align: center; }
        .btn-action { background: linear-gradient(135deg, var(--primary) 0%, #00c86b 100%); color: #000; font-weight: 800; font-size: 15px; text-transform: uppercase; padding: 14px 35px; border: none; border-radius: 4px; cursor: pointer; box-shadow: 0 4px 15px rgba(0,255,136,0.3); transition: transform 0.2s; letter-spacing: 1px; }
        .btn-action:hover { transform: scale(1.05); }
        .btn-action:disabled { background: #2a2f3a; color: #777; box-shadow: none; cursor: not-allowed; transform: none; }
        #right-sidebar { width: 350px; }
        .audit-container { flex: 1; background: #090a0d; border-radius: 4px; padding: 12px; font-family: 'Courier New', monospace; font-size: 11px; overflow-y: auto; color: #00ff66; border: 1px solid #1a1d26; line-height: 1.5; word-break: break-all; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(0,229,255,0.2); } 70% { box-shadow: 0 0 0 6px rgba(0,229,255,0); } 100% { box-shadow: 0 0 0 0 rgba(0,229,255,0); } }

        /* ===== Mobile: game area + leaderboard only ===== */
        @media (max-width: 768px) {
            body { height: auto; min-height: 100vh; overflow: auto; }
            header { padding: 10px 14px; flex-wrap: wrap; }
            .logo { font-size: 18px; }
            #room-link-box { font-size: 11px; max-width: 100%; flex: 1 1 100%; }
            main { flex-direction: column; padding: 12px; gap: 12px; height: auto; }
            #right-sidebar { display: none; }
            #left-sidebar { width: 100%; order: 2; max-height: 38vh; }
            #center-zone { order: 1; width: 100%; }
            .panel { padding: 12px; }
            .game-overlay { padding: 24px; gap: 14px; }
            #overlay-title { font-size: 20px !important; }
        }
    </style>
</head>
<body>
    <header>
        <div class="logo"><i class="fa-solid fa-bolt"></i>APEX PULSE</div>
        <div id="room-link-box">ROOM: <span id="room-url">LOADING...</span><i id="copy-link" class="fa-solid fa-copy" title="Copy invite link"></i></div>
    </header>
    <main>
        <div class="panel" id="left-sidebar">
            <div class="panel-title"><i class="fa-solid fa-trophy" style="color:gold"></i> MATCH LEADERBOARD</div>
            <ul class="leaderboard-list" id="leaderboard">
                <li style="color:#555; text-align:center; margin-top:20px; font-size:14px;">Waiting for players...</li>
            </ul>
        </div>
        <div class="panel" id="center-zone" style="background:transparent; border:none; padding:0;">
            <div class="game-hud">
                <div class="hud-item">SCORE: <span id="score-hud">0000</span></div>
                <button class="btn-finish" id="finish-btn" style="display:none;" onclick="finishMyRun()">FINISH</button>
                <div class="hud-item"><i class="fa-regular fa-clock"></i> <span id="timer-hud">30s</span></div>
            </div>
            <div id="canvas-wrapper">
                <div class="game-overlay" id="overlay">
                    <h2 id="overlay-title" style="font-size:26px; letter-spacing:1px; font-weight:800;">CONNECTING...</h2>
                    <p id="overlay-desc" style="color:#777; font-size:13px; max-width:90%; line-height:1.6;">Joining room.</p>
                    <button class="btn-action" id="action-btn" disabled>PLEASE WAIT</button>
                </div>
                <canvas id="aimCanvas" width="800" height="500"></canvas>
            </div>
        </div>
        <div class="panel" id="right-sidebar">
            <div class="panel-title"><i class="fa-solid fa-shield-halved" style="color:var(--primary)"></i> ANTI-CHEAT SANDBOX LOG</div>
            <div class="audit-container" id="audit-log">[SYSTEM] Security Sandbox initialized successfully.<br>[SYSTEM] Awaiting biological telemetry capture...</div>
        </div>
    </main>
<script>
let socket;
const canvas = document.getElementById('aimCanvas');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

const hash = window.location.hash;
const roomId = hash.includes('/room/') ? hash.split('/room/')[1] : "ROOM_" + Math.random().toString(36).substr(2, 5);
window.location.hash = \`/room/\${roomId}\`;
$('room-url').innerText = window.location.href;

let myName = "", myId = null, hostId = null;
let currentScore = 0, timeLeft = 30, gameSeed = 0;
let playerDuration = 30, windowEndLocal = 0;
let isPlaying = false, myStatus = 'waiting';
let gameInterval = null, windowInterval = null;
let target = { x: 0, y: 0, r: 25 };
let antiCheatStream = [];

function initConnection() {
    myName = prompt("Enter your name:") || "PLAYER_" + Math.floor(Math.random()*900);
    socket = io();
    socket.on('connect', () => {
        myId = socket.id;
        logAudit(\`[SEC_LINK] Secure WebSocket channel established.\`);
        socket.emit('join_room', { roomId, playerName: myName });
    });
    socket.on('room_state', (s) => { hostId = s.hostId; if (myStatus === 'waiting') updateLobbyOverlay(); });
    socket.on('host_changed', (s) => { hostId = s.hostId; if (myStatus === 'waiting') updateLobbyOverlay(); });
    socket.on('room_update', (players) => renderLeaderboard(players));
    socket.on('join_denied', (d) => {
        $('overlay-title').innerText = "MATCH IN PROGRESS";
        $('overlay-desc').innerText = "This room is locked. Wait for the current match to finish, then refresh to join.";
        $('action-btn').style.display = 'none';
    });
    socket.on('match_open', (cfg) => {
        gameSeed = cfg.seed;
        playerDuration = cfg.playerDuration;
        windowEndLocal = Date.now() + cfg.window * 1000; // skew-free local deadline
        openWindowReady();
    });
    socket.on('match_over', (players) => showResults(players));
    socket.on('room_reset', () => resetToLobby());
}

function amHost() { return myId && myId === hostId; }

function updateLobbyOverlay() {
    const ov = $('overlay'), title = $('overlay-title'), desc = $('overlay-desc'), btn = $('action-btn');
    ov.style.display = 'flex';
    btn.style.display = 'inline-block';
    if (amHost()) {
        title.innerText = "HOST CONTROL";
        desc.innerText = "Wait for players to join. Once everyone is in, click Lock & Start to open the match window.";
        btn.innerText = "LOCK & START";
        btn.disabled = false;
        btn.onclick = requestLockStart;
    } else {
        title.innerText = "JOINED ROOM";
        desc.innerText = "Waiting for the host to lock and start the match. Get your reflexes ready.";
        btn.innerText = "WAITING FOR HOST...";
        btn.disabled = true;
        btn.onclick = null;
    }
}

function requestLockStart() { if (socket && socket.connected) socket.emit('lock_start', { roomId }); }
function requestReset() { if (socket && socket.connected) socket.emit('reset_room', { roomId }); }

function windowRemaining() { return Math.max(0, Math.ceil((windowEndLocal - Date.now()) / 1000)); }

function stopWindowTimer() { if (windowInterval) { clearInterval(windowInterval); windowInterval = null; } }

// After host locks: 60s window is open, each player starts their own 30s run when ready.
function openWindowReady() {
    myStatus = 'ready';
    const ov = $('overlay'), title = $('overlay-title'), desc = $('overlay-desc'), btn = $('action-btn');
    ov.style.display = 'flex';
    btn.style.display = 'inline-block';
    btn.onclick = requestPlayerStart;
    title.innerText = "READY — ROOM IS OPEN";
    const refresh = () => {
        const left = windowRemaining();
        const run = Math.min(playerDuration, left);
        desc.innerText = \`Room closes in \${left}s. Your run is \${playerDuration}s — start any time (capped by the window if less time remains).\`;
        if (left <= 0) { btn.disabled = true; btn.innerText = "TIME UP"; stopWindowTimer(); }
        else { btn.disabled = false; btn.innerText = \`START (\${run}s)\`; }
    };
    refresh();
    stopWindowTimer();
    windowInterval = setInterval(refresh, 250);
}

function requestPlayerStart() {
    if (!socket || !socket.connected) return;
    const run = Math.min(playerDuration, windowRemaining());
    if (run <= 0) return;
    stopWindowTimer();
    socket.emit('player_start', { roomId });
    startRun(run);
}

function seededRandom() { let x = Math.sin(gameSeed++) * 10000; return x - Math.floor(x); }
function spawnSeededTarget() {
    target.r = Math.floor(seededRandom() * 10) + 16;
    target.x = seededRandom() * (canvas.width - target.r * 2) + target.r;
    target.y = seededRandom() * (canvas.height - target.r * 2) + target.r;
}

function drawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!isPlaying) return;
    ctx.beginPath(); ctx.arc(target.x, target.y, target.r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0, 255, 136, 0.12)'; ctx.fill(); ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(target.x, target.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#00e5ff'; ctx.fill();
}

function startRun(runDuration) {
    $('overlay').style.display = 'none';
    isPlaying = true; myStatus = 'playing';
    currentScore = 0; antiCheatStream = [];
    timeLeft = runDuration;
    $('score-hud').innerText = "0000";
    $('timer-hud').innerText = timeLeft + "s";
    $('finish-btn').style.display = 'inline-block';
    logAudit(\`[AUDIT_START] Telemetry streaming. Player: \${myName} | Duration \${runDuration}s | Seed: \${gameSeed}\`);
    spawnSeededTarget();
    drawCanvas();
    if (gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(() => {
        timeLeft--;
        $('timer-hud').innerText = Math.max(0, timeLeft) + "s";
        if (socket && socket.connected) socket.emit('sync_score', { roomId, currentScore });
        if (timeLeft <= 0) finishMyRun();
    }, 1000);
}

function pointerHit(clientX, clientY) {
    if (!isPlaying) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (clientX - rect.left) * scaleX;
    const mouseY = (clientY - rect.top) * scaleY;
    const timestamp = performance.now();
    const dist = Math.hypot(mouseX - target.x, mouseY - target.y);
    let isHit = false;
    if (dist <= target.r) { currentScore += 100; isHit = true; spawnSeededTarget(); drawCanvas(); }
    else { currentScore = Math.max(0, currentScore - 40); }
    $('score-hud').innerText = String(currentScore).padStart(4, '0');
    const a = { t: parseFloat(timestamp.toFixed(1)), x: Math.round(mouseX), y: Math.round(mouseY), target_x: Math.round(target.x), target_y: Math.round(target.y), offset_r: parseFloat(dist.toFixed(2)), hit: isHit };
    antiCheatStream.push(a);
    logAudit(\`[STREAM] t:\${a.t}ms | Loc:(\${a.x},\${a.y}) | Offset:\${a.offset_r}px | \${isHit ? '🎯HIT' : '❌MISS'}\`);
}

canvas.addEventListener('mousedown', (e) => pointerHit(e.clientX, e.clientY));
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; pointerHit(t.clientX, t.clientY); }, { passive: false });

function finishMyRun() {
    if (myStatus === 'finished') return;
    isPlaying = false; myStatus = 'finished';
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('finish-btn').style.display = 'none';
    if (socket && socket.connected) socket.emit('submit_score', { roomId, verifyStream: antiCheatStream, finalScore: currentScore });
    $('overlay-title').innerText = "YOU'RE DONE";
    $('overlay-desc').innerText = \`Your score: \${currentScore}. Waiting for other players or the timer to end...\`;
    $('action-btn').style.display = 'none';
    $('overlay').style.display = 'flex';
    logAudit(\`[SUBMIT] Score submitted: \${currentScore}\`);
}

function showResults(players) {
    isPlaying = false;
    stopWindowTimer();
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('finish-btn').style.display = 'none';
    renderLeaderboard(players);
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const me = sorted.find(p => p.id === myId);
    const rank = me ? sorted.indexOf(me) + 1 : '-';
    $('overlay-title').innerText = "MATCH OVER";
    $('overlay-desc').innerText = me
        ? \`Your rank: #\${rank} / \${sorted.length}  ·  Score: \${me.isCheater ? 'CHEATING — BANNED' : me.score}\`
        : "Match finished.";
    const btn = $('action-btn');
    btn.style.display = 'inline-block';
    if (amHost()) { btn.disabled = false; btn.innerText = "PLAY AGAIN"; btn.onclick = requestReset; }
    else { btn.disabled = true; btn.innerText = "WAITING FOR HOST..."; btn.onclick = null; }
    $('overlay').style.display = 'flex';
}

function resetToLobby() {
    isPlaying = false; myStatus = 'waiting';
    currentScore = 0; timeLeft = playerDuration;
    stopWindowTimer();
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    $('score-hud').innerText = "0000";
    $('timer-hud').innerText = playerDuration + "s";
    $('finish-btn').style.display = 'none';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    updateLobbyOverlay();
    logAudit(\`[SYSTEM] Host reset the room. Waiting for the next match...\`);
}

function renderLeaderboard(players) {
    const listEl = $('leaderboard');
    listEl.innerHTML = "";
    const sorted = [...players].sort((a, b) => b.score - a.score);
    if (sorted.length === 0) { listEl.innerHTML = '<li style="color:#555; text-align:center; margin-top:20px; font-size:14px;">Waiting for players...</li>'; return; }
    sorted.forEach((p, index) => {
        const li = document.createElement('li');
        let statusClass = p.status;
        if (p.isCheater) statusClass = 'cheater';
        li.className = \`player-item \${statusClass}\`;
        const hostTag = p.id === hostId ? ' 👑' : '';
        const youTag = p.id === myId ? ' (YOU)' : '';
        li.innerHTML = \`<div class="player-info"><span class="rank-num">#\${index + 1}</span><span class="player-name">\${p.name}\${hostTag}\${youTag}</span></div><div class="player-score">\${p.isCheater ? '<span class="cheater-tag"><i class="fa-solid fa-skull-crossbones"></i> BANNED</span>' : p.score}</div>\`;
        listEl.appendChild(li);
    });
}

function logAudit(msg) { const logBox = $('audit-log'); logBox.innerHTML += \`<br>\${msg}\`; logBox.scrollTop = logBox.scrollHeight; }

$('copy-link').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(window.location.href).then(() => {
        $('copy-link').className = 'fa-solid fa-check';
        setTimeout(() => { $('copy-link').className = 'fa-solid fa-copy'; }, 1200);
    });
});

window.onload = initConnection;
</script>
</body>
</html>
`,

  'README.md': `# 🔥 ApexPulse - Multiplayer Esports Talent Analytics

ApexPulse is a lightweight, high-performance, real-time multiplayer esports aim-training and talent-calibration game. Built with modern UI/UX principles and a server-side statistical anti-cheat audit matrix. Works on desktop and mobile (touch supported).

## 🚀 Features
- **Host-Controlled Rooms:** First player to join is the host. The host waits for everyone, then locks the room and opens the match.
- **Two-Layer Timing:** Locking opens a global **60s window**. Each player runs their own **30s** test individually — start any time within the window. Late starters are capped by the remaining window time.
- **Fair Targets:** All players in a room share the same seed, so everyone gets the identical target sequence.
- **Whichever Comes First:** The match ends when every player has finished OR the 60s window closes — whichever happens first.
- **Server-Side Anti-Cheat:** Captures sub-millisecond pointer telemetry to flag macro auto-clickers and aimbot lock-on, server-side.
- **Mobile Ready:** Responsive layout (game area + leaderboard) with full touch support.

## 🎮 How to Play
1. Open the app — enter your name.
2. Share the room URL (copy button in the header) with friends. They open the same link.
3. The host clicks **LOCK & START** once everyone has joined (this closes the room to new players).
4. Each player clicks **START** to play their own 30s run. Hit the targets; miss costs points.
5. Click **FINISH** to submit early, or let the timer run out.
6. When all players finish or the 60s window ends, the final leaderboard is shown. The host can **PLAY AGAIN**.

### Tuning durations (optional)
The window and per-player run length are configurable via environment variables:
\`\`\`bash
MATCH_WINDOW=90 PLAYER_DURATION=45 npm start
\`\`\`
Defaults: \`MATCH_WINDOW=60\`, \`PLAYER_DURATION=30\` (seconds).

---

## 🛠️ Local Quickstart (Development)

1. **Install Dependencies:**
   \`\`\`bash
   npm install
   \`\`\`

2. **Boot Core App:**
   \`\`\`bash
   npm start
   \`\`\`
   Open your browser at \`http://localhost:3000\`.

   To play on phones, make sure devices are on the same network and open \`http://<YOUR_COMPUTER_IP>:3000\`.

---

## ☁️ Tencent Cloud Production Deployment

### Prerequisites
Purchase a **Lighthouse** instance on Tencent Cloud (Ubuntu 20.04 LTS / 22.04 LTS or CentOS Stream recommended).

### Step 1: Open Port in Firewall
1. Go to your Tencent Cloud Server Management Dashboard.
2. Navigate to the **Firewall** tab.
3. Click **Add Rule**:
   - **Protocol:** \`TCP\`
   - **Port:** \`3000\`
   - **Source:** \`0.0.0.0/0\` (allows global traffic)

### Step 2: Environment Provisioning
Connect via SSH/WebShell to your cloud instance terminal, then run:
\`\`\`bash
# Update apt package caches (Ubuntu)
sudo apt update

# Install Node.js and npm
sudo apt install -y nodejs npm

# Globally install the PM2 process manager to keep the server running in the background
sudo npm install pm2 -g
\`\`\`

### Step 3: Clone the Repository
\`\`\`bash
# Move to the web deployment folder
mkdir -p /www && cd /www

# Clone this repo from your GitHub
git clone <YOUR_GITHUB_REPOSITORY_HTTPS_URL>
cd apexpulse

# Install server dependencies
npm install
\`\`\`

### Step 4: Boot the Production Service
\`\`\`bash
# Run the pre-configured script alias from package.json
npm run prod
\`\`\`
*Done! Open \`http://<YOUR_SERVER_PUBLIC_IP>:3000\` to battle with friends.*

---

## 🔄 One-Click Hot-Updates
After you modify local files and push them to GitHub, updating your production node takes only **two commands**:
\`\`\`bash
cd /www/apexpulse
git pull origin main
pm2 restart apexpulse
\`\`\`
`
};

// Generate folders and physical files
console.log('⚡ Starting ApexPulse Project Generator Box...');
Object.keys(files).forEach(filePath => {
  const fullPath = path.join(__dirname, filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  fs.writeFileSync(fullPath, files[filePath], 'utf8');
  console.log(` ✅ Created file: ${filePath}`);
});
console.log('\n🎉 [SUCCESS] All files for ApexPulse generated perfectly inside this folder!');
console.log('🚀 Execute "npm install && npm start" to launch it locally.');
