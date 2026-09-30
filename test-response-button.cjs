'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const event = value => ({ target: { value }, stopPropagation() {}, preventDefault() {} });
const voices = [
  { id: 'af_heart', name: 'Heart', lang: 'en-US' },
  { id: 'bf_emma', name: 'Emma', lang: 'en-GB' },
];

// This runs the toolbar's event/state wiring in an isolated VM. It neither
// controls the installed app nor claims to validate browser layout or playback.
function fixture() {
  let hooks, current = null;
  const subscribers = new Map();
  const jobs = [], saves = [], toggles = [], alerts = [], chosen = [];
  let stops = 0, closes = 0;
  const document = { activeElement: null };
  const manager = {
    subscribe(key, callback) {
      subscribers.set(key, callback);
      callback(current === key);
      return () => { subscribers.delete(key); if (current === key) this.stop(); };
    },
    stop() { stops++; current = null; for (const callback of subscribers.values()) callback(false); },
    toggle(key, text, options) {
      this.stop(); current = key; toggles.push({ key, text, options });
      for (const [token, callback] of subscribers) callback(token === key);
    },
    interrupt() {},
  };
  const react = {
    useState(initial) {
      const index = hooks.index++, target = hooks;
      if (!(index in target.slots)) target.slots[index] = initial;
      return [target.slots[index], value => { target.slots[index] = value; }];
    },
    useRef(initial) {
      const index = hooks.index++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
      return hooks.slots[index];
    },
    useId() {
      const index = hooks.index++;
      if (!(index in hooks.slots)) hooks.slots[index] = `test-id-${index}`;
      return hooks.slots[index];
    },
    useEffect(callback) {
      const index = hooks.index++;
      if (!hooks.effects.has(index)) {
        hooks.effects.set(index, callback);
        hooks.toMount.push(index);
      }
    },
  };
  const bridge = {
    getVoices() { const job = deferred(); jobs.push(job); return job.promise; },
    setVoice(voice) { const job = { voice, ...deferred() }; saves.push(job); return job.promise; },
    onInterrupted() { return () => {}; },
  };
  const context = vm.createContext({
    Fo: () => react,
    Y: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    Dr: 'button', qi: 'tooltip', document, HTMLDialogElement: function Dialog() {},
    createResponseSpeaker: () => ({}), createKokoroResponseSpeaker: () => manager,
    codexLocalReadAloud: bridge, addEventListener() {}, alert: message => alerts.push(message),
  });
  for (const file of ['voice-picker.js', 'response-button.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context, { filename: file });
  }
  function mount(component, props) {
    const state = { slots: [], effects: new Map(), cleanups: new Map(), toMount: [], index: 0 };
    return {
      render() {
        hooks = state; state.index = 0;
        const tree = context[component](props);
        walk(tree, node => {
          const reference = node.props?.ref;
          if (!reference || reference.current) return;
          reference.current = {
            open: false, isConnected: true,
            showModal() { this.open = true; }, close() { this.open = false; },
            focus() { document.activeElement = this; }, querySelectorAll() { return []; },
          };
        });
        for (const index of state.toMount.splice(0)) state.cleanups.set(index, state.effects.get(index)());
        return tree;
      },
      unmount() { for (const cleanup of state.cleanups.values()) cleanup?.(); },
    };
  }
  return {
    mount, manager, bridge, jobs, saves, toggles, alerts, chosen,
    response(text, html) { return mount('CodexLocalReadAloudButton', { getText: () => text, getHtml: () => html }); },
    picker() {
      return mount('CodexReadAloudVoicePicker', {
        bridge, speaker: manager, onClose() { closes++; },
        onChosen(value) { chosen.push(value); manager.toggle('held-response', 'Held response.'); },
      });
    },
    get stops() { return stops; }, get closes() { return closes; },
  };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) walk(child, visit);
}
function find(tree, predicate) {
  let found;
  walk(tree, node => { if (!found && predicate(node)) found = node; });
  assert.ok(found, 'expected control exists');
  return found;
}
const read = tree => find(tree, node => node.props?.['data-codex-local-read-aloud'] === 'response');
const settings = tree => find(tree, node => node.props?.['data-codex-local-read-aloud'] === 'voice');
const picker = tree => find(tree, node => typeof node.type === 'function' && node.type.name === 'CodexReadAloudVoicePicker');
const button = (tree, text) => find(tree, node => node.type === 'button' && node.props.children === text);

