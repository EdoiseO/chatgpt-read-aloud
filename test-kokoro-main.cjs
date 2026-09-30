'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createKokoroMainBridge, CHANNEL, INTERRUPT_CHANNEL } = require('./kokoro-main.cjs');

const AUDIO = { done: false, audioBase64: Buffer.from('fixture audio').toString('base64'), mimeType: 'audio/wav' };

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new EventEmitter();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.requests = [];
    this.kills = [];
    this.stdin.write = (data, callback) => {
      this.requests.push(JSON.parse(data));
      callback?.();
      return true;
    };
  }
  kill(signal) { this.kills.push(signal); return true; }
  ready(protocolVersion = 2) {
    this.readySent = true;
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ event: 'ready', protocolVersion, engine: 'mlx' })}\n`));
  }
  respond(request, result = AUDIO) {
    if (!this.readySent) this.ready();
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ rpcId: request.rpcId, result })}\n`));
  }
}

function windowEvent(url = 'app://-/index.html') {
  const sender = new EventEmitter();
  sender.mainFrame = { url };
  sender.messages = [];
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  sender.send = (channel, data) => sender.messages.push({ channel, data });
  return { sender, senderFrame: sender.mainFrame };
}

function fixture(t) {
  const app = new EventEmitter();
  const handlers = new Map();
  const children = [];
  const spawnCalls = [];
  const timers = new Map();
  const electron = {
    app,
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    },
  };
  const bridge = createKokoroMainBridge({
    electron,
    homedir: () => '/fixture/user',
    spawn: (...args) => { spawnCalls.push(args); const child = new FakeChild(); children.push(child); return child; },
    setTimeout: (callback, duration) => {
      const token = { unref() {} };
      timers.set(token, { callback, duration });
      return token;
    },
    clearTimeout: token => timers.delete(token),
  });
  const handle = handlers.get(CHANNEL);
  t.after(() => bridge.dispose());
  return {
    app, handlers, children, spawnCalls, timers, bridge,
    invoke: (event, payload) => handle(event, payload),
    fire: duration => {
      const entries = [...timers.entries()].filter(([, entry]) => entry.duration === duration);
      assert.equal(entries.length, 1, `Expected one ${duration} ms timer`);
      timers.delete(entries[0][0]);
      entries[0][1].callback();
    },
  };
}

function start(f, event = windowEvent(), requestId = 'response-1', text = 'Read this response.') {
  const promise = f.invoke(event, { action: 'start', requestId, text });
  const child = f.children.at(-1);
  return { event, promise, child, request: child.requests.at(-1) };
}

test('sentence range input rejects malformed UTF-16 boundaries, omissions, overlap, and excessive ranges before spawn', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const text = 'First 😀. Second.';
  const valid = [{ start: 0, end: 9 }, { start: 10, end: 17 }];
  const invalid = [null, [], {}, [null], [[0, 17]], [{ start: true, end: 17 }],
    [{ start: 0.5, end: 17 }], [{ start: 0, end: Infinity }], [{ start: -1, end: 17 }],
    [{ start: 0, end: 18 }], [{ start: 0, end: 0 }], [{ start: 1, end: 17 }],
    [{ start: 0, end: 7 }, { start: 7, end: 17 }], // Half an emoji.
    [{ start: 0, end: 9 }, { start: 8, end: 17 }], // Overlap.
    [{ start: 10, end: 17 }, { start: 0, end: 9 }], // Reversed.
    [{ start: 0, end: 9 }, { start: 11, end: 17 }], // Dropped nonwhitespace.
    [{ start: 0, end: 9 }], Array.from({ length: 4097 }, () => ({ start: 0, end: 17 }))];
  for (const sentenceRanges of invalid) {
    await assert.rejects(f.invoke(event, { action: 'start', requestId: 'bad', text, sentenceRanges }), /Invalid/);
  }
  await assert.rejects(f.invoke(event, { action: 'start', requestId: 'white', text: 'A  B.',
    sentenceRanges: [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 5 }] }), /Invalid/);
  for (const broken of ['\uD800x', 'x\uDC00']) {
    await assert.rejects(f.invoke(event, { action: 'start', requestId: 'surrogate', text: broken,
      sentenceRanges: [{ start: 0, end: broken.length }] }), /Invalid/);
  }
  for (const action of ['voices', 'set_voice', 'next', 'cancel']) {
    await assert.rejects(f.invoke(event, { action, requestId: 'id', voice: 'af_aoede', text, sentenceRanges: valid }), /Invalid/);
  }
  assert.equal(f.children.length, 0);
});

