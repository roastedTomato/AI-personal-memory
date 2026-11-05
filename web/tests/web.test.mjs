import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

async function loadModule(file, define = {}) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', define });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const fields = await loadModule('../src/memoryFields.ts');

test('confirmed image fields retain details beyond the summary and tolerate legacy JSON', () => {
  const memory = { confirmed_content: 'Reviewed summary', amount: null, tags: ['power'], confirmed_vision: JSON.stringify({ amount: '125.00', currency: 'NZD', date: '2027-01-20', institution: 'Power company', location_address: 'Hamilton' }) };
  const draft = fields.memoryFields(memory);
  assert.equal(draft.amount, '125.00');
  assert.equal(draft.institution, 'Power company');
  assert.equal(draft.location_address, 'Hamilton');
  assert.equal(draft.summary, 'Reviewed summary');
  assert.deepEqual(draft.tags, ['power']);
  assert.equal(fields.memoryFields({ amount: '0', confirmed_vision: '{broken' }).amount, '0');
});

test('manual structured payload can clear fields without discarding a zero amount', () => {
  assert.deepEqual(fields.structuredPayload({ ...fields.memoryFields(), amount: '0', currency: 'nzd', date: '2027-01-20' }), {
    amount: '0', currency: 'NZD', event_date: '2027-01-20', due_date: null, location: null,
  });
});

test('tag filtering intersects selected tags, ignores case and keeps every unfiltered item', () => {
  const memories = [{ tags: ['Power', 'bill'] }, { tags: ['bill'] }, { tags: [] }];
  assert.deepEqual(fields.filterMemories(memories, ['POWER', 'bill']), [memories[0]]);
  assert.deepEqual(fields.filterMemories(memories, []), memories);
  assert.deepEqual(fields.filterMemories(memories, ['missing']), []);
});

test('reminder suggestions prefer due dates and never invent a time or accept a past date', () => {
  const now = new Date('2026-11-05T00:00:00');
  assert.deepEqual(fields.reminderSuggestion({ ...fields.memoryFields(), due_date: '2027-02-01', date: '2026-10-01' }, now), { day: '2027-02-01', time: '' });
  assert.equal(fields.reminderSuggestion({ ...fields.memoryFields(), due_date: '2020-01-01' }, now), null);
  assert.equal(fields.reminderSuggestion({ ...fields.memoryFields(), date: 'invalid' }, now), null);
});

test('password recovery uses Cognito reset operations and propagates expired-code errors', async () => {
  const auth = await loadModule('../src/auth.ts', { 'import.meta.env.VITE_COGNITO_REGION': '"ap-southeast-2"', 'import.meta.env.VITE_COGNITO_CLIENT_ID': '"synthetic-client"' });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, target: init.headers['X-Amz-Target'], body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  try {
    await auth.requestPasswordReset('synthetic@example.test');
    await auth.confirmPasswordReset('synthetic@example.test', '123456', 'SyntheticPassword12!');
    assert.equal(calls[0].target, 'AWSCognitoIdentityProviderService.ForgotPassword');
    assert.deepEqual(calls[0].body, { ClientId: 'synthetic-client', Username: 'synthetic@example.test' });
    assert.equal(calls[1].target, 'AWSCognitoIdentityProviderService.ConfirmForgotPassword');
    assert.equal(calls[1].body.ConfirmationCode, '123456');
    assert.equal(calls[1].body.Password, 'SyntheticPassword12!');
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Reset code has expired.' }), { status: 400 });
    await assert.rejects(auth.confirmPasswordReset('synthetic@example.test', 'expired', 'SyntheticPassword12!'), /expired/);
  } finally { globalThis.fetch = originalFetch; }
});

