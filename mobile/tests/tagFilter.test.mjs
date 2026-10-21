import assert from 'node:assert/strict';
import test from 'node:test';
import { availableTags, filterByTags } from '../tagFilter.ts';

const memories = [
  { id: 1, tags: ['work', 'urgent'] },
  { id: 2, tags: ['personal'] },
  { id: 3, tags: ['work'] },
  { id: 4, tags: [] },
];

test('tag choices come from all memories and ignore empty values', () => {
  assert.deepEqual(availableTags(memories), ['personal', 'urgent', 'work']);
  assert.deepEqual(availableTags([{ tags: [] }]), []);
});

test('single and multiple tags narrow the current keyword result set', () => {
  assert.deepEqual(filterByTags(memories, ['work']).map((item) => item.id), [1, 3]);
  assert.deepEqual(filterByTags(memories, ['work', 'personal']).map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(filterByTags(memories.slice(1), ['urgent']).map((item) => item.id), []);
  assert.deepEqual(filterByTags(memories, []), memories);
});

test('legacy duplicate and low-value tags are hidden and still filter correctly', () => {
  const old = [{ id: 5, tags: ['Handmade', 'handmade', 'Wonders', 'Wonder opportunity', 'December', 'Weekly'] }];
  assert.deepEqual(availableTags(old), ['handmade', 'wonder']);
  assert.deepEqual(filterByTags(old, ['wonder']).map((item) => item.id), [5]);
});


test('market tag variants share one choice', () => {
  const old = [{ id: 6, tags: ['Markets', 'Market Days'] }];
  assert.deepEqual(availableTags(old), ['market']);
  assert.deepEqual(filterByTags(old, ['market']).map((item) => item.id), [6]);
});