test('selection text and exact astral sentence offsets are copied to RPC and returned with each audio part', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const text = 'First 😀. Second.';
  const sentenceRanges = [{ start: 0, end: 9, ignored: 'private' }, { start: 10, end: 17 }];
  const promise = f.invoke(event, { action: 'start', requestId: 'selection', text, sentenceRanges,
    responseTextOutsideSelection: 'This must never be spoken.' });
  const child = f.children[0];
  const request = child.requests.at(-1);
  assert.equal(request.text, text);
  assert(!('responseTextOutsideSelection' in request));
  assert.deepEqual(request.sentenceRanges, [{ start: 0, end: 9 }, { start: 10, end: 17 }]);
  sentenceRanges[0].start = 99; // Main owns a sanitized copy, not mutable caller data.
  const firstAudio = { ...AUDIO, sentenceStart: 0, sentenceEnd: 9 };
  child.respond(request, firstAudio);
  assert.deepEqual(await promise, firstAudio);
  for (const range of [{ start: 0, end: 9 }, { start: 10, end: 17 }]) {
    const next = f.invoke(event, { action: 'next', requestId: 'selection' });
    const result = { ...AUDIO, sentenceStart: range.start, sentenceEnd: range.end };
    child.respond(child.requests.at(-1), result);
    assert.deepEqual(await next, result);
  }
});

test('worker sentence tags must match approved ranges and cannot move backwards', async t => {
  for (const result of [AUDIO, { ...AUDIO, sentenceStart: 0.5, sentenceEnd: 2 },
    { ...AUDIO, sentenceStart: 0, sentenceEnd: 3 }, { ...AUDIO, sentenceStart: 7, sentenceEnd: 9 }]) {
    const f = fixture(t);
    const pending = f.invoke(windowEvent(), { action: 'start', requestId: 'tags', text: 'A. B.',
      sentenceRanges: [{ start: 0, end: 2 }, { start: 3, end: 5 }] });
    const rejected = assert.rejects(pending, /invalid response/);
    const child = f.children[0];
    child.respond(child.requests.at(-1), result);
    await rejected;
    assert.deepEqual(child.kills, ['SIGKILL']);
  }
  const f = fixture(t);
  const event = windowEvent();
  const first = f.invoke(event, { action: 'start', requestId: 'ordered', text: 'A. B.',
    sentenceRanges: [{ start: 0, end: 2 }, { start: 3, end: 5 }] });
  const child = f.children[0];
  child.respond(child.requests.at(-1), { ...AUDIO, sentenceStart: 0, sentenceEnd: 2 });
  await first;
  const second = f.invoke(event, { action: 'next', requestId: 'ordered' });
  child.respond(child.requests.at(-1), { ...AUDIO, sentenceStart: 3, sentenceEnd: 5 });
  await second;
  const backwards = f.invoke(event, { action: 'next', requestId: 'ordered' });
  const rejected = assert.rejects(backwards, /invalid response/);
  child.respond(child.requests.at(-1), { ...AUDIO, sentenceStart: 0, sentenceEnd: 2 });
  await rejected;
});

test('range bounds allow 4096 sentences and ECMAScript whitespace gaps', async t => {
  const f = fixture(t);
  const text = 'x.'.repeat(4096);
  const sentenceRanges = Array.from({ length: 4096 }, (_, index) => ({ start: index * 2, end: index * 2 + 2 }));
  const pending = f.invoke(windowEvent(), { action: 'start', requestId: 'max', text, sentenceRanges });
  const child = f.children[0];
  child.respond(child.requests.at(-1), { ...AUDIO, sentenceStart: 0, sentenceEnd: 2 });
  await pending;
  const whitespace = fixture(t);
  const white = whitespace.invoke(windowEvent(), { action: 'start', requestId: 'spaces', text: '\uFEFF A.\u2028 B. ',
    sentenceRanges: [{ start: 2, end: 4 }, { start: 6, end: 8 }] });
  whitespace.children[0].respond(whitespace.children[0].requests.at(-1), { ...AUDIO, sentenceStart: 2, sentenceEnd: 4 });
  await white;
  await assert.rejects(whitespace.invoke(windowEvent(), { action: 'start', requestId: 'not-space', text: 'A.\u0085B.',
    sentenceRanges: [{ start: 0, end: 2 }, { start: 3, end: 5 }] }), /Invalid/);
});

