import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the shipping TS with native transport mocked; never use AWS or OpenAI.
function loadUpload({ uploadStatus = 204, responseText = '', hang = false, confirmError } = {}) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const progress = [];
  const nativeFiles = {
    FileSystemUploadType: { MULTIPART: 1 }, FileSystemSessionType: { FOREGROUND: 1 },
    getInfoAsync: async () => ({ exists: true, isDirectory: false, size: 123 }),
    createUploadTask(url, uri, options) {
      const call = { method: 'POST', url, uri, options, cancelled: false };
      calls.push(call);
      return {
        uploadAsync: () => hang ? new Promise(() => {}) : Promise.resolve({ status: uploadStatus, body: responseText }),
        cancelAsync: async () => { call.cancelled = true; },
      };
    },
  };
  const requests = [];
  const client = {
    API_URL: 'https://api.invalid',
    async request(path, options) {
      requests.push({ path, options });
      if (path.endsWith('/complete')) {
        if (confirmError) throw confirmError;
        return { id: 7, source_image_path: 's3://synthetic/users/alice/originals/7.png' };
      }
      return { memory_id: 7, upload_id: 'upload-7', url: 'https://s3.invalid', fields: { key: 'pending/alice/7', policy: 'synthetic' } };
    },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL('../api/images.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: (name) => {
      if (name === 'expo-file-system/legacy') return nativeFiles;
      assert.equal(name, './client'); return client;
    },
    process: { env: { EXPO_PUBLIC_STORAGE_BACKEND: 's3' } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { api: module.exports, calls, requests, timers, progress };
}

const photo = { uri: 'file:///synthetic.png', name: 'synthetic.png', type: 'image/png' };

test('upload contract uses a foreground native file task and confirms only after success', async () => {
  const h = loadUpload();
  const result = await h.api.createMemoryFromImage(photo, (value) => h.progress.push(value));
  assert.equal(result.id, 7);
  assert.equal(h.calls[0].url, 'https://s3.invalid');
  assert.equal(h.calls[0].uri, photo.uri);
  assert.equal(h.calls[0].options.fieldName, 'file');
  assert.equal(h.calls[0].options.sessionType, 1);
  assert.equal(h.calls[0].options.parameters.key, 'pending/alice/7');
  assert.equal(h.calls[0].options.headers, undefined);
  assert.equal(JSON.parse(h.requests[0].options.body).size, 123);
  assert.equal(h.requests[1].path, '/memories/7/image/uploads/complete');
  assert.equal(h.timers.size, 0);
  assert.ok(h.progress.includes('Confirming upload…'));
});

test('S3 access denial is visible, sanitized, and never confirms or retries', async () => {
  const h = loadUpload({ uploadStatus: 403, responseText: '<Error><Code>AccessDenied</Code><Message>private signed material</Message></Error>' });
  await assert.rejects(h.api.createMemoryFromImage(photo), /HTTP 403, AccessDenied/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(h.timers.size, 0);
});

test('a silent native upload is aborted by the watchdog without confirming', async () => {
  const h = loadUpload({ hang: true });
  const pending = h.api.createMemoryFromImage(photo);
  const rejected = assert.rejects(pending, /S3 upload timed out/);
  for (let i = 0; i < 20 && !h.calls.some((call) => call.method === 'POST'); i++) await Promise.resolve();
  const timer = [...h.timers.values()].find((timer) => timer.delay === 60000);
  assert.ok(timer);
  timer.fn();
  await rejected;
  assert.equal(h.calls[0].cancelled, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
});

test('a failed upload confirmation never returns an attached image or retries', async () => {
  const h = loadUpload({ confirmError: new Error('Uploaded object unavailable') });
  await assert.rejects(h.api.createMemoryFromImage(photo), /Uploaded object unavailable/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.timers.size, 0);
});
