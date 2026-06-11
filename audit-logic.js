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