test('stop and replacement ignore stale sentence tags without altering the new request', async t => {
  const f = fixture(t);
  const firstEvent = windowEvent();
  const first = f.invoke(firstEvent, { action: 'start', requestId: 'a', text: 'A.', sentenceRanges: [{ start: 0, end: 2 }] });
  const canceled = assert.rejects(first, /canceled/);
  const child = f.children[0];
  const oldRequest = child.requests.at(-1);
  await f.invoke(firstEvent, { action: 'cancel', requestId: 'a' });
  await canceled;
  const newer = f.invoke(windowEvent(), { action: 'start', requestId: 'b', text: 'New 😀.', sentenceRanges: [{ start: 0, end: 7 }] });
  child.respond(oldRequest, { ...AUDIO, sentenceStart: 999, sentenceEnd: 1000 });
  assert.equal(child.kills.length, 0);
  child.respond(child.requests.at(-1), { ...AUDIO, sentenceStart: 0, sentenceEnd: 7 });
  assert.deepEqual(await newer, { ...AUDIO, sentenceStart: 0, sentenceEnd: 7 });
});

test('trust gate rejects subframes, other origins, paths, and destroyed senders before spawn', async t => {
  const f = fixture(t);
  const events = [windowEvent('https://example.com/index.html'), windowEvent('app://other/index.html'),
    windowEvent('app://-/settings.html'), windowEvent('app://-/index.html/extra'), windowEvent('not a URL')];
  const subframe = windowEvent();
  subframe.senderFrame = { url: 'app://-/index.html' };
  events.push(subframe);
  const destroyed = windowEvent();
  destroyed.sender.destroyed = true;
  events.push(destroyed);
  for (const event of events) {
    await assert.rejects(f.invoke(event, { action: 'start', requestId: 'id', text: 'secret' }), /not allowed/);
  }
  assert.equal(f.spawnCalls.length, 0);
});

test('detached main frames use fixed offline sandboxed runtime and newline RPC', async t => {
  const f = fixture(t);
  const current = start(f, windowEvent('app://-/detached-window.html?window=1'));
  const [command, args, options] = f.spawnCalls[0];
  assert.equal(command, '/usr/bin/sandbox-exec');
  assert.deepEqual(args, ['-p', '(version 1)(allow default)(deny network*)',
    '/fixture/user/Library/Application Support/ChatGPT Read Aloud/kokoro/.venv/bin/python', '-u',
    '/fixture/user/Library/Application Support/ChatGPT Read Aloud/kokoro/worker-sentences-v2.py']);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.env.HF_HUB_OFFLINE, '1');
  assert.equal(options.env.PYTHONUNBUFFERED, '1');
  assert(!args.join(' ').includes('Read this response.'));
  assert.deepEqual(current.request, { rpcId: 1, action: 'start', requestId: 'response-1', text: 'Read this response.' });
  const json = `${JSON.stringify({ event: 'ready', protocolVersion: 2, engine: 'mlx' })}\n${JSON.stringify({ rpcId: 1, result: AUDIO })}\n`;
  current.child.stdout.emit('data', Buffer.from(json.slice(0, 20)));
  current.child.stdout.emit('data', Buffer.from(json.slice(20)));
  assert.deepEqual(await current.promise, AUDIO);
});

test('payload bounds reject invalid actions, IDs, text, and malformed objects', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const invalid = [null, [], {}, { action: 'shell', requestId: 'id', text: 'x' },
    { action: 'start', requestId: '', text: 'x' }, { action: 'start', requestId: 'x'.repeat(129), text: 'x' },
    { action: 'start', requestId: 'id', text: 'x'.repeat(200001) },
    { action: 'start', requestId: 'id', text: 3 }, { action: 'start', requestId: 'id' },
    { action: 'next', requestId: 'id', text: {} }];
  for (const payload of invalid) await assert.rejects(f.invoke(event, payload), /Invalid/);
  assert.equal(f.children.length, 0);
  const current = start(f, event, 'x'.repeat(128), 'x'.repeat(200000));
  current.child.respond(current.request);
  assert.deepEqual(await current.promise, AUDIO);
});

test('another window or request ID cannot cancel or read the active response', async t => {
  const f = fixture(t);
  const current = start(f);
  current.child.respond(current.request);
  await current.promise;
  for (const action of ['next', 'cancel']) {
    await assert.rejects(f.invoke(windowEvent(), { action, requestId: 'response-1' }), /does not belong/);
    await assert.rejects(f.invoke(current.event, { action, requestId: 'wrong-id' }), /does not belong/);
  }
  assert.equal(current.child.requests.length, 1);
});