test('first response waits for a voice choice; cancel is silent; saving resumes only its response', async () => {
  const f = fixture(), a = f.response('Only response A.');
  let pending = read(a.render()).props.onClick(event());
  f.jobs[0].resolve({ selectedVoice: null }); await pending;
  assert.equal(f.toggles.length, 0);
  picker(a.render()).props.onClose();
  assert.equal(f.toggles.length, 0);
  pending = read(a.render()).props.onClick(event());
  f.jobs[1].resolve({ selectedVoice: null }); await pending;
  const choice = picker(a.render());
  choice.props.onChosen({ selectedVoice: 'bf_emma' }); choice.props.onClose();
  assert.equal(f.toggles.length, 1);
  assert.equal(f.toggles[0].text, 'Only response A.');
  const previousCalls = f.jobs.length;
  await read(a.render()).props.onClick(event());
  assert.equal(f.jobs.length, previousCalls, 'stopping does not fetch voice settings');
  a.unmount();
});

test('a late voice-settings result for A cannot start audio after B was clicked', async () => {
  const f = fixture(), a = f.response('A'), b = f.response('B');
  const treeA = a.render(), treeB = b.render();
  const pendingA = read(treeA).props.onClick(event()), pendingB = read(treeB).props.onClick(event());
  f.jobs[0].resolve({ selectedVoice: 'af_heart' }); await pendingA;
  assert.equal(f.toggles.length, 0);
  f.jobs[1].resolve({ selectedVoice: 'bf_emma' }); await pendingB;
  assert.equal(f.toggles.length, 1);
  assert.equal(f.toggles[0].text, 'B');
  a.unmount(); b.unmount();
});

test('unmounting while settings load prevents later playback', async () => {
  const f = fixture(), a = f.response('A');
  const pending = read(a.render()).props.onClick(event());
  a.unmount(); f.jobs[0].resolve({ selectedVoice: 'af_heart' }); await pending;
  assert.equal(f.toggles.length, 0);
});

test('the settings button opens the picker without speaking a response', () => {
  const f = fixture(), a = f.response('A');
  settings(a.render()).props.onClick(event());
  assert.equal(f.jobs.length, 0);
  assert.equal(f.toggles.length, 0);
  picker(a.render()); a.unmount();
});

test('saved Aoede starts its attached response directly without another voice choice or override', async () => {
  const f = fixture(), response = f.response('This response belongs to the clicked speaker button.');
  const pending = read(response.render()).props.onClick(event());
  f.jobs[0].resolve({
    voices: [{ id: 'af_aoede', name: 'Aoede', lang: 'en-US' }],
    selectedVoice: 'af_aoede',
  });
  await pending;
  assert.equal(f.toggles.length, 1);
  assert.equal(f.toggles[0].text, 'This response belongs to the clicked speaker button.');
  assert.equal(f.toggles[0].options, undefined,
    'normal response playback must use the helper\'s saved Aoede choice, without a preview override');
  assert.equal(response.render().props.children[2], null, 'a saved voice must not open the picker');
  assert.equal(f.saves.length, 0, 'playback must not require another set_voice call');
  assert.equal(f.alerts.length, 0);
  response.unmount();
});

