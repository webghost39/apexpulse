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
