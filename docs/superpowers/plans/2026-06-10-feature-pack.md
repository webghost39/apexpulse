# Feature Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five features to ApexPulse: sound effects (default off), server-verified score log on results, JT mode (solo big-target training), emoji mode (advance-on-miss room mode), and a persistent top-8 historical leaderboard.

**Architecture:** The client is a single file (`public/index.html`, vanilla JS + canvas); the server is `server.js` (Express + socket.io, in-memory rooms). Score is server-authoritative: the server replays the client's click stream against the seeded target sequence. We extract that replay (`auditPlayerBehavior`) into a pure module `audit-logic.js` so the score-log and emoji-mode changes are unit-testable, following the existing `team-logic.js` + `test/` pattern. The leaderboard adds the first persistence: a tiny `records.json` written synchronously.

**Tech Stack:** Node.js, Express, socket.io, `node --test` (built-in test runner), vanilla JS, Canvas 2D, WebAudio.

**Spec:** `docs/superpowers/specs/2026-06-10-feature-pack-design.md`

**Run tests:** `npm test` · **Run app:** `npm start` then open `http://localhost:3000`

---

### Task 1: Sound Effects (client only)

Loud WebAudio hit/miss sounds, speaker toggle in header, default OFF, persisted in localStorage.

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add speaker icon to header**

In `public/index.html`, replace the header block:

```html
    <header>
        <div class="logo"><i class="fa-solid fa-bolt"></i>APEX PULSE</div>
        <div id="room-link-box">ROOM: <span id="room-url">LOADING...</span><i id="copy-link" class="fa-solid fa-copy" title="Copy invite link"></i></div>
        <i id="sound-toggle" class="fa-solid fa-volume-xmark" title="Sound effects (default off)" style="cursor:pointer; color:#888; font-size:18px;"></i>
    </header>
```

(The only change: the new `<i id="sound-toggle">` line.)

- [ ] **Step 2: Add sound engine JS**

In the `<script>` block, directly after the line `let antiCheatStream = [];`, add:

```js
// ===== Sound effects: WebAudio-synthesized, LOUD, default OFF =====
let soundOn = localStorage.getItem('apexpulse_sound') === 'on';
let audioCtx = null;
function ensureAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}
function renderSoundIcon() {
    $('sound-toggle').className = soundOn ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
    $('sound-toggle').style.color = soundOn ? 'var(--primary)' : '#888';
}
function toggleSound() {
    soundOn = !soundOn;
    localStorage.setItem('apexpulse_sound', soundOn ? 'on' : 'off');
    if (soundOn) ensureAudio(); // user gesture -> safe to create/resume AudioContext
    renderSoundIcon();
}
function playTone(freq, type, dur, gain) {
    if (!soundOn) return;
    const ac = ensureAudio();
    if (!ac) return; // AudioContext unavailable -> stay silent, never crash
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
    osc.connect(g); g.connect(ac.destination);
    osc.start(); osc.stop(ac.currentTime + dur);
}
// hit: sharp ding, pitch rises with ring points (20pts=620Hz ... 100pts=1100Hz). miss: harsh buzzer.
function playHitSound(pts) { playTone(500 + pts * 6, 'square', 0.12, 0.9); }
function playMissSound() { playTone(110, 'sawtooth', 0.3, 0.9); }
```

- [ ] **Step 3: Hook sounds into clicks + wire the toggle**

In `pointerHit`, directly after the line `currentScore = Math.max(0, currentScore + pts);`, add:

```js
    if (isHit) playHitSound(pts); else playMissSound();
```

Near the other listeners at the bottom (after the `$('decide-btn').addEventListener(...)` line), add:

```js
$('sound-toggle').addEventListener('click', toggleSound);
renderSoundIcon();
```

- [ ] **Step 4: Manual verify**

Run: `npm start`, open `http://localhost:3000`, join, LOCK & START, START.
- Default: icon is muted (🔇 gray), clicks are silent.
- Click speaker: turns green volume icon; hits ding (higher pitch nearer center), misses buzz, clearly loud.
- Reload page: preference remembered.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Sound effects: loud WebAudio hit/miss tones, header toggle, default off"
```

---

### Task 2: Extract `audit-logic.js` (pure refactor + regression tests)

Move the replay/anti-cheat logic out of `server.js` into a pure module so Tasks 3 and 5 can be test-driven. No behavior change.

**Files:**
- Create: `audit-logic.js`
- Create: `test/audit-logic.test.js`
- Modify: `server.js`

- [ ] **Step 1: Write failing regression tests**

Create `test/audit-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { auditPlayerBehavior, makeRng, spawnTarget, ringScore } = require('../audit-logic');

// Default thresholds (mirror server defaults)
const AC = { PERFECT_PX: 1.2, AIMBOT_RATIO: 0.8, AIMBOT_MIN_HITS: 8, FAST_MS: 45, FAST_MAX: 8 };