test('cross-window start interrupts previous playback, sends cancel immediately, and rejects stale inference', async t => {
  const f = fixture(t);
  const first = start(f);
  const rejected = assert.rejects(first.promise, /replaced/);
  const second = start(f, windowEvent(), 'response-2', 'Second response.');
  await rejected;
  assert.equal(f.children.length, 1);
  assert.deepEqual(first.event.sender.messages, [{ channel: INTERRUPT_CHANNEL, data: { requestId: 'response-1' } }]);
  assert.deepEqual(first.child.requests.map(request => request.action), ['start', 'cancel', 'start']);
  assert.equal(first.child.requests[1].requestId, 'response-1');
  assert(!('text' in first.child.requests[1]));
  first.child.respond(first.request); // Stale audio is ignored.
  second.child.respond(second.request);
  assert.deepEqual(await second.promise, AUDIO);
  await assert.rejects(f.invoke(first.event, { action: 'cancel', requestId: 'response-1' }), /does not belong/);
});

test('same-window cancel resolves immediately during inference and removes ownership', async t => {
  const f = fixture(t);
  const current = start(f);
  const rejected = assert.rejects(current.promise, /canceled/);
  assert.deepEqual(await f.invoke(current.event, { action: 'cancel', requestId: 'response-1' }), { done: true });
  await rejected;
  assert.equal(current.child.requests.at(-1).action, 'cancel');
  current.child.respond(current.request);
  await assert.rejects(f.invoke(current.event, { action: 'next', requestId: 'response-1' }), /does not belong/);
  assert.equal(current.event.sender.messages.length, 0);
});

test('only one inference RPC runs per response and done retains ownership until renderer cancel', async t => {
  const f = fixture(t);
  const current = start(f);
  await assert.rejects(f.invoke(current.event, { action: 'next', requestId: 'response-1' }), /already being generated/);
  current.child.respond(current.request);
  await current.promise;
  const next = f.invoke(current.event, { action: 'next', requestId: 'response-1' });
  const nextRequest = current.child.requests.at(-1);
  assert.deepEqual(nextRequest, { rpcId: 2, action: 'next', requestId: 'response-1' });
  current.child.respond(nextRequest, { done: true, unused: 'discard' });
  assert.deepEqual(await next, { done: true });
  assert.deepEqual(await f.invoke(current.event, { action: 'cancel', requestId: 'response-1' }), { done: true });
  await assert.rejects(f.invoke(current.event, { action: 'next', requestId: 'response-1' }), /does not belong/);
});

test('rapid replacement never fills pending slots or defers cancellation', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const rejected = [];
  let latest;
  for (let index = 0; index < 40; index++) {
    if (latest) rejected.push(assert.rejects(latest.promise, /replaced/));
    latest = start(f, event, `response-${index}`);
  }
  await Promise.all(rejected);
  assert.equal(f.children.length, 1);
  assert.equal(latest.child.requests.filter(request => request.action === 'cancel').length, 39);
  assert.equal(f.timers.size, 2); // One inference timeout and one idle timer.
  latest.child.respond(latest.request);
  await latest.promise;
});

