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
    useEffect(callback, deps) {
      const index = hooks.index++;
      const previous = hooks.effects.get(index);
      if (!previous || deps === undefined || deps.length !== previous.deps?.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        hooks.effects.set(index, { callback, deps });
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
        for (const index of state.toMount.splice(0)) {
          state.cleanups.get(index)?.();
          state.cleanups.set(index, state.effects.get(index).callback());
        }
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
function hasNativeOffer(tree) {
  let found = false;
  walk(tree, node => { if (node.props?.['data-codex-local-read-aloud'] === 'native-status') found = true; });
  return found;
}

test('host action visibility follows lookup, playback, Stop, and voice-picker state', async () => {
  const f = fixture();
  let visibility;
  const response = f.mount('CodexLocalReadAloudButton', {
    getText: () => 'Keep Stop available while this response is playing.',
    renderContent(pair, state) { visibility = { ...state }; return pair; },
  });
  response.render();
  assert.deepEqual(visibility, { busy: false, pickerOpen: false });
  const pending = read(response.render()).props.onClick(event());
  response.render();
  assert.deepEqual(visibility, { busy: true, pickerOpen: false });
  f.jobs[0].resolve({ selectedVoice: 'af_aoede' });
  await pending;
  const playing = response.render();
  assert.equal(read(playing).props['aria-label'], 'Stop reading aloud');
  assert.deepEqual(visibility, { busy: true, pickerOpen: false });
  await read(playing).props.onClick(event());
  response.render();
  assert.deepEqual(visibility, { busy: false, pickerOpen: false });
  settings(response.render()).props.onClick(event());
  const choosing = response.render();
  assert.deepEqual(visibility, { busy: false, pickerOpen: true });
  picker(choosing).props.onClose();
  response.render();
  assert.deepEqual(visibility, { busy: false, pickerOpen: false });
  assert.equal(f.toggles.length, 1);
  response.unmount();
});

test('selection-only rendering keeps voice choice and fallback dialogs outside the suppressed pair', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture();
    let controls;
    const response = f.mount('CodexLocalReadAloudButton', {
      getText: () => 'Only the selected progress passage.', selectionOnly: true,
      renderContent(pair) { controls = pair; return { type: 'article', props: { children: 'Progress text' } }; },
    });
    const idle = response.render();
    let idlePairs = 0;
    walk(idle, node => { if (node.props?.['data-codex-local-read-aloud'] === 'response') idlePairs++; });
    assert.equal(idlePairs, 0);
    // Exercise the controller command; native-host composition is covered by
    // test-native-selection-host.mjs using an actual selected DOM range.
    const pending = read(controls).props.onClick(event());
    if (unavailable) f.jobs[0].reject(new Error('Local read-aloud is unavailable.'));
    else f.jobs[0].resolve({ selectedVoice: null });
    await pending;
    const tree = response.render();
    if (unavailable) button(tree, 'Use Mac voice').props.onClick(event());
    else picker(tree).props.onChosen({ selectedVoice: 'af_aoede' });
    assert.equal(f.toggles.length, 1);
    assert.equal(f.toggles[0].text, 'Only the selected progress passage.');
    assert.equal(f.alerts.length, 0);
    response.unmount();
  }
});

test('helper lookup failure offers Mac speech only after explicit choice, preserves the read and never saves a voice', async () => {
  const f = fixture(), response = f.response('Only the held passage.');
  const pending = read(response.render()).props.onClick(event());
  f.jobs[0].reject(new Error("Error invoking remote method 'codex-local-read-aloud': Error: Local read-aloud worker stopped."));
  await pending;
  const tree = response.render();
  assert.equal(find(tree, node => node.props.role === 'alert').props.children[0].props.children,
    'Local speech is unavailable.');
  assert.equal(f.toggles.length, 0, 'lookup failure must not start speech automatically');
  assert.equal(read(tree).props['aria-label'], 'Stop reading aloud');
  button(tree, 'Use Mac voice').props.onClick(event());
  assert.equal(f.toggles.length, 1);
  assert.equal(f.toggles[0].text, 'Only the held passage.');
  assert.equal(f.toggles[0].options.mode, 'native');
  assert.equal(f.toggles[0].options.voice, undefined);
  assert.equal(f.jobs.length, 1); assert.equal(f.saves.length, 0); assert.equal(f.alerts.length, 0);
  assert.equal(hasNativeOffer(response.render()), false);
  await read(response.render()).props.onClick(event());
  assert.equal(f.jobs.length, 1, 'stopping native speech must not query voice settings');
  response.unmount();
});

