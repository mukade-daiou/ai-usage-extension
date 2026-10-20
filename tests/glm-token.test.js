import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript, event, flush, deferred } from './helpers/load-typescript.js';

const primary = 'z-ai-open-platform-token-production';
const secondary = 'z-ai-website-token';
const sender = { id: 'synthetic-extension', frameId: 0, tab: { id: 1 }, url: 'https://z.ai/manage' };

function contentHarness(values = {}, send = async () => ({ success: true })) {
  const storage = new Map(Object.entries(values));
  const messages = [];
  const listeners = {};
  const timers = new Map();
  let serial = 0;
  let now = 0;
  let interval;
  let unreadable = false;
  const localStorage = { getItem: key => {
    if (unreadable) throw new Error('Synthetic storage denial');
    return storage.get(key) ?? null;
  } };
  loadTypeScript('src/content/glm.ts', { globals: {
    window: {
      localStorage,
      setTimeout: (fn, delay) => { timers.set(++serial, { fn, at: now + delay }); return serial; },
      clearTimeout: id => timers.delete(id),
      setInterval: fn => { interval = fn; },
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; } },
    chrome: { runtime: { sendMessage: message => { messages.push(structuredClone(message)); return send(message); } } },
    fetch: () => { throw new Error('Network forbidden'); },
  } });
  const tick = async elapsed => {
    const end = now + elapsed;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end;
  };
  return { storage, messages, tick, emit: name => listeners[name](), poll: () => interval(),
    unreadable: value => { unreadable = value; } };
}

function workerHarness(initial = {}) {
  const data = { ...initial };
  const calls = [];
  const chrome = {
    runtime: { id: sender.id, onInstalled: event(), onStartup: event(), onMessage: event() },
    alarms: { get: async () => ({ periodInMinutes: 5 }), create: async () => {}, onAlarm: event() },
    storage: { onChanged: event(), local: {
      get: async () => ({ ...data }),
      set: async value => { Object.assign(data, value); calls.push('set'); },
      remove: async key => { delete data[key]; calls.push('remove'); },
    } },
    tabs: { create: async () => {} },
  };
  loadTypeScript('src/background/index.ts', { globals: { chrome, fetch: () => { throw Error('Network forbidden'); } }, mocks: {
    '../shared/language': { applyStoredLanguage: async () => {} },
    '../shared/locales': { loadLocaleMessages: async () => ({}) },
    '../shared/settings': { readExtensionSettings: async () => ({ language: 'auto' }) },
    './badge': { updateBadge: async () => {} },
    './services/analytics': { track: async () => true },
    './services/UsageService': { UsageService: { getUsageState: async () => ({}), refreshAllUsage: async () => ({}) } },
  } });
  const send = (message, source = sender) => new Promise(resolve => chrome.runtime.onMessage.emit(message, source, resolve));
  return { chrome, data, calls, send };
}

it('initial empty page and unreadable storage never clear a saved credential', async () => {
  const page = contentHarness();
  await page.tick(30000); page.emit('storage'); page.poll();
  assert.equal(page.messages.length, 0);
  page.storage.set(primary, 'synthetic-A'); page.poll(); await flush();
  page.unreadable(true); page.storage.clear(); page.poll(); await page.tick(1000);
  assert.deepEqual(page.messages.map(m => m.type), ['SET_GLM_TOKEN']);
});