test('worker errors expose generic messages without raw stdout or stderr', async t => {
  const f = fixture(t);
  const current = start(f);
  const rejected = assert.rejects(current.promise, error => {
    assert.equal(error.message, 'Unable to generate local read-aloud audio.');
    assert(!error.message.includes('PRIVATE'));
    return true;
  });
  current.child.ready();
  current.child.stderr.emit('data', Buffer.from('PRIVATE response text in diagnostics'));
  current.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ rpcId: current.request.rpcId,
    error: { code: 'SPEECH_FAILED', message: 'PRIVATE response text and paths' } })}\n`));
  await rejected;
  await assert.rejects(f.invoke(current.event, { action: 'next', requestId: 'response-1' }), /does not belong/);
});

test('exact runtime startup failure offers a safe unavailable message; malformed fatal replies fail closed', async t => {
  for (const [response, expected] of [
    [{ event: 'fatal', error: { code: 'RUNTIME_UNAVAILABLE' } }, 'Unable to start local read-aloud worker.'],
    [{ event: 'fatal', error: true }, 'Local read-aloud worker sent an invalid response.'],
    [{ event: 'fatal', error: { code: 'PRIVATE' } }, 'Local read-aloud worker sent an invalid response.'],
    [{ event: 'fatal', error: { code: 'RUNTIME_UNAVAILABLE', message: 'PRIVATE' } }, 'Local read-aloud worker sent an invalid response.'],
    [{ event: 'fatal', rpcId: 1, error: { code: 'RUNTIME_UNAVAILABLE' } }, 'Local read-aloud worker sent an invalid response.'],
  ]) {
    const f = fixture(t);
    const promise = f.invoke(windowEvent(), { action: 'voices' });
    const rejected = assert.rejects(promise, error => { assert.equal(error.message, expected); return true; });
    f.children[0].stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
    await rejected;
    assert.deepEqual(f.children[0].kills, ['SIGKILL']);
  }
});

test('invalid worker errors cannot be treated as an unavailable model or native fallback', async t => {
  for (const error of [true, null, [], { code: 'PRIVATE' }, { code: 'SPEECH_FAILED', message: {} },
    { code: 'SPEECH_FAILED', unexpected: true }]) {
    const f = fixture(t);
    const current = start(f);
    const rejected = assert.rejects(current.promise, /invalid response/);
    current.child.ready();
    current.child.stdout.emit('data', Buffer.from(JSON.stringify({ rpcId: current.request.rpcId, error }) + '\n'));
    await rejected;
    assert.deepEqual(current.child.kills, ['SIGKILL']);
  }
  const f = fixture(t);
  const current = start(f);
  const rejected = assert.rejects(current.promise, /rejected the request/);
  current.child.ready();
  current.child.stdout.emit('data', Buffer.from(JSON.stringify({ rpcId: current.request.rpcId,
    error: { code: 'INVALID_TEXT', message: 'PRIVATE' } }) + '\n'));
  await rejected;
  assert.deepEqual(current.child.kills, []);
});

test('malformed JSON, invalid result schemas, and oversized output terminate the worker', async t => {
  const invalidLines = ['not JSON\n', JSON.stringify({ rpcId: 1.5, result: AUDIO }) + '\n',
    JSON.stringify({ rpcId: 1, result: { ...AUDIO, mimeType: 'text/html' } }) + '\n',
    JSON.stringify({ rpcId: 1, result: { ...AUDIO, audioBase64: '!!==' } }) + '\n',
    'x'.repeat(8 * 1024 * 1024 + 1)];
  for (const line of invalidLines) {
    const f = fixture(t);
    const current = start(f);
    const rejected = assert.rejects(current.promise, /invalid response/);
    current.child.stdout.emit('data', Buffer.from(line));
    await rejected;
    assert.deepEqual(current.child.kills, ['SIGKILL']);
    assert.equal(f.timers.size, 0);
  }
});

test('child exit rejects pending RPCs, interrupts playback, and allows a fresh worker', async t => {
  const f = fixture(t);
  const current = start(f);
  const rejected = assert.rejects(current.promise, /worker stopped/);
  current.child.emit('exit', 1, null);
  await rejected;
  assert.equal(f.timers.size, 0);
  assert.equal(current.event.sender.messages[0].channel, INTERRUPT_CHANNEL);
  const next = start(f, current.event, 'response-new');
  assert.equal(f.children.length, 2);
  next.child.respond(next.request);
  await next.promise;
});

test('RPC timeout, five-minute idle expiry, and app quit clean up worker and timers', async t => {
  const timeout = fixture(t);
  const timed = start(timeout);
  const rejected = assert.rejects(timed.promise, /timed out/);
  timeout.fire(45000);
  await rejected;
  assert.deepEqual(timed.child.kills, ['SIGKILL']);
  assert.equal(timeout.timers.size, 0);

  const idle = fixture(t);
  const active = start(idle);
  active.child.respond(active.request);
  await active.promise;
  idle.fire(300000);
  assert.deepEqual(active.child.kills, ['SIGKILL']);
  assert.equal(idle.timers.size, 0);
  await assert.rejects(idle.invoke(active.event, { action: 'next', requestId: 'response-1' }), /does not belong/);

  const quit = fixture(t);
  const quitting = start(quit);
  const stopped = assert.rejects(quitting.promise, /was stopped/);
  quit.app.emit('before-quit');
  await stopped;
  assert.deepEqual(quitting.child.kills, ['SIGKILL']);
  assert.equal(quit.timers.size, 0);
  assert.equal(quit.handlers.has(CHANNEL), false);
  quit.bridge.dispose(); // Idempotent.
  await assert.rejects(quit.invoke(quitting.event, { action: 'start', requestId: 'new', text: 'x' }), /unavailable/);
});

test('navigation invalidates the captured owner frame and window closure cancels pending work', async t => {
  const navigation = fixture(t);
  const moved = start(navigation);
  const inactive = assert.rejects(moved.promise, /no longer active/);
  moved.event.sender.mainFrame = { url: 'app://-/index.html' };
  moved.child.respond(moved.request);
  await inactive;
  assert.equal(moved.child.requests.at(-1).action, 'cancel');

  const closure = fixture(t);
  const closed = start(closure);
  const rejected = assert.rejects(closed.promise, /window closed/);
  closed.event.sender.destroyed = true;
  closed.event.sender.emit('destroyed');
  await rejected;
  assert.equal(closed.child.requests.at(-1).action, 'cancel');
  closure.fire(300000);
  assert.deepEqual(closed.child.kills, ['SIGKILL']);
});

test('voice listing preserves no initial selection and validates bounded metadata', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const listed = f.invoke(event, { action: 'voices' });
  const child = f.children[0];
  assert.deepEqual(child.requests[0], { rpcId: 1, action: 'voices' });
  const result = { voices: [{ id: 'af_heart', name: 'Heart', lang: 'en-us' },
    { id: 'bm_george', name: 'George', lang: 'en-gb' }], selectedVoice: null, speed: 1, engine: 'mlx' };
  child.respond(child.requests[0], result);
  assert.deepEqual(await listed, result);
  assert.equal(child.requests.length, 1);
});

test('voice actions have the same trust gate and reject IDs, controls, and unsupported prefixes', async t => {
  const f = fixture(t);
  for (const action of ['voices', 'set_voice']) {
    await assert.rejects(f.invoke(windowEvent('https://example.com/index.html'),
      { action, voice: 'af_heart' }), /not allowed/);
  }
  for (const voice of ['', 'heart', 'ef_dora', 'af_heart; touch /tmp/a', 'af_heart\nother', 'af_\x00heart', 3, 'af_' + 'x'.repeat(65)]) {
    await assert.rejects(f.invoke(windowEvent(), { action: 'set_voice', voice }), /Invalid/);
    await assert.rejects(f.invoke(windowEvent(), { action: 'start', requestId: 'id', text: 'preview', voice }), /Invalid/);
  }
  await assert.rejects(f.invoke(windowEvent(), { action: 'set_voice' }), /Invalid/);
  assert.equal(f.children.length, 0);
});

test('saving selection and explicit voice previews forward only validated voice IDs', async t => {
  const f = fixture(t);
  const event = windowEvent();
  const saved = f.invoke(event, { action: 'set_voice', voice: ' bm_george ' });
  const child = f.children[0];
  assert.deepEqual(child.requests[0], { rpcId: 1, action: 'set_voice', voice: 'bm_george' });
  child.respond(child.requests[0], { selectedVoice: 'bm_george' });
  assert.deepEqual(await saved, { selectedVoice: 'bm_george' });
  const preview = start(f, event, 'preview-voice', 'Preview this voice.');
  // Start without an override uses Python's persisted selection, with no main-process default.
  assert(!('voice' in preview.request));
  child.respond(preview.request, { done: true });
  await preview.promise;
  const explicit = f.invoke(event, { action: 'start', requestId: 'preview-2', text: 'Preview.', voice: ' af_heart ' });
  const request = child.requests.at(-1);
  assert.equal(request.voice, 'af_heart');
  child.respond(request, { done: true });
  assert.deepEqual(await explicit, { done: true });
});

test('voice metadata RPC does not take ownership from the active response', async t => {
  const f = fixture(t);
  const active = start(f);
  active.child.respond(active.request);
  await active.promise;
  const listed = f.invoke(windowEvent(), { action: 'voices' });
  active.child.respond(active.child.requests.at(-1), {
    voices: [{ id: 'af_heart', name: 'Heart', lang: 'en-us' }], selectedVoice: 'af_heart', speed: 1, engine: 'onnx',
  });
  await listed;
  assert.equal(active.event.sender.messages.length, 0);
  assert.deepEqual(await f.invoke(active.event, { action: 'cancel', requestId: 'response-1' }), { done: true });
});

test('VOICE_NOT_SELECTED exposes only its fixed safe code and clears active ownership', async t => {
  const f = fixture(t);
  const current = start(f);
  const rejected = assert.rejects(current.promise, error => {
    assert.equal(error.message, 'VOICE_NOT_SELECTED');
    return true;
  });
  current.child.ready();
  current.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ rpcId: current.request.rpcId,
    error: { code: 'VOICE_NOT_SELECTED', message: 'PRIVATE diagnostics' } })}\n`));
  await rejected;
  await assert.rejects(f.invoke(current.event, { action: 'next', requestId: 'response-1' }), /does not belong/);
});