test('raw Markdown fallback skips backtick and tilde fences, including an unclosed streamed block', async () => {
  const f = fixture(), response = f.response([
    'Use `git status` to inspect changes.',
    '```inline()``` stays inline.',
    '````javascript', 'secretBacktickCode();', '```', 'stillCode();', '````',
    'This later prose remains.',
    '   ~~~python', 'secretTildeCode()', '   ~~~~',
    'This prose also remains.', '```sh', 'unclosedCode()',
  ].join('\n'));
  const pending = read(response.render()).props.onClick(event());
  f.jobs[0].resolve({ selectedVoice: 'af_aoede' }); await pending;
  assert.equal(f.toggles[0].text,
    'Use `git status` to inspect changes.\n```inline()``` stays inline.\n\nThis later prose remains.\n\nThis prose also remains.');
  assert.equal(f.alerts.length, 0); response.unmount();
});

test('code-only fenced Markdown does not request voices or start a response', async () => {
  const f = fixture(), response = f.response('~~~json\n{"only": "code"}\n~~~');
  await read(response.render()).props.onClick(event());
  assert.equal(f.jobs.length, 0); assert.equal(f.toggles.length, 0);
  assert.equal(f.alerts.length, 0); response.unmount();
});

test('supplied HTML without a parser fails closed instead of reading copied raw code', async () => {
  const f = fixture(), response = f.response('rawCodeWithoutFences()', '<pre>rawCodeWithoutFences()</pre>');
  await read(response.render()).props.onClick(event());
  assert.equal(f.jobs.length, 0); assert.equal(f.toggles.length, 0);
  assert.equal(f.alerts.length, 0); response.unmount();
});

test('picker does not choose a default; preview uses the explicitly selected voice', async () => {
  const f = fixture(), p = f.picker();
  p.render(); f.jobs[0].resolve({ voices, selectedVoice: null }); await settle();
  let tree = p.render();
  const select = find(tree, node => node.type === 'select');
  assert.equal(select.props.value, '');
  assert.equal(button(tree, 'Preview').props.disabled, true);
  assert.equal(tree.type, 'dialog');
  assert.equal(tree.props.ref.current.open, true, 'native dialog enters the top layer');
  select.props.onChange(event('bf_emma')); tree = p.render();
  button(tree, 'Preview').props.onClick(event());
  assert.equal(f.toggles[0].options.voice, 'bf_emma');
  assert.equal(f.toggles[0].options.fallback, false);
  p.unmount();
});

test('picker loads the saved voice and saves that explicit choice before resuming held audio', async () => {
  const f = fixture(), p = f.picker();
  p.render(); f.jobs[0].resolve({ voices, selectedVoice: 'bf_emma' }); await settle();
  const tree = p.render();
  assert.equal(find(tree, node => node.type === 'select').props.value, 'bf_emma');
  const saving = button(tree, 'Use this voice').props.onClick(event());
  assert.equal(f.saves[0].voice, 'bf_emma');
  assert.equal(f.chosen.length, 0);
  f.saves[0].resolve({ selectedVoice: 'bf_emma' }); await saving;
  assert.equal(f.chosen[0].selectedVoice, 'bf_emma');
  assert.equal(f.toggles[0].text, 'Held response.');
  assert.equal(f.closes, 1); p.unmount();
});

test('save failure keeps the picker open and does not resume held audio or disclose details', async () => {
  const f = fixture(), p = f.picker();
  p.render(); f.jobs[0].resolve({ voices, selectedVoice: 'bf_emma' }); await settle();
  const saving = button(p.render(), 'Use this voice').props.onClick(event());
  f.saves[0].reject(new Error('/private/path could not be written')); await saving;
  assert.equal(f.chosen.length, 0); assert.equal(f.toggles.length, 0); assert.equal(f.closes, 0);
  assert.equal(find(p.render(), node => node.props.role === 'alert').props.children,
    'Could not save your voice. Please try again.');
  assert.equal(button(p.render(), 'Use this voice').props.disabled, false); p.unmount();
});