it('observed removal clears once, a new login republishes, and alternate token keys remain valid', async () => {
  const page = contentHarness({ [primary]: 'synthetic-A' });
  await page.tick(0);
  page.storage.clear(); page.emit('storage');
  await page.tick(999); assert.equal(page.messages.length, 1);
  await page.tick(1);
  page.emit('storage'); page.poll(); await page.tick(30000);
  assert.deepEqual(page.messages, [
    { type: 'SET_GLM_TOKEN', token: 'synthetic-A' },
    { type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' },
  ]);
  page.storage.set(secondary, 'synthetic-B'); page.emit('visibilitychange'); await flush();
  assert.deepEqual(page.messages.at(-1), { type: 'SET_GLM_TOKEN', token: 'synthetic-B' });
});

it('brief empty transitions do not clear, including same-tab writes detected by polling', async () => {
  const page = contentHarness({ [primary]: 'synthetic-A' });
  await page.tick(0); page.storage.clear(); page.poll();
  await page.tick(500); page.storage.set(primary, 'synthetic-B'); page.poll();
  await page.tick(500);
  assert.deepEqual(page.messages.map(m => m.type), ['SET_GLM_TOKEN', 'SET_GLM_TOKEN']);
  page.storage.clear(); page.poll(); await page.tick(1000);
  assert.deepEqual(page.messages.at(-1), { type: 'CLEAR_GLM_TOKEN', token: 'synthetic-B' });
});

it('failed delivery is retried without duplicates after success', async () => {
  let reject = true;
  const page = contentHarness({ [primary]: 'synthetic-A' }, async () => ({ success: !reject }));
  await page.tick(0); reject = false; page.poll(); await flush();
  page.poll(); assert.equal(page.messages.length, 2);
  page.storage.clear(); reject = true; page.poll(); await page.tick(1000);
  reject = false; page.poll(); await page.tick(1000); page.poll();
  assert.equal(page.messages.filter(m => m.type === 'CLEAR_GLM_TOKEN').length, 2);
});

it('content → worker → storage clears only the observed auto token and preserves the manual API key', async () => {
  const worker = workerHarness({ glm_api_key: 'synthetic-manual' });
  const page = contentHarness({ [primary]: 'synthetic-A' }, worker.send);
  await page.tick(0); assert.equal(worker.data.glm_token, 'synthetic-A');
  page.storage.clear(); page.poll(); await page.tick(1000);
  assert.equal(worker.data.glm_token, undefined);
  assert.equal(worker.data.glm_api_key, 'synthetic-manual');
  page.storage.set(primary, 'synthetic-B'); page.poll(); await flush();
  assert.equal(worker.data.glm_token, 'synthetic-B');
});

it('a saved token is still cleared when its SET acknowledgement was lost before removal', async () => {
  const worker = workerHarness();
  const page = contentHarness({ [primary]: 'synthetic-A' }, async message => {
    const response = await worker.send(message);
    if (message.type === 'SET_GLM_TOKEN') throw Error('Synthetic lost acknowledgement');
    return response;
  });
  await page.tick(0);
  assert.equal(worker.data.glm_token, 'synthetic-A');
  page.storage.clear(); page.poll(); await page.tick(1000);
  assert.equal(worker.data.glm_token, undefined);
  assert.equal(page.messages.filter(m => m.type === 'CLEAR_GLM_TOKEN').length, 1);
});

it('a late failed clear acknowledgement cannot resurrect an older observed token after a newer cycle', async () => {
  const oldClear = deferred();
  const page = contentHarness({ [primary]: 'synthetic-A' }, message =>
    message.type === 'CLEAR_GLM_TOKEN' && message.token === 'synthetic-A'
      ? oldClear.promise : Promise.resolve({ success: true }));
  await page.tick(0); page.storage.clear(); page.poll(); await page.tick(1000);
  page.storage.set(primary, 'synthetic-B'); page.poll(); await flush();
  page.storage.clear(); page.poll(); await page.tick(1000);
  const count = page.messages.length;
  oldClear.reject(Error('Synthetic delayed failure')); await flush();
  page.poll(); await page.tick(1000);
  assert.equal(page.messages.length, count);
});

it('late clear from another tab cannot erase a newer token; worker restart retains the rule', async () => {
  const worker = workerHarness();
  await worker.send({ type: 'SET_GLM_TOKEN', token: 'synthetic-A' });
  await worker.send({ type: 'SET_GLM_TOKEN', token: 'synthetic-B' }, { ...sender, tab: { id: 2 } });
  await worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' });
  assert.equal(worker.data.glm_token, 'synthetic-B');
  const restarted = workerHarness(worker.data);
  await restarted.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' });
  assert.equal(restarted.data.glm_token, 'synthetic-B');
  await restarted.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-B' });
  assert.equal(restarted.data.glm_token, undefined);
});

it('serialized storage updates preserve new tokens during a delayed clear', async () => {
  const worker = workerHarness({ glm_token: 'synthetic-A' });
  const gate = deferred();
  const get = worker.chrome.storage.local.get;
  worker.chrome.storage.local.get = async () => { await gate.promise; return get(); };
  const clear = worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' });
  const set = worker.send({ type: 'SET_GLM_TOKEN', token: 'synthetic-B' });
  gate.resolve(); await Promise.all([clear, set]);
  assert.equal(worker.data.glm_token, 'synthetic-B');
  assert.deepEqual(worker.calls, ['remove', 'set']);
});

it('rejects wrong sender, frame, origin, message shape and unsupported kind without storage changes', async () => {
  const worker = workerHarness({ glm_token: 'synthetic-A' });
  for (const source of [{}, { ...sender, id: 'other' }, { ...sender, frameId: 1 },
    { ...sender, url: 'https://z.ai.evil.invalid/' }, { ...sender, url: 'http://z.ai/' }, { ...sender, tab: undefined }]) {
    assert.equal((await worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' }, source)).success, false);
  }
  for (const token of ['', 1, null]) assert.equal((await worker.send({ type: 'CLEAR_GLM_TOKEN', token })).success, false);
  let responded = false;
  worker.chrome.runtime.onMessage.emit({ type: 'DELETE_GLM_TOKEN' }, sender, () => { responded = true; });
  await flush(); assert.equal(responded, false); assert.equal(worker.calls.length, 0);
});

it('storage failures are acknowledged as failure and a later message recovers', async () => {
  const worker = workerHarness({ glm_token: 'synthetic-A' });
  const remove = worker.chrome.storage.local.remove;
  worker.chrome.storage.local.remove = async () => { throw Error('Synthetic failure'); };
  assert.equal((await worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' })).success, false);
  assert.equal(worker.data.glm_token, 'synthetic-A');
  worker.chrome.storage.local.remove = remove;
  assert.equal((await worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' })).success, true);
});

it('UsageService stops using the removed session token and still uses a manual API key', async () => {
  const worker = workerHarness({ glm_token: 'synthetic-A' });
  const headers = [];
  const { UsageService } = loadTypeScript('src/background/services/UsageService.ts', { globals: {
    chrome: worker.chrome,
    fetch: async (_url, options) => { headers.push(options.headers.Authorization); return { ok: false, status: 401, json: async () => ({}) }; },
  } });
  await UsageService.fetchGlmUsage(); assert.ok(headers.includes('Bearer synthetic-A'));
  await worker.send({ type: 'CLEAR_GLM_TOKEN', token: 'synthetic-A' });
  headers.length = 0; await UsageService.fetchGlmUsage(); assert.equal(headers.length, 0);
  worker.data.glm_api_key = 'synthetic-manual';
  await UsageService.fetchGlmUsage(); assert.ok(headers.includes('Bearer synthetic-manual'));
  assert.ok(!headers.includes('Bearer synthetic-A'));
});