test('dismiss and stop clear an offer; stale actions cannot choose or dismiss a later offer', async () => {
  const f = fixture(), response = f.response('Held response.');
  let pending = read(response.render()).props.onClick(event());
  f.jobs[0].reject(new Error('Local read-aloud worker timed out.')); await pending;
  const oldTree = response.render(), staleUse = button(oldTree, 'Use Mac voice'), staleDismiss = button(oldTree, 'Dismiss');
  staleDismiss.props.onClick(event());
  assert.equal(hasNativeOffer(response.render()), false);
  staleUse.props.onClick(event()); assert.equal(f.toggles.length, 0);
  pending = read(response.render()).props.onClick(event());
  f.jobs[1].reject(new Error('Unable to start local read-aloud worker.')); await pending;
  staleUse.props.onClick(event()); staleDismiss.props.onClick(event());
  assert.equal(hasNativeOffer(response.render()), true, 'old dismissal cannot remove a newer held read');
  assert.equal(f.toggles.length, 0);
  await read(response.render()).props.onClick(event());
  assert.equal(hasNativeOffer(response.render()), false);
  assert.equal(f.jobs.length, 2); assert.equal(f.saves.length, 0); assert.equal(f.alerts.length, 0);
  response.unmount();
});

test('switching or unmounting suppresses late lookup failure and stale native actions', async () => {
  const f = fixture(), a = f.response('A'), b = f.response('B');
  const pendingA = read(a.render()).props.onClick(event());
  const pendingB = read(b.render()).props.onClick(event());
  f.jobs[0].reject(new Error('Local read-aloud worker stopped.')); await pendingA;
  assert.equal(hasNativeOffer(a.render()), false); assert.equal(f.alerts.length, 0);
  f.jobs[1].reject(new Error('Local read-aloud worker stopped.')); await pendingB;
  const staleUse = button(b.render(), 'Use Mac voice'); b.unmount();
  staleUse.props.onClick(event()); assert.equal(f.toggles.length, 0);
  const c = f.response('C'), pendingC = read(c.render()).props.onClick(event());
  c.unmount(); f.jobs[2].reject(new Error('Local read-aloud worker stopped.')); await pendingC;
  assert.equal(f.toggles.length, 0); assert.equal(f.alerts.length, 0); assert.equal(f.saves.length, 0);
  a.unmount();
});

test('invalid voice metadata and protocol/trust failures do not offer or start native speech', async () => {
  const invalid = [undefined, null, [], {}, { selectedVoice: '' }, { selectedVoice: 'unknown' },
    { selectedVoice: 'af_missing', voices: [{ id: 'af_aoede' }] },
    { selectedVoice: null, voices: {} }, { selectedVoice: null, engine: 'native' },
    { selectedVoice: 'af_aoede', speed: 2 }];
  for (const value of invalid) {
    const f = fixture(), response = f.response('Do not start.');
    const pending = read(response.render()).props.onClick(event());
    f.jobs[0].resolve(value); await pending;
    assert.equal(hasNativeOffer(response.render()), false);
    assert.equal(f.toggles.length, 0); assert.equal(f.saves.length, 0);
    assert.deepEqual(f.alerts, ['Could not load local voices. Please try again.']); response.unmount();
  }
  for (const message of ['Local read-aloud worker sent an invalid response.',
    'Read-aloud request is not allowed from this frame.', 'Invalid read-aloud request.', '/private/arbitrary/error']) {
    const f = fixture(), response = f.response('Do not start.');
    const pending = read(response.render()).props.onClick(event()); f.jobs[0].reject(new Error(message)); await pending;
    assert.equal(hasNativeOffer(response.render()), false); assert.equal(f.toggles.length, 0);
    assert.deepEqual(f.alerts, ['Could not load local voices. Please try again.']); response.unmount();
  }
});

test('missing lookup bridge offers explicit native speech and opening the picker discards a held offer', async () => {
  const f = fixture(), response = f.response('Held response.'); f.bridge.getVoices = undefined;
  await read(response.render()).props.onClick(event());
  assert.equal(hasNativeOffer(response.render()), true); assert.equal(f.jobs.length, 0);
  settings(response.render()).props.onClick(event());
  assert.equal(hasNativeOffer(response.render()), false);
  picker(response.render()).props.onChosen({ selectedVoice: 'af_aoede' });
  assert.equal(f.toggles.length, 0, 'choosing a voice later must not resurrect the failed read');
  assert.equal(f.saves.length, 0); response.unmount();
});

test('fixed startup/runtime failure messages offer explicit Mac speech without exposing diagnostics', async () => {
  for (const message of ['Local read-aloud is unavailable.', 'Unable to start local read-aloud worker.',
    'Local read-aloud worker timed out.', 'Unable to generate local read-aloud audio.']) {
    const f = fixture(), response = f.response('Before.\n```js\nskipCode();\n```\nAfter.');
    const pending = read(response.render()).props.onClick(event());
    f.jobs[0].reject(new Error(message)); await pending;
    const tree = response.render();
    assert.equal(hasNativeOffer(tree), true); assert.equal(f.toggles.length, 0);
    assert.equal(find(tree, node => node.props.role === 'alert').props.children[0].props.children,
      'Local speech is unavailable.');
    button(tree, 'Use Mac voice').props.onClick(event());
    assert.equal(f.toggles[0].text, 'Before.\n\nAfter.');
    assert.equal(f.toggles[0].options.mode, 'native');
    assert.equal(f.saves.length, 0); assert.equal(f.alerts.length, 0); response.unmount();
  }
});

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