test('unknown selected voice and malformed voice metadata fail closed', async t => {
  const invalidResults = [
    { voices: [], selectedVoice: 'af_heart', speed: 1, engine: 'mlx' },
    { voices: [{ id: 'ef_dora' }], selectedVoice: null, speed: 1, engine: 'mlx' },
    { voices: [{ id: 'af_heart', name: 'x'.repeat(129) }], selectedVoice: null, speed: 1, engine: 'mlx' },
    { voices: [{ id: 'af_heart' }, { id: 'af_heart' }], selectedVoice: null, speed: 1, engine: 'mlx' },
    { voices: [], selectedVoice: null, speed: 1, engine: 'http' },
  ];
  for (const result of invalidResults) {
    const f = fixture(t);
    const listing = f.invoke(windowEvent(), { action: 'voices' });
    const rejected = assert.rejects(listing, /invalid response/);
    const child = f.children[0];
    child.respond(child.requests[0], result);
    await rejected;
    assert.deepEqual(child.kills, ['SIGKILL']);
  }
});

test('pending RPC count is bounded but cancellation remains immediate and exit rejects every pending call', async t => {
  const f = fixture(t);
  const current = start(f);
  const canceled = assert.rejects(current.promise, /canceled/);
  const metadataRejections = [];
  for (let index = 0; index < 15; index++) {
    metadataRejections.push(assert.rejects(f.invoke(current.event, { action: 'voices' }), /worker stopped/));
  }
  await assert.rejects(f.invoke(current.event, { action: 'voices' }), /Too many/);
  assert.equal(current.child.requests.length, 16);
  assert.deepEqual(await f.invoke(current.event, { action: 'cancel', requestId: 'response-1' }), { done: true });
  await canceled;
  assert.equal(current.child.requests.at(-1).action, 'cancel');
  current.child.emit('exit', 1, null);
  await Promise.all(metadataRejections);
  assert.equal(f.timers.size, 0);
});

