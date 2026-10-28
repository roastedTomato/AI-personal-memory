import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryImageUrl } from '../imageUrl.ts';

test('image URLs are stable, versioned by source, and use explicit image sizes', () => {
  const url = memoryImageUrl('http://local', 1, 'uploads/1-first.png', 'thumbnail');
  assert.equal(url, memoryImageUrl('http://local', 1, 'uploads/1-first.png', 'thumbnail'));
  assert.ok(!url.includes('retry='));
  assert.notEqual(url, memoryImageUrl('http://local', 1, 'uploads/1-replaced.png', 'thumbnail'));
  assert.ok(memoryImageUrl('http://local', 1, 'uploads/1-first.png', 'preview').includes('variant=preview'));
  assert.ok(memoryImageUrl('http://local', 1, 'uploads/1-first.png', 'original', 1).endsWith('&retry=1'));
});