// Build a valid click stream the way the client records it.
// clicks: [{ ratio, dt }] -> click at `ratio * r` px right of target center, `dt` ms after previous.
// Mirrors the client advance rule: a hit (ratio <= 1) spawns the next seeded target.
function makeStream(seed, clicks, emojiMode = false) {
    const rng = makeRng(seed);
    let target = spawnTarget(rng);
    let t = 1000;
    return clicks.map(({ ratio, dt }) => {
        t += dt;
        const a = { t, x: target.x + ratio * target.r, y: target.y, target_x: Math.round(target.x), target_y: Math.round(target.y) };
        if (ratio <= 1 || emojiMode) target = spawnTarget(rng);
        return a;
    });
}

test('empty stream passes with score 0', () => {
    const r = auditPlayerBehavior([], 42, AC);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.score, 0);
});

test('clean run replays to the correct ring score', () => {
    // ratio 0.5 -> 60 pts, ratio 0.5 -> 60 pts, ratio 1.5 -> miss -20  => 100
    const stream = makeStream(7, [{ ratio: 0.5, dt: 300 }, { ratio: 0.5, dt: 300 }, { ratio: 1.5, dt: 300 }]);
    const r = auditPlayerBehavior(stream, 7, AC);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.score, 100);
});

test('score floors at 0 (misses cannot go negative)', () => {
    const stream = makeStream(7, [{ ratio: 1.5, dt: 300 }, { ratio: 1.5, dt: 300 }]);
    const r = auditPlayerBehavior(stream, 7, AC);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.score, 0);
});

test('fabricated stream (wrong target coords) is rejected', () => {
    const stream = makeStream(7, [{ ratio: 0.5, dt: 300 }, { ratio: 0.5, dt: 300 }]);
    stream[1].target_x += 5;
    const r = auditPlayerBehavior(stream, 7, AC);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.reason, 'STREAM_TARGET_MISMATCH');
});

test('macro cadence (many <45ms gaps) is banned', () => {
    const clicks = Array.from({ length: 12 }, () => ({ ratio: 1.5, dt: 20 }));
    const r = auditPlayerBehavior(makeStream(7, clicks), 7, AC);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.reason, 'MACRO_AUTOCLICKER_DETECTED');
});

test('aimbot (pixel-perfect hit after hit) is banned', () => {
    const clicks = Array.from({ length: 10 }, () => ({ ratio: 0, dt: 300 }));
    const r = auditPlayerBehavior(makeStream(7, clicks), 7, AC);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.reason, 'AIBOT_LOCKON_DETECTED');
});