test('editing a confirmed photo uses the image endpoint and preserves original sources', () => {
  const memory = { id: 42, source_image_path: 's3://synthetic/original', original_text: 'Original source', confirmed_content: 'Old summary', tags: [], confirmed_vision: JSON.stringify({ amount: '12.50', institution: 'Synthetic utility', location_address: 'Original address' }) };
  const edited = { ...fields.memoryFields(memory), amount: '14.00', date: '2027-02-02', location_name: 'Hamilton' };
  const result = fields.memorySaveRequest(memory, 'Edited title', 'Edited summary', 'bill', ['power'], edited);
  assert.equal(result.path, '/memories/42/image/confirmed');
  assert.equal(result.method, 'PATCH');
  assert.equal(result.body.draft.amount, '14.00');
  assert.equal(result.body.draft.institution, 'Synthetic utility');
  assert.equal(result.body.draft.location_address, 'Original address');
  assert.equal(result.body.draft.summary, 'Edited summary');
  assert.equal('original_text' in result.body, false);
  assert.equal('source_image_path' in result.body, false);
  const reopened = fields.memoryFields({ ...memory, confirmed_vision: JSON.stringify(result.body.draft) });
  assert.equal(reopened.amount, '14.00');
  assert.equal(reopened.date, '2027-02-02');
});

test('manual create and edit include structured fields and use the correct methods', () => {
  const draft = { ...fields.memoryFields(), amount: '12', currency: 'nzd', due_date: '2027-01-01', location_name: 'Hamilton' };
  const create = fields.memorySaveRequest(null, ' Bill ', ' New details ', 'bill', ['power'], draft);
  assert.equal(create.path, '/memories');
  assert.equal(create.method, 'POST');
  assert.equal(create.body.currency, 'NZD');
  assert.equal(create.body.original_text, 'New details');
  const edit = fields.memorySaveRequest({ id: 7, original_text: 'Original', confirmed_content: 'Confirmed' }, 'Edited', 'Original', '', [], fields.memoryFields());
  assert.equal(edit.path, '/memories/7');
  assert.equal(edit.method, 'PATCH');
  assert.equal(edit.body.confirmed_content, 'Confirmed');
  assert.equal(edit.body.amount, null);
});

const chat = await loadModule('../src/chat.ts');
test('first chat question uses the local calendar date and starts without prior context', () => {
  assert.deepEqual(chat.questionPayload(' Next event? ', null, new Date(2027, 0, 2, 0, 30)), {
    question: 'Next event?', consent: true, today: '2027-01-02', conversation_id: null, is_clarification_reply: false,
  });
  assert.throws(() => chat.questionPayload(' ', null));
  assert.throws(() => chat.questionPayload('x'.repeat(1001), null));
});
test('clarification replies retain the backend conversation and new conversations clear it', () => {
  const previous = { conversation_id: 'synthetic-id', status: 'needs_clarification' };
  const payload = chat.questionPayload('Hamilton', previous);
  assert.equal(payload.conversation_id, 'synthetic-id');
  assert.equal(payload.is_clarification_reply, true);
  assert.equal(chat.questionPayload('New independent question', null).is_clarification_reply, false);
  assert.equal(chat.questionPayload('Another question', { ...previous, status: 'completed' }).is_clarification_reply, false);
});
test('empty evidence and provider errors remain truthful answers rather than fabricated success', () => {
  for (const status of ['no_matches', 'needs_clarification', 'answer_unavailable', 'insufficient_evidence']) {
    const response = { status, answer: 'Synthetic backend explanation', sources: [] };
    assert.deepEqual(chat.readAnswer(response), response);
  }
  assert.throws(() => chat.readAnswer({ status: 'completed' }));
  assert.throws(() => chat.readAnswer(null));
});
test('source links retain backend Memory IDs and discard invalid references', () => {
  const result = chat.readAnswer({ status: 'completed', answer: 'See [Memory 42]', sources: [
    { memory_id: 42, title: 'Synthetic event', event_date: '2027-01-01' },
    { memory_id: 'bad', title: 'Invalid reference' }, null,
  ] });
  assert.deepEqual(result.sources, [{ memory_id: 42, title: 'Synthetic event', event_date: '2027-01-01' }]);
});
