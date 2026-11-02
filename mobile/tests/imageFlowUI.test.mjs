import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';

test('photo upload switches to a visible processing page and keeps failures visible', async () => {
  const hooks = [];
  let cursor = 0;
  let confirmation;
  let rejectUpload;
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (value) => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(value) { const index = cursor++; return hooks[index] ??= { current: value }; },
    useEffect() {},
  };
  const noop = () => {};
  const modules = {
    react: { default: react, ...react },
    'react-native': { StyleSheet: { create: (value) => value }, Alert: { alert: (_title, _message, buttons) => { confirmation = buttons; } }, Platform: { OS: 'ios' }, Text: 'Text', View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-notifications': { setNotificationHandler: noop },
    'expo-image-picker': {
      requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
      launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///synthetic.png', fileName: 'synthetic.png', mimeType: 'image/png' }] }),
    },
    './api/images': {
      createMemoryFromImage: (_image, progress) => {
        progress('Uploading photo…');
        return new Promise((_, reject) => { rejectUpload = reject; });
      },
    },
    './api/client': { API_URL: 'https://synthetic.invalid', request: async () => [] },
    './styles/theme': { colors: {}, spacing: {} },
    './tagFilter': { availableTags: () => [], displayTags: () => [], filterByTags: (value) => value },
    './visionDraft': { emptyVisionDraft: () => ({}), visionKeys: [] },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8') + '\nexport { AppContent };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: (name) => {
      if (name === 'react') return { __esModule: true, ...modules.react };
      return modules[name] ?? {};
    },
    process: { env: { EXPO_PUBLIC_APP_ENV: 'cloud' } }, setTimeout, clearTimeout, console, Error,
  });
  const render = () => { cursor = 0; return module.exports.AppContent(); };
  const list = render();
  await list.props.onOpenLibrary();
  const operation = confirmation.find((button) => button.text === 'Agree and Process').onPress();
  for (let i = 0; i < 10 && !rejectUpload; i++) await Promise.resolve();
  const processing = JSON.stringify(render());
  assert.ok(processing.includes('Uploading photo…'));
  assert.ok(processing.includes('ActivityIndicator'));
  rejectUpload(new Error('S3 upload failed (HTTP 403, AccessDenied)'));
  await operation;
  const failed = JSON.stringify(render());
  assert.ok(failed.includes('S3 upload failed (HTTP 403, AccessDenied)'));
  assert.ok(failed.includes('Back to Memories'));
});