test('ringScore boundaries', () => {
    assert.strictEqual(ringScore(0, 20), 100);      // dead center
    assert.strictEqual(ringScore(10, 20), 60);      // ratio 0.5
    assert.strictEqual(ringScore(20, 20), 20);      // edge hit
    assert.strictEqual(ringScore(21, 20), -20);     // miss
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `test/audit-logic.test.js` fails with `Cannot find module '../audit-logic'`. (`team-logic.test.js` still passes.)

- [ ] **Step 3: Create the module**

Create `audit-logic.js` (logic moved verbatim from `server.js`, with thresholds injected as `ac` and the unused `claimedScore` param dropped):

```js
// Authoritative replay verification + anti-cheat heuristics (pure, no I/O).
// Canvas dims and scoring MUST match the client (public/index.html).
const CANVAS_W = 800, CANVAS_H = 500;
const RINGS = [
    { t: 0.2, pts: 100 },
    { t: 0.4, pts: 80 },
    { t: 0.6, pts: 60 },
    { t: 0.8, pts: 40 },
    { t: 1.0, pts: 20 },
];
const MISS_PTS = -20;
function ringScore(dist, r) {
    const ratio = dist / r;
    for (const ring of RINGS) if (ratio <= ring.t) return ring.pts;
    return MISS_PTS;
}
// Deterministic RNG — replicates client seededRandom() (Math.sin-based, post-increment seed).
function makeRng(seed) { let s = seed; return () => { let x = Math.sin(s++) * 10000; return x - Math.floor(x); }; }
function spawnTarget(rng) {
    const r = Math.floor(rng() * 10) + 16;
    const x = rng() * (CANVAS_W - r * 2) + r;
    const y = rng() * (CANVAS_H - r * 2) + r;
    return { x, y, r };
}

function auditPlayerBehavior(stream, seed, ac) {
    if (!stream || stream.length === 0) return { passed: true, score: 0 }; // never clicked -> 0, not a cheater
    const rng = makeRng(seed);
    let target = spawnTarget(rng); // matches client: one spawn before first click
    let score = 0, hits = 0, pixelPerfect = 0, extremeFastCount = 0;
    for (let i = 0; i < stream.length; i++) {
        const a = stream[i];
        // Replay must land on the same target the client recorded, else the stream is fabricated.
        if (Math.round(target.x) !== a.target_x || Math.round(target.y) !== a.target_y) {
            return { passed: false, reason: "STREAM_TARGET_MISMATCH", at: i, sawTarget: [a.target_x, a.target_y], expectTarget: [Math.round(target.x), Math.round(target.y)] };
        }
        const dist = Math.hypot(a.x - target.x, a.y - target.y);
        score = Math.max(0, score + ringScore(dist, target.r));
        const isHit = dist <= target.r;
        // pixel-perfect = sub-pixel dead-center hit. Humans aiming for center still scatter a few px;
        // only an aimbot snaps to ~0 offset on hit after hit. (Ring scoring rewards center, so a
        // simple "near center" ratio would false-flag good players — require true pixel precision.)
        if (isHit) { hits++; if (dist <= ac.PERFECT_PX) pixelPerfect++; target = spawnTarget(rng); }
        // inhuman cadence: clicks closer than ac.FAST_MS apart
        if (i > 0 && (a.t - stream[i - 1].t) < ac.FAST_MS) extremeFastCount++;
    }
    const stats = { hits, pixelPerfect, extremeFastCount, clicks: stream.length };
    if (extremeFastCount > ac.FAST_MAX) return { passed: false, reason: "MACRO_AUTOCLICKER_DETECTED", stats };
    // aimbot: needs a meaningful sample AND overwhelmingly pixel-perfect hits
    if (hits >= ac.AIMBOT_MIN_HITS && (pixelPerfect / hits) > ac.AIMBOT_RATIO) return { passed: false, reason: "AIBOT_LOCKON_DETECTED", stats };
    return { passed: true, score, stats };
}

module.exports = { CANVAS_W, CANVAS_H, RINGS, MISS_PTS, ringScore, makeRng, spawnTarget, auditPlayerBehavior };
```

- [ ] **Step 4: Use the module in server.js**

In `server.js`:

1. Add to the requires at the top:
```js
const { auditPlayerBehavior } = require('./audit-logic');
```
2. Delete the whole block from the comment `// Authoritative replay verification + heuristics.` (line ~287) through the end of the `auditPlayerBehavior` function (line ~338) — i.e. `CANVAS_W/H`, `RINGS`, `MISS_PTS`, `ringScore`, `makeRng`, `spawnTarget`, `auditPlayerBehavior`. The `const PORT = ...` block stays.
3. In the `submit_score` handler, change the call:
```js
        const auditResult = auditPlayerBehavior(verifyStream, room.seed, AC);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (audit-logic + team-logic).

- [ ] **Step 6: Smoke-test the server**

Run: `npm start` — banner prints, play one quick round in the browser, score appears, no `[ALERT]` false ban.

- [ ] **Step 7: Commit**

```bash
git add audit-logic.js test/audit-logic.test.js server.js
git commit -m "Extract replay/anti-cheat into pure audit-logic module with tests"
```

---

### Task 3: Score Log on Results Screen

Server builds a per-click log + accuracy summary during replay; each player receives their own log in a per-socket `match_over`; results overlay renders it. Displayed numbers come from the server's replay — forge-proof.

**Files:**
- Modify: `audit-logic.js`
- Modify: `test/audit-logic.test.js`
- Modify: `server.js`
- Modify: `public/index.html`

- [ ] **Step 1: Write failing tests for clickLog + summary**

Append to `test/audit-logic.test.js`:

```js
test('passed audit includes per-click log and summary', () => {
    // hit 60pts, hit 60pts, miss -20 => running 60, 120, 100
    const stream = makeStream(7, [{ ratio: 0.5, dt: 300 }, { ratio: 0.5, dt: 400 }, { ratio: 1.5, dt: 300 }]);
    const r = auditPlayerBehavior(stream, 7, AC);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.clickLog.length, 3);
    assert.deepStrictEqual(r.clickLog.map(c => c.running), [60, 120, 100]);
    assert.deepStrictEqual(r.clickLog.map(c => c.pts), [60, 60, -20]);
    assert.deepStrictEqual(r.clickLog.map(c => c.hit), [true, true, false]);
    assert.deepStrictEqual(r.clickLog.map(c => c.t), [0, 400, 700]); // ms since first click
    assert.strictEqual(r.summary.clicks, 3);
    assert.strictEqual(r.summary.hits, 2);
    assert.strictEqual(r.summary.accuracy, 67); // round(2/3*100)
    assert.ok(r.summary.avgOffset > 0);
});

test('empty stream yields empty log and zeroed summary', () => {
    const r = auditPlayerBehavior([], 42, AC);
    assert.deepStrictEqual(r.clickLog, []);
    assert.deepStrictEqual(r.summary, { clicks: 0, hits: 0, accuracy: 0, avgOffset: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL (`clickLog` undefined); all others pass.

- [ ] **Step 3: Implement in audit-logic.js**

In `auditPlayerBehavior`:

1. Change the empty-stream return:
```js
    if (!stream || stream.length === 0) return { passed: true, score: 0, clickLog: [], summary: { clicks: 0, hits: 0, accuracy: 0, avgOffset: 0 } };
```
2. Before the `for` loop add:
```js
    const clickLog = [];
    let offsetSum = 0;
    const t0 = stream[0].t;
```
3. Inside the loop, replace
```js
        const dist = Math.hypot(a.x - target.x, a.y - target.y);
        score = Math.max(0, score + ringScore(dist, target.r));
        const isHit = dist <= target.r;
```
with
```js
        const dist = Math.hypot(a.x - target.x, a.y - target.y);
        const pts = ringScore(dist, target.r);
        score = Math.max(0, score + pts);
        const isHit = dist <= target.r;
        offsetSum += dist;
        clickLog.push({ t: Math.round(a.t - t0), offset: +dist.toFixed(1), pts, hit: isHit, running: score });
```
4. Change the final return:
```js
    const summary = { clicks: stream.length, hits, accuracy: Math.round(hits / stream.length * 100), avgOffset: +(offsetSum / stream.length).toFixed(1) };
    return { passed: true, score, stats, clickLog, summary };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Server wiring (store log, per-socket match_over)**

In `server.js`:

1. Room creation (in `join_room`): add `logs: {}` to the new-room object literal:
```js
            rooms[roomId] = { players: {}, host: socket.id, locked: false, status: 'lobby', seed: 0, startAt: 0, timer: null, createdAt: Date.now(), teamMode: false, wheelSpun: false, outcome: null, teamNames: { A: 'A', B: 'B' }, logs: {} };
```
2. In `lock_start`, inside the `Object.values(room.players).forEach(p => { ... })` reset block, add `p.summary = null;`, and after that forEach add:
```js
        room.logs = {};
```
3. In `submit_score`, in the `auditResult.passed` branch, after `player.score = auditResult.score;` add:
```js
            player.summary = auditResult.summary;
            room.logs[socket.id] = auditResult.clickLog;
```
4. In `endMatch`, replace the two `io.to(roomId).emit('match_over', ...)` calls with a per-socket emit (each player gets everyone's summaries via `players`, plus their own full click log):
```js
    let base;
    if (room.teamMode) {
        const teams = teamSummary(room);
        room.teams = teams;
        room.outcome = computeOutcome(teams);
        base = { players: leaderboardOf(room), teamMode: true, teams, outcome: room.outcome };
    } else {
        base = { players: leaderboardOf(room), teamMode: false };
    }
    Object.values(room.players).forEach(p => {
        io.to(p.id).emit('match_over', { ...base, myLog: room.logs[p.id] || null });
    });
```
5. In `reset_room`, add `p.summary = null;` inside the players forEach and `room.logs = {};` next to the other room resets.

- [ ] **Step 6: Client results UI**

In `public/index.html`:

1. In the overlay HTML, after the `<div id="result-banner" ...></div>` line, add:
```html
                    <div id="score-log" style="display:none; width:100%; max-width:560px; text-align:left;"></div>
```
2. Add the renderer (place after `showResults`):
```js
// Server-verified accuracy summary + per-click log. `me.summary` and `log` come from the
// server's replay (audit), not from client-side counters — forging means beating the replay.
function renderScoreLog(me, log) {
    const box = $('score-log');
    if (!me || !me.summary || me.isCheater) { box.style.display = 'none'; return; }
    const s = me.summary;
    let html = `<div style="font-weight:700; color:var(--accent); margin-bottom:6px; text-align:center;">HITS ${s.hits}/${s.clicks} · ACCURACY ${s.accuracy}% · AVG OFFSET ${s.avgOffset}px <span style="color:#666; font-size:11px;">(server-verified)</span></div>`;
    if (log && log.length) {
        html += `<div style="max-height:160px; overflow-y:auto; background:#090a0d; border:1px solid #1a1d26; border-radius:4px; padding:8px; font-family:monospace; font-size:11px; white-space:pre;">`
            + `<div style="color:#666;">  #   TIME   OFFSET   PTS  SCORE</div>`
            + log.map((c, i) =>
                `<div style="color:${c.hit ? '#00ff88' : '#ff3860'};">${String(i + 1).padStart(3)} ${(c.t / 1000).toFixed(1).padStart(5)}s ${String(c.offset).padStart(6)}px ${String(c.pts).padStart(5)} ${String(c.running).padStart(6)}</div>`).join('')
            + `</div>`;
    }
    box.innerHTML = html;
    box.style.display = 'block';
}
```
3. In `showResults`, after `renderLeaderboard(players);` and **before** the `if (isTeam)` branch, add:
```js
    renderScoreLog(players.find(p => p.id === myId), Array.isArray(data) ? null : data.myLog);
```
4. In `resetToLobby`, next to the other hides, add:
```js
    $('score-log').style.display = 'none';
```

- [ ] **Step 7: Manual verify**

Run: `npm start`, two browser tabs, play a round in each (mix hits and misses).
- Results overlay shows each tab its own summary line + scrollable click table; numbers match what was played.
- Team mode round: settlement screen also shows the log.
- PLAY AGAIN: log hidden back in lobby.

- [ ] **Step 8: Commit**

```bash
git add audit-logic.js test/audit-logic.test.js server.js public/index.html
git commit -m "Results: server-verified per-click score log + accuracy summary"
```

---

### Task 4: JT Mode (solo big-target training, client only)

Solo 30s practice run with a 1×–3× target-size slider. No socket emits, no anti-cheat, never enters any leaderboard. Named for Justin Thomas.

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add JT controls to the lobby overlay**

In the overlay HTML, after the closing `</div>` of `#team-controls`, add:

```html
                    <div id="jt-controls" style="display:none;">
                        <div style="color:#cfd3dc; font-size:13px; margin-bottom:6px;">JT MODE — solo training, not recorded · TARGET SIZE <span id="jt-size-label">1.6×</span></div>
                        <input type="range" id="jt-size" min="1" max="3" step="0.1" value="1.6" style="width:220px;">
                        <div style="margin-top:10px;">
                            <button class="btn-action" id="jt-btn" style="background:linear-gradient(135deg,#b06bff 0%,#7a2bd6 100%); color:#fff; padding:10px 22px;">START JT MODE</button>
                        </div>
                    </div>
```

And after the `<button class="btn-action" id="action-btn" ...>` line, add:

```html
                    <button class="btn-action" id="jt-back-btn" style="display:none; background:#2a2f3a; color:#ccc; box-shadow:none;">BACK TO LOBBY</button>
```

- [ ] **Step 2: JT state + game-loop integration**

1. Next to the other state vars (after `let antiCheatStream = [];`), add:
```js
let jtMode = false, jtFactor = 1.6;
let runClicks = 0, runHits = 0;
```
2. In `spawnSeededTarget`, change the radius line (JT scales render **and** hitbox; `jtMode` is always false in competitive runs so replay is untouched):
```js
    target.r = (Math.floor(seededRandom() * 10) + 16) * (jtMode ? jtFactor : 1);
```
3. In `startRun`, change `currentScore = 0; antiCheatStream = [];` to:
```js
    currentScore = 0; antiCheatStream = []; runClicks = 0; runHits = 0;
```
4. In `startRun`'s `setInterval`, guard the sync emit:
```js
        if (!jtMode && socket && socket.connected) socket.emit('sync_score', { roomId, currentScore });
```
5. In `pointerHit`, after `const isHit = dist <= target.r;`, add:
```js
    runClicks++; if (isHit) runHits++;
```

- [ ] **Step 3: JT run lifecycle**

1. Replace `finishMyRun` with:
```js
function finishMyRun() {
    if (myStatus === 'finished' || myStatus === 'jt-done') return;
    isPlaying = false;
    if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('finish-btn').style.display = 'none';
    if (jtMode) { myStatus = 'jt-done'; showJtResults(); return; }
    myStatus = 'finished';
    if (socket && socket.connected) socket.emit('submit_score', { roomId, verifyStream: antiCheatStream, finalScore: currentScore });
    $('overlay-title').innerText = "YOU'RE DONE";
    $('overlay-desc').innerText = `Your score: ${currentScore}. Waiting for other players or the timer to end...`;
    $('action-btn').style.display = 'none';
    $('overlay').style.display = 'flex';
    logAudit(`[SUBMIT] Score submitted: ${currentScore}`);
}
```
2. Add the JT functions (after `finishMyRun`):
```js
function startJtRun() {
    jtFactor = parseFloat($('jt-size').value);
    gameSeed = Math.floor(Math.random() * 1000000); // local seed, never submitted
    jtMode = true;
    $('jt-controls').style.display = 'none';
    $('jt-back-btn').style.display = 'none';
    $('score-log').style.display = 'none';
    startRun(playerDuration);
}

function showJtResults() {
    const acc = runClicks ? Math.round(runHits / runClicks * 100) : 0;
    $('overlay-title').innerText = 'JT MODE COMPLETE';
    $('overlay-desc').innerText = `Score: ${currentScore} · Hits: ${runHits}/${runClicks} · Accuracy: ${acc}% — training only, not recorded.`;
    const btn = $('action-btn');
    btn.style.display = 'inline-block';
    btn.disabled = false;
    btn.innerText = 'AGAIN';
    btn.onclick = startJtRun;
    $('jt-back-btn').style.display = 'inline-block';
    $('overlay').style.display = 'flex';
}
```
3. In `updateLobbyOverlay`, after `renderTeamControls();`, add:
```js
    $('jt-controls').style.display = 'block';
    $('jt-back-btn').style.display = 'none';
```
4. In `openWindowReady`, at the very top (a competitive match preempts any JT run), add:
```js
    if (jtMode) {
        jtMode = false;
        isPlaying = false;
        if (gameInterval) { clearInterval(gameInterval); gameInterval = null; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        $('finish-btn').style.display = 'none';
    }
    $('jt-controls').style.display = 'none';
    $('jt-back-btn').style.display = 'none';
    $('score-log').style.display = 'none';
```
5. In `resetToLobby`, add `jtMode = false;` next to `isPlaying = false; myStatus = 'waiting';`.
6. Wire listeners (with the others at the bottom):
```js
$('jt-btn').addEventListener('click', startJtRun);
$('jt-back-btn').addEventListener('click', () => { jtMode = false; myStatus = 'waiting'; updateLobbyOverlay(); });
$('jt-size').addEventListener('input', () => { $('jt-size-label').innerText = parseFloat($('jt-size').value).toFixed(1) + '×'; });
```

- [ ] **Step 4: Manual verify**

Run: `npm start`.
- Lobby shows JT controls (host and non-host). Slider label updates.
- Slider at 3×: targets visibly huge; hits register on the big circle.
- Run ends → JT MODE COMPLETE with score/hits/accuracy; AGAIN restarts; BACK TO LOBBY returns; match leaderboard never moved (other tab sees no score).
- Two tabs: start JT in tab B, host locks in tab A → tab B's JT run aborts to the READY overlay; competitive run then has normal-size targets and no false ban on submit.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "JT mode: solo training with 1x-3x target size slider, never recorded"
```

---

### Task 5: Emoji Mode (room mode, advance-on-miss)

Host toggle. Every click advances the target; after a miss the next target renders 🤣. Server replay mirrors the advance rule. Scores excluded from the historical leaderboard (enforced in Task 6).

**Files:**
- Modify: `audit-logic.js`
- Modify: `test/audit-logic.test.js`
- Modify: `server.js`
- Modify: `public/index.html`

- [ ] **Step 1: Write failing replay tests**

Append to `test/audit-logic.test.js` (note: `makeStream` already takes `emojiMode`):

```js
test('emoji mode: a miss advances the target, replay verifies and scores', () => {
    // miss -20 (floor 0), hit on the NEXT target 60, hit 100 => 0, 60, 160
    const stream = makeStream(7, [{ ratio: 1.5, dt: 300 }, { ratio: 0.5, dt: 300 }, { ratio: 0.1, dt: 300 }], true);
    const r = auditPlayerBehavior(stream, 7, AC, true);
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.score, 160);
    assert.deepStrictEqual(r.clickLog.map(c => c.running), [0, 60, 160]);
});

test('emoji-mode stream fails normal replay (advance rules differ)', () => {
    const stream = makeStream(7, [{ ratio: 1.5, dt: 300 }, { ratio: 0.5, dt: 300 }], true);
    const r = auditPlayerBehavior(stream, 7, AC, false);
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.reason, 'STREAM_TARGET_MISMATCH');
});

test('normal stream still verifies when emoji mode off (regression)', () => {
    const stream = makeStream(7, [{ ratio: 0.5, dt: 300 }, { ratio: 1.5, dt: 300 }, { ratio: 0.5, dt: 300 }]);
    const r = auditPlayerBehavior(stream, 7, AC, false);
    assert.strictEqual(r.passed, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: first emoji test FAILS (score mismatch / target mismatch — the 4-arg call ignores the flag today). Others pass.

- [ ] **Step 3: Implement emojiMode in audit-logic.js**

1. Signature:
```js
function auditPlayerBehavior(stream, seed, ac, emojiMode = false) {
```
2. Replace the hit/advance line:
```js
        if (isHit) { hits++; if (dist <= ac.PERFECT_PX) pixelPerfect++; target = spawnTarget(rng); }
```
with (emoji mode: every click advances — misses don't retry):
```js
        if (isHit) { hits++; if (dist <= ac.PERFECT_PX) pixelPerfect++; }
        if (isHit || emojiMode) target = spawnTarget(rng);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Server — room flag, toggle handler, replay arg**

In `server.js`:

1. Room creation: add `emojiMode: false` to the new-room object literal (next to `teamMode: false`).
2. All three existing `room_config` emits (`join_room`, `set_team_mode`, `set_team_names`) get `emojiMode` added:
```js
        io.to(roomId).emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
```
   (In `join_room` it's `socket.emit(...)`, same payload.)
3. New handler (after `set_team_names`):
```js
    // Host toggles emoji mode (lobby only): every click advances; miss shows 🤣 next.
    socket.on('set_emoji_mode', ({ roomId, enabled }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id || room.status !== 'lobby') return;
        room.emojiMode = !!enabled;
        io.to(roomId).emit('room_config', { teamMode: room.teamMode, teamNames: room.teamNames, emojiMode: room.emojiMode });
    });
```
4. `match_open` payload: add `emojiMode: room.emojiMode`.
5. `submit_score`: the room's flag (never client-supplied) drives the replay:
```js
        const auditResult = auditPlayerBehavior(verifyStream, room.seed, AC, room.emojiMode);
```

- [ ] **Step 6: Client — toggle UI, advance rule, 🤣 skin**

In `public/index.html`:

1. State: change `let teamMode = false, ...` line's neighborhood — add after it:
```js
let emojiMode = false, targetIsEmoji = false;
```
2. `room_config` handler: add `emojiMode = !!c.emojiMode;`:
```js
    socket.on('room_config', (c) => { teamMode = c.teamMode; if (c.teamNames) teamNames = c.teamNames; emojiMode = !!c.emojiMode; if (myStatus === 'waiting') updateLobbyOverlay(); });
```
3. `match_open` handler: add `emojiMode = !!cfg.emojiMode;` before `openWindowReady();`.
4. Toggle HTML — inside `#team-controls`, directly **before** `#team-mode-row`, add:
```html
                        <label id="emoji-mode-row" style="display:none; align-items:center; gap:8px; justify-content:center; margin-bottom:12px; cursor:pointer; color:#cfd3dc; font-size:13px;">
                            <input type="checkbox" id="emoji-mode-toggle"> 🤣 EMOJI MODE (miss = no retry)
                        </label>
```
5. In `renderTeamControls`, after the `modeRow.style.display = ...` line, add:
```js
    $('emoji-mode-row').style.display = amHost() ? 'flex' : 'none';
    $('emoji-mode-toggle').checked = emojiMode;
```
   Note `#team-controls` is shown for all players in the lobby; only the host sees the toggles inside it.
6. Non-hosts learn the mode at start — in `openWindowReady`, change the title line:
```js
    title.innerText = emojiMode ? "READY — EMOJI MODE 🤣" : "READY — ROOM IS OPEN";
```
7. Advance rule in `pointerHit` — replace:
```js
    if (isHit) { spawnSeededTarget(); drawCanvas(); }
```
with:
```js
    if (isHit || emojiMode) { targetIsEmoji = !isHit; spawnSeededTarget(); drawCanvas(); }
```
8. 🤣 skin in `drawCanvas` — after `if (!isPlaying) return;`, add:
```js
    if (targetIsEmoji) {
        // mockery skin after a miss: same position & hitbox, emoji instead of rings
        ctx.font = `${Math.round(target.r * 2)}px serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🤣', target.x, target.y);
        ctx.beginPath(); ctx.arc(target.x, target.y, 3, 0, Math.PI * 2); ctx.fillStyle = '#00e5ff'; ctx.fill();
        return;
    }
```
9. In `startRun`, add `targetIsEmoji = false;` next to the other run resets.
10. Listener (with the others):
```js
$('emoji-mode-toggle').addEventListener('change', (e) => { if (socket && socket.connected) socket.emit('set_emoji_mode', { roomId, enabled: e.target.checked }); });
```

- [ ] **Step 7: Manual verify**

Run: `npm start`, two tabs.
- Host sees 🤣 EMOJI MODE toggle; non-host doesn't. Toggle on, lock & start.
- Non-host READY overlay says EMOJI MODE 🤣.
- In a run: miss → target jumps immediately and next target is a 🤣 sized like a target; clicking the 🤣 (hit) returns to normal rings; miss again → 🤣 again.
- Both players finish: **no false bans** (server replays with the emoji rule), scores sane, score log shows the misses.
- Toggle off, play normal round: miss leaves target in place (regression).

- [ ] **Step 8: Commit**

```bash
git add audit-logic.js test/audit-logic.test.js server.js public/index.html
git commit -m "Emoji mode: host-toggled advance-on-miss with laughing-emoji targets"
```

---

### Task 6: Persistent Top-8 Historical Leaderboard

All-time top 8 verified competitive runs, persisted to `records.json`, served at `/api/leaderboard`, displayed on `/leaderboard`.

**Files:**
- Create: `records.js`
- Create: `test/records.test.js`
- Create: `public/leaderboard.html`
- Modify: `server.js`
- Modify: `public/index.html`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests for the records logic**

Create `test/records.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { addRecord, TOP_N } = require('../records');

const e = (name, score, date) => ({ name, score, accuracy: 50, date });

test('TOP_N is 8', () => {
    assert.strictEqual(TOP_N, 8);
});

test('insert into empty list', () => {
    assert.deepStrictEqual(addRecord([], e('a', 100, '2026-01-01')), [e('a', 100, '2026-01-01')]);
});

test('keeps list sorted by score desc', () => {
    let list = [];
    list = addRecord(list, e('a', 100, '2026-01-01'));
    list = addRecord(list, e('b', 300, '2026-01-02'));
    list = addRecord(list, e('c', 200, '2026-01-03'));
    assert.deepStrictEqual(list.map(r => r.score), [300, 200, 100]);
});

test('trims to top 8, dropping the lowest', () => {
    let list = [];
    for (let i = 1; i <= 9; i++) list = addRecord(list, e('p' + i, i * 10, '2026-01-0' + (i % 9 + 1)));
    assert.strictEqual(list.length, 8);
    assert.strictEqual(list[list.length - 1].score, 20); // 10 dropped
});

test('new entry below a full list leaves it unchanged', () => {
    let list = [];
    for (let i = 1; i <= 8; i++) list = addRecord(list, e('p' + i, 100 + i, '2026-01-01'));
    const before = [...list];
    assert.deepStrictEqual(addRecord(list, e('low', 5, '2026-02-01')), before);
});

test('tie: earlier record keeps the higher rank', () => {
    let list = addRecord([], e('first', 100, '2026-01-01'));
    list = addRecord(list, e('second', 100, '2026-01-02'));
    assert.deepStrictEqual(list.map(r => r.name), ['first', 'second']);
});

test('does not mutate the input list', () => {
    const list = [e('a', 100, '2026-01-01')];
    addRecord(list, e('b', 200, '2026-01-02'));
    assert.strictEqual(list.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: `Cannot find module '../records'`.

- [ ] **Step 3: Implement records.js**

Create `records.js`:

```js
// All-time top-N record list (pure; persistence lives in server.js).
const TOP_N = 8;

// Returns a NEW list: entry inserted, sorted by score desc (ties: earlier date first), trimmed to TOP_N.
function addRecord(list, entry) {
    return [...list, entry]
        .sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .slice(0, TOP_N);
}

module.exports = { addRecord, TOP_N };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — all pass.

- [ ] **Step 5: Server — load/save records, record on verified submit, API + page route**

In `server.js`:

1. Requires at the top:
```js
const fs = require('fs');
const { addRecord } = require('./records');
```
2. After the `AC` block, add:
```js
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
```
3. In `submit_score`, in the `auditResult.passed` branch, after `room.logs[socket.id] = auditResult.clickLog;` add:
```js
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
```

- [ ] **Step 6: Leaderboard page**

Create `public/leaderboard.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ApexPulse — Hall of Fame</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root { --bg-color: #0a0b0d; --panel-bg: #13151a; --primary: #00ff88; --accent: #00e5ff; --text: #e3e6ed; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg-color); color: var(--text); font-family: 'Segoe UI', Roboto, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 16px; }
        h1 { color: gold; font-style: italic; letter-spacing: 2px; margin-bottom: 6px; }
        .sub { color: #777; font-size: 13px; margin-bottom: 26px; }
        .board { background: var(--panel-bg); border: 1px solid #222631; border-radius: 8px; padding: 20px; width: 100%; max-width: 560px; }
        .row { display: flex; align-items: center; gap: 12px; padding: 12px; background: #1a1d26; border-radius: 4px; margin-bottom: 8px; border-left: 3px solid #3a4155; }
        .row:nth-child(1) { border-left-color: gold; }
        .row:nth-child(2) { border-left-color: silver; }
        .row:nth-child(3) { border-left-color: #cd7f32; }
        .rank { width: 28px; font-weight: 800; color: #888; }
        .name { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .acc { color: #888; font-size: 12px; width: 70px; text-align: right; }
        .date { color: #555; font-size: 12px; width: 90px; text-align: right; }
        .score { font-family: monospace; font-weight: 700; color: var(--primary); width: 70px; text-align: right; }
        .empty { color: #555; text-align: center; padding: 30px 0; }
        a.back { color: var(--accent); text-decoration: none; margin-top: 22px; font-size: 14px; }
    </style>
</head>
<body>
    <h1><i class="fa-solid fa-trophy"></i> HALL OF FAME</h1>
    <div class="sub">All-time top 8 · server-verified competitive runs only</div>
    <div class="board" id="board"><div class="empty">Loading...</div></div>
    <a class="back" href="/"><i class="fa-solid fa-arrow-left"></i> BACK TO GAME</a>
    <script>
        fetch('/api/leaderboard').then(r => r.json()).then(records => {
            const board = document.getElementById('board');
            board.innerHTML = '';
            if (!records.length) {
                board.innerHTML = '<div class="empty">No records yet. Go set one!</div>';
                return;
            }
            records.forEach((rec, i) => {
                const row = document.createElement('div');
                row.className = 'row';
                const mk = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
                row.appendChild(mk('rank', '#' + (i + 1)));
                row.appendChild(mk('name', rec.name)); // textContent: names are user input
                row.appendChild(mk('acc', rec.accuracy + '% acc'));
                row.appendChild(mk('date', new Date(rec.date).toLocaleDateString()));
                row.appendChild(mk('score', rec.score));
                board.appendChild(row);
            });
        }).catch(() => {
            document.getElementById('board').innerHTML = '<div class="empty">Failed to load records.</div>';
        });
    </script>
</body>
</html>
```

- [ ] **Step 7: Header link in the game + gitignore**

1. In `public/index.html`, in the header next to the sound toggle, add:
```html
        <a href="/leaderboard" title="Hall of Fame" style="color:gold; font-size:18px;"><i class="fa-solid fa-trophy"></i></a>
```
2. Append to `.gitignore`:
```
records.json
```

- [ ] **Step 8: Run tests + manual verify**

Run: `npm test` — all pass.
Run: `npm start`.
- Play a competitive round with score > 0 → `records.json` appears with the entry (name, score, accuracy, date).
- `/leaderboard` shows the run; trophy icon in the game header opens it; BACK TO GAME returns.
- Restart the server → records still there.
- Emoji-mode round → no new record. JT run → no new record. 9 distinct scores → only top 8 kept.

- [ ] **Step 9: Commit**

```bash
git add records.js test/records.test.js server.js public/leaderboard.html public/index.html .gitignore
git commit -m "Hall of fame: persistent top-8 verified records with /leaderboard page"
```
