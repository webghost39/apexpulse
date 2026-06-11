// All-time top-N record list (pure; persistence lives in server.js).
const TOP_N = 8;

// Returns a NEW list: entry inserted, sorted by score desc (ties: earlier date first), trimmed to TOP_N.
function addRecord(list, entry) {
    return [...list, entry]
        .sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .slice(0, TOP_N);
}

module.exports = { addRecord, TOP_N };
