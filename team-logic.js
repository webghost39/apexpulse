// Pure, dependency-free team-mode logic. Shared by server.js and tests.

// teams: { A: { count, total }, B: { count, total } }
function computeOutcome(teams) {
    const A = teams.A, B = teams.B;
    if (A.count === B.count) {
        if (A.total > B.total) return { type: 'TEAM_WIN', winner: 'A' };
        if (B.total > A.total) return { type: 'TEAM_WIN', winner: 'B' };
        return { type: 'DRAW' };
    }
    // unequal counts
    if (A.total > 0 && B.total === 0) return { type: 'TEAM_WIN', winner: 'A' };
    if (B.total > 0 && A.total === 0) return { type: 'TEAM_WIN', winner: 'B' };
    if (A.total === 0 && B.total === 0) return { type: 'WHEEL_ELIGIBLE', mode: 'fifty' };
    return { type: 'WHEEL_ELIGIBLE', mode: 'weighted' };
}

// fractions summing to 1; both-zero => 50/50
function wheelSlices(totalA, totalB) {
    let wA = totalA, wB = totalB;
    if (wA === 0 && wB === 0) { wA = 1; wB = 1; }
    const sum = wA + wB;
    return { sliceA: wA / sum, sliceB: wB / sum };
}

// rng: () => [0,1). returns 'A' | 'B'
function pickWinner(sliceA, rng) {
    return rng() < sliceA ? 'A' : 'B';
}

// Wheel arcs (degrees, 0 at top, clockwise): A = [0, sliceA*360), B = [sliceA*360, 360).
// Returns an angle strictly inside the winner arc (with a small margin off the edges).
function landAngle(winner, sliceA, rng) {
    const aEnd = sliceA * 360;
    const lo = winner === 'A' ? 0 : aEnd;
    const hi = winner === 'A' ? aEnd : 360;
    const span = hi - lo;
    const margin = Math.min(span * 0.1, 5);
    return lo + margin + rng() * (span - 2 * margin);
}

module.exports = { computeOutcome, wheelSlices, pickWinner, landAngle };
