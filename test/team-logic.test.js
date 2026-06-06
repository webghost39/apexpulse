const test = require('node:test');
const assert = require('node:assert');
const { computeOutcome, wheelSlices, pickWinner, landAngle } = require('../team-logic');

test('equal counts: higher total wins', () => {
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 2, total: 300 }, B: { count: 2, total: 100 } }),
        { type: 'TEAM_WIN', winner: 'A' });
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 2, total: 100 }, B: { count: 2, total: 300 } }),
        { type: 'TEAM_WIN', winner: 'B' });
});

test('equal counts, equal totals => draw', () => {
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 2, total: 100 }, B: { count: 2, total: 100 } }),
        { type: 'DRAW' });
});

test('unequal counts, one team 0 => auto win for non-zero team, no wheel', () => {
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 3, total: 500 }, B: { count: 1, total: 0 } }),
        { type: 'TEAM_WIN', winner: 'A' });
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 1, total: 0 }, B: { count: 3, total: 500 } }),
        { type: 'TEAM_WIN', winner: 'B' });
});

test('unequal counts, both > 0 => weighted wheel', () => {
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 3, total: 500 }, B: { count: 1, total: 200 } }),
        { type: 'WHEEL_ELIGIBLE', mode: 'weighted' });
});

test('unequal counts, both 0 => fifty wheel', () => {
    assert.deepStrictEqual(
        computeOutcome({ A: { count: 3, total: 0 }, B: { count: 1, total: 0 } }),
        { type: 'WHEEL_ELIGIBLE', mode: 'fifty' });
});

test('wheelSlices proportional to totals', () => {
    const s = wheelSlices(300, 100);
    assert.ok(Math.abs(s.sliceA - 0.75) < 1e-9);
    assert.ok(Math.abs(s.sliceB - 0.25) < 1e-9);
});

test('wheelSlices both 0 => 50/50', () => {
    const s = wheelSlices(0, 0);
    assert.strictEqual(s.sliceA, 0.5);
    assert.strictEqual(s.sliceB, 0.5);
});

test('pickWinner distribution roughly matches slice', () => {
    let a = 0; const N = 20000; let i = 0;
    const rng = () => ((i = (i * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < N; k++) if (pickWinner(0.75, rng) === 'A') a++;
    const frac = a / N;
    assert.ok(frac > 0.72 && frac < 0.78, `got ${frac}`);
});

test('landAngle always inside winner arc', () => {
    let i = 0;
    const rng = () => ((i = (i * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const sliceA = 0.75, aEnd = sliceA * 360;
    for (let k = 0; k < 1000; k++) {
        const angA = landAngle('A', sliceA, rng);
        assert.ok(angA >= 0 && angA < aEnd, `A: ${angA}`);
        const angB = landAngle('B', sliceA, rng);
        assert.ok(angB >= aEnd && angB < 360, `B: ${angB}`);
    }
});
