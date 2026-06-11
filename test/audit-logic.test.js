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

test('ringScore boundaries', () => {
    assert.strictEqual(ringScore(0, 20), 100);      // dead center
    assert.strictEqual(ringScore(10, 20), 60);      // ratio 0.5
    assert.strictEqual(ringScore(20, 20), 20);      // edge hit
    assert.strictEqual(ringScore(21, 20), -20);     // miss
});
