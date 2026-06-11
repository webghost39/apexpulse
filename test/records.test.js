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
