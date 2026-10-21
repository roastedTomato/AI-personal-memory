import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mapVisionEnvelope, visibleVisionFields, suggestReminderIfUntouched, categoryFields } from '../visionDraft.ts';

const response = JSON.parse(readFileSync(new URL('./vision-response.json', import.meta.url), 'utf8'));

test('backend vision.draft fields map into editable form', () => {
  const mapped = mapVisionEnvelope(response.vision);
  assert.equal(mapped.draft_id, 'synthetic-draft');
  assert.deepEqual(mapped.draft, response.vision.draft);
  assert.deepEqual(visibleVisionFields(mapped.draft), [
    'summary', 'category', 'tags', 'amount', 'currency', 'date', 'due_date',
    'institution', 'location_name', 'location_address', 'location_purpose'
  ]);
  assert.equal(mapped.draft.time, null);
});

test('unknown fields stay hidden and user reminder is preserved', () => {
  const mapped = mapVisionEnvelope({ draft_id: 'new', draft: { summary: 'only summary' } });
  assert.deepEqual(visibleVisionFields(mapped.draft), ['summary']);
  assert.equal(mapped.draft.amount, null);
  assert.deepEqual(mapped.draft.tags, []);
  assert.deepEqual(suggestReminderIfUntouched(response.vision.draft, null, false), { day: '2026-10-21', time: null }); // Prefill is not scheduling
  const future = { ...response.vision.draft, due_date: '2030-11-20' };
  assert.deepEqual(suggestReminderIfUntouched(future, null, false), { day: '2026-10-21', time: null });
  assert.equal(suggestReminderIfUntouched(future, '2031-01-01T10:00:00Z', false), null);
  assert.equal(suggestReminderIfUntouched(future, null, true), null);
});


test('category supplies relevant editable fields without hiding recognized data', () => {
  const mapped = mapVisionEnvelope(response.vision);
  assert.deepEqual(categoryFields('bill'), ['summary', 'category', 'tags', 'amount', 'currency', 'date', 'due_date', 'institution']);
  assert.ok(visibleVisionFields(mapped.draft).includes('location_name'));
  assert.ok(categoryFields('meeting').includes('location_address'));
});


test('saved analysis date maps to the same unsaved reminder date when reopening', () => {
  const saved = JSON.stringify(response.vision.draft);
  const first = mapVisionEnvelope({ draft_id: 'confirmed', draft: JSON.parse(saved) }).draft;
  const reopened = mapVisionEnvelope({ draft_id: 'confirmed', draft: JSON.parse(saved) }).draft;
  assert.deepEqual(suggestReminderIfUntouched(first, null, false), { day: '2026-10-21', time: null });
  assert.deepEqual(suggestReminderIfUntouched(reopened, null, false), { day: '2026-10-21', time: null });
  assert.equal(suggestReminderIfUntouched(reopened, '2030-01-01T12:00:00Z', false), null);
  assert.equal(suggestReminderIfUntouched(reopened, null, true), null);
});


test('editing the analysis date updates the reminder suggestion without creating one', () => {
  const draft = response.vision.draft;
  const edited = { ...draft, date: '2031-06-18', due_date: '2032-01-01', time: null };
  assert.deepEqual(suggestReminderIfUntouched(edited, null, false), { day: '2031-06-18', time: null });
  assert.equal(suggestReminderIfUntouched(edited, '2030-01-01T10:00:00Z', false), null);
  assert.equal(suggestReminderIfUntouched(edited, null, true), null);
});