test('changing saved voice globally interrupts another window and cancels its pending old-voice chunk first', async t => {
  const f = fixture(t);
  const active = start(f);
  active.child.respond(active.request);
  await active.promise; // A renderer can now be playing this audio.
  const next = f.invoke(active.event, { action: 'next', requestId: 'response-1' });
  const rejected = assert.rejects(next, /voice was changed/);
  const saved = f.invoke(windowEvent('app://-/detached-window.html'), { action: 'set_voice', voice: 'bm_george' });
  await rejected;
  assert.deepEqual(active.event.sender.messages, [{ channel: INTERRUPT_CHANNEL, data: { requestId: 'response-1' } }]);
  assert.deepEqual(active.child.requests.slice(-2).map(request => request.action), ['cancel', 'set_voice']);
  assert.equal(active.child.requests.at(-2).requestId, 'response-1');
  active.child.respond(active.child.requests.at(-1), { selectedVoice: 'bm_george' });
  assert.deepEqual(await saved, { selectedVoice: 'bm_george' });
  await assert.rejects(f.invoke(active.event, { action: 'next', requestId: 'response-1' }), /does not belong/);
});

test('cross-window start interrupts a final chunk even after prefetched next returns done', async t => {
  const f = fixture(t);
  const playing = start(f);
  playing.child.respond(playing.request);
  await playing.promise;
  const prefetched = f.invoke(playing.event, { action: 'next', requestId: 'response-1' });
  playing.child.respond(playing.child.requests.at(-1), { done: true });
  assert.deepEqual(await prefetched, { done: true });
  const other = start(f, windowEvent(), 'other-window');
  assert.deepEqual(playing.event.sender.messages, [{ channel: INTERRUPT_CHANNEL, data: { requestId: 'response-1' } }]);
  assert.deepEqual(playing.child.requests.slice(-2).map(request => request.action), ['cancel', 'start']);
  other.child.respond(other.request, { done: true });
  await other.promise;
  assert.deepEqual(await f.invoke(other.event, { action: 'cancel', requestId: 'other-window' }), { done: true });
});

const skip = range => ({ done: false, skipped: true, sentenceStart: range.start, sentenceEnd: range.end });
const tagged = range => ({ ...AUDIO, sentenceStart: range.start, sentenceEnd: range.end });

test('protocol 2 tracks every silent range without audio and retains multichunk progress', async t => {
  for (const pattern of [['skip', 'audio'], ['audio', 'skip', 'audio'], ['audio', 'skip'],
    ['skip', 'skip', 'audio'], ['skip', 'skip'], ['audio', 'repeat', 'skip', 'audio']]) {
    const f = fixture(t), event = windowEvent();
    const ranges = pattern.filter(kind => kind !== 'repeat').map((_, index) => ({ start: index * 3, end: index * 3 + 2 }));
    const text = ranges.map(() => 'x.').join(' ');
    let pending = f.invoke(event, { action: 'start', requestId: 'coverage', text, sentenceRanges: ranges });
    const child = f.children[0];
    let index = -1;
    for (const kind of pattern) {
      if (kind !== 'repeat') index++;
      const result = kind === 'skip' ? skip(ranges[index]) : tagged(ranges[index]);
      child.respond(child.requests.at(-1), result);
      assert.deepEqual(await pending, result);
      pending = f.invoke(event, { action: 'next', requestId: 'coverage' });
    }
    child.respond(child.requests.at(-1), { done: true });
    assert.deepEqual(await pending, { done: true });
  }
});

test('invalid skips, gaps, silent repeats and premature completion fail closed', async t => {
  const ranges = [{ start: 0, end: 2 }, { start: 3, end: 5 }];
  const cases = [
    [skip(ranges[1])], [tagged(ranges[1])], [{ done: true }],
    [{ ...skip(ranges[0]), skipped: 'true' }], [{ ...skip(ranges[0]), audioBase64: AUDIO.audioBase64 }],
    [{ ...skip(ranges[0]), mimeType: 'audio/wav' }], [{ ...skip(ranges[0]), sentenceEnd: 3 }],
    [skip(ranges[0]), skip(ranges[0])], [skip(ranges[0]), tagged(ranges[0])],
    [tagged(ranges[0]), skip(ranges[0])], [tagged(ranges[0]), { done: true }],
    [skip(ranges[0]), { done: true }], [tagged(ranges[0]), skip(ranges[1]), tagged(ranges[0])],
    [skip(ranges[0]), skip(ranges[1]), { done: true, skipped: true }],
  ];
  for (const sequence of cases) {
    const f = fixture(t), event = windowEvent();
    let pending = f.invoke(event, { action: 'start', requestId: 'invalid-skip', text: 'A. B.', sentenceRanges: ranges });
    const child = f.children[0];
    for (let index = 0; index < sequence.length; index++) {
      const bad = index === sequence.length - 1;
      const rejected = bad ? assert.rejects(pending, /invalid response/) : null;
      child.respond(child.requests.at(-1), sequence[index]);
      if (bad) await rejected;
      else { await pending; pending = f.invoke(event, { action: 'next', requestId: 'invalid-skip' }); }
    }
    assert.deepEqual(child.kills, ['SIGKILL']);
  }
  const f = fixture(t), current = start(f);
  const rejected = assert.rejects(current.promise, /invalid response/);
  current.child.respond(current.request, skip(ranges[0]));
  await rejected; // Skips without requested ranges cannot prove coverage.
});

test('missing, wrong and duplicate ready handshakes cannot serve an RPC', async t => {
  for (const kind of ['missing', 'wrong', 'duplicate']) {
    const f = fixture(t), current = start(f);
    const rejected = assert.rejects(current.promise, /invalid response/);
    if (kind === 'wrong') current.child.ready(1);
    if (kind === 'duplicate') { current.child.ready(); current.child.ready(); }
    if (kind === 'missing') current.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ rpcId: current.request.rpcId, result: AUDIO })}\n`));
    await rejected;
    assert.deepEqual(current.child.kills, ['SIGKILL']);
  }
});

test('canceled silent replies cannot advance a replacement request', async t => {
  const f = fixture(t), event = windowEvent(), ranges = [{ start: 0, end: 2 }];
  const old = f.invoke(event, { action: 'start', requestId: 'old-skip', text: '}.', sentenceRanges: ranges });
  const child = f.children[0], oldRequest = child.requests.at(-1);
  const canceled = assert.rejects(old, /replaced/);
  const fresh = f.invoke(event, { action: 'start', requestId: 'new-skip', text: 'A.', sentenceRanges: ranges });
  await canceled;
  child.respond(oldRequest, skip(ranges[0]));
  child.respond(child.requests.at(-1), tagged(ranges[0]));
  assert.deepEqual(await fresh, tagged(ranges[0]));
  assert.deepEqual(child.kills, []);
});
