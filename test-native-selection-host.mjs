// Actual pinned host J4e/G4e/q4e/c3e/i3e, patched in memory, on offline DOM.
// Real host geometry runs in the browser; text serialization, React primitives,
// and markdown rendering are controlled dependencies. These tests do not launch or modify the desktop app.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { before, after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const speechSource = ['speech-controller.mjs', 'kokoro-response-speaker.mjs', 'response-highlight.mjs', 'response-button.js']
  .map(name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^export /gm, '')).join('\n');
const groupSource = ['voice-response-groups.mjs', 'voice-response-group-host.js']
  .map(name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^export /gm, '')).join('\n');
const host = JSON.parse(execFileSync('python3', ['-B', '-c', String.raw`
import hashlib,json,os,re,struct
from pathlib import Path
from selection_host_adapter import HOST_ASSET,HOST_SHA256,patch_selection_menu
path=Path(os.environ.get('CHATGPT_HOST_ASAR','/Applications/ChatGPT.app/Contents/Resources/app.asar'))
with path.open('rb') as stream:
    prelude=struct.unpack('<4I',stream.read(16))
    tree=json.loads(stream.read(prelude[3])); entry=tree
    for part in HOST_ASSET.split('/'): entry=entry['files'][part]
    stream.seek(8+prelude[1]+int(entry['offset'])); raw=stream.read(entry['size'])
digest=hashlib.sha256(raw).hexdigest()
if digest != HOST_SHA256: raise ValueError('Official selection fixture changed: '+digest)
source=patch_selection_menu(raw.decode())
functions=[]
for name in ['codexReadAloudSelectionOwner','J4e','Y4e','X4e','G4e','q4e','c3e','i3e','K4e','Q4e','Z4e','FG','IG']:
    start=source.index('function '+name+'(')
    following=re.search(r'function [A-Za-z_$][\w$]*\(',source[start+9:])
    if following is None: raise ValueError('Cannot delimit '+name)
    function=source[start:start+9+following.start()]
    # The menu functions end immediately before their module's declarations.
    function=function.split('var GG,KG,qG;')[0].split('var a3e,HG,UG;')[0].split('var LG;')[0]
    functions.append(function)
from test_speech_host_adapter import SpeechHostTests
voice,_=SpeechHostTests().actual_host_inputs()
print(json.dumps({'sha256':digest,'source':'\n'.join(functions),'voiceSource':voice['Ik']+voice['Ek']}))
`], { cwd: new URL('.', import.meta.url), encoding: 'utf8' }));

let browser;
before(async () => { browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' }); });
after(async () => { await browser?.close(); });

async function fixture(markup, run, actualSpeech = false) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  try {
    await page.setContent(markup);
    await page.evaluate(({ source, speechSource, groupSource, partialSetupSource, voiceSource }) => {
      window.eval('window.partialResearchSetup=' + partialSetupSource);
      window.PG = node => node instanceof Element ? node : node?.parentElement;
      window.QNe = range => range.toString();
      window.LG = new Set(['auto', 'clip', 'hidden', 'overlay', 'scroll']);
      window.bTe = 'data-selected-text-overlay-target';
      const cache = { c: size => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) };
      window.GG = window.a3e = cache;
      window.qG = window.UG = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      window.HG = { useState: value => [value, () => {}] };
      window.Gm = () => 1;
      window.Xf = () => ({ formatMessage: message => message.defaultMessage });
      window.$4e = 'native-selection-observer';
      window.lje = 'menu'; window.HT = 'button'; window.X = 'translation';
      const annotations = [], calls = [], reads = [];
      window.WCe = (target, range, text) => {
        // An artificial group must never reach native annotation routing.
        if (!target.hasAttribute('data-selected-text-overlay-target')) throw new Error('Misrouted annotation target');
        const annotation = { target: target.id, range: range.toString(), text };
        annotations.push(annotation); return annotation;
      };
      window.codexCanReadSelectionAloud = (root, range) => !!(root?.isConnected && range && !range.collapsed && root.contains(range.startContainer) && root.contains(range.endContainer));
      window.codexReadSelectionAloud = (root, range) => {
        if (window.codexCanReadSelectionAloud(root, range)) reads.push({ root: root.id, text: range.toString() });
      };
      window.eval(source + '\nwindow.nativeSelectionHost={J4e,G4e,q4e,c3e,i3e};');
      const h = window.nativeSelectionHost;
      const selector = '[data-selected-text-overlay-target]';
      window.fixture = {
        annotations, calls, reads,
        register(root) { window.codexResolveReadAloudSelection = () => ({ root }); },
        select(startNode, startOffset, endNode, endOffset, backward = false) {
          const selection = getSelection(); selection.removeAllRanges();
          selection.setBaseAndExtent(backward ? endNode : startNode, backward ? endOffset : startOffset,
            backward ? startNode : endNode, backward ? startOffset : endOffset);
          return selection.getRangeAt(0).cloneRange();
        },
        resolve() { const selection = getSelection(); return h.J4e(selection, selection.getRangeAt(0), selector); },
        snapshot(container = document.body) { return h.G4e({ targetSelector: selector, targetContainer: container, windowZoom: 1 }); },
        menu(snapshot, nativeCallbacks = true) {
          if (snapshot === null) return null;
          const callbacks = nativeCallbacks ? {
            onAddResponseTextAnnotation: (annotation, position, resume) => calls.push({ action: 'add', annotation }),
            onOpenQuickChat: (text, target) => calls.push({ action: 'details', text, target: target.id }),
            onOpenSideChat: text => calls.push({ action: 'side', text }),
          } : {};
          const observer = h.c3e({ ...callbacks, targetContainerRefs: [], targetSelector: selector });
          if (observer == null) return null;
          const layer = observer.props.children(snapshot, () => 'resume');
          if (layer == null) return null;
          const props = layer.props.children.props;
          const menu = h.i3e(props);
          const buttons = menu.props.children.filter(Boolean);
          const label = button => typeof button.props.children === 'string' ? button.props.children : button.props.children.props.defaultMessage;
          return { props, buttons, labels: buttons.map(label), click(labelText) {
            buttons.find(button => label(button) === labelText).props.onClick({ stopPropagation() {}, preventDefault() {} });
          } };
        },
        equal: h.q4e,
      };
      if (speechSource) {
        let hooks;
        const starts = [], alerts = [];
        const react = {
          useState(value) { const index = hooks.index++, state = hooks; if (!(index in state.slots)) state.slots[index] = value; return [state.slots[index], next => { state.slots[index] = next; }]; },
          useRef(value) { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = { current: value }; return hooks.slots[index]; },
          useEffect(callback) { hooks.effects.push(callback); },
        };
        window.Fo = () => react;
        window.Y = { ...window.UG, Fragment: Symbol('fragment') };
        window.Dr = 'button'; window.qi = 'tooltip';
        window.alert = message => alerts.push(message);
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { cancel() {}, getVoices() { return []; } } });
        Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined });
        window.codexLocalReadAloud = {
          getVoices: async () => ({ selectedVoice: 'af_aoede' }),
          start(id, text, options) { starts.push({ id, text, options }); return new Promise(() => {}); },
          next: async () => ({ done: true }),
          cancel: async () => ({ done: true }), onInterrupted: () => () => {},
        };
        window.eval(speechSource + '\nwindow.actualReadController=CodexLocalReadAloudButton;');
        window.fA = window.Y; window.dA = { useRef: value => ({ current: value }) }; window.iA = 'voice-child';
        window.CodexLocalReadAloudButton = window.actualReadController;
        window.eval(groupSource + '\nwindow.actualVoiceReadGroup=CodexVoiceReadGroup;window.actualGroupVoiceResponses=codexGroupVoiceResponses;');
        window.Y = Object.assign(() => undefined, window.Y); window.Lk = window.Mk = cache;
        window.Rk = window.Nk = window.UG; window.wn = window.D = window.C = null;
        window.Kv = 'assistant'; window.Uy = 'user'; window.Vy = 'speaker';
        window.tm = (turn, part) => `${turn}:${part}`; window.kn = () => []; window.Dk = () => false;
        window.eval(voiceSource + '\nwindow.actualVoiceTranscript=Ik;window.actualVoiceResearch=Ek;');
        Object.assign(window.fixture, {
          starts, alerts,
          mount(root, options = {}) {
            hooks = { index: 0, slots: [], effects: [] };
            window.actualReadController({ getRoot: () => root, getText: () => 'UNUSED fallback', getHtml: () => '<p>UNUSED fallback</p>', selectionOnly: true, ...options });
            const cleanups = hooks.effects.map(callback => callback());
            return () => cleanups.forEach(cleanup => cleanup?.());
          },
          mountGroup(root, entry) {
            const tree = window.actualVoiceReadGroup({ entry });
            tree.props.ref.current = root;
            const controller = tree.props.children[1];
            return controller ? { unmount: window.fixture.mount(root, controller.props), props: controller.props }
              : { unmount() {}, props: { selectionOnly: true, renderContent: () => null } };
          },
          async tick() { for (let index = 0; index < 12; index++) await Promise.resolve(); },
        });
      }
    }, { source: host.source, speechSource: actualSpeech ? speechSource : null, groupSource, partialSetupSource, voiceSource: host.voiceSource });
    return await page.evaluate(run);
  } finally { await context.close(); }
}

const parts = '<section id="answer"><div id="a" data-selected-text-overlay-target="a"><p>First paragraph.</p></div><div id="b" data-selected-text-overlay-target="b"><p>Second paragraph.</p></div></section>';

test('pinned original host asset is the source of the executed functions', () => {
  assert.equal(host.sha256, '4ecf05d89f80080ce52ee7f99d80b8c2fddcdc66744684649369c65683e09f17');
});

test('single native target preserves annotation, details, side-chat and exact speech range', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a'), text = a.querySelector('p').firstChild;
    f.register(a); const selected = f.select(text, 2, text, 10).toString();
    const snapshot = f.snapshot(), menu = f.menu(snapshot);
    for (const label of menu.labels) menu.click(label);
    return { selected, labels: menu.labels, calls: f.calls, reads: f.reads, annotations: f.annotations };
  });
  assert.deepEqual(value.labels, ['Add to chat', 'More details', 'Ask in side chat', 'Read aloud']);
  assert.deepEqual(value.annotations, [{ target: 'a', range: value.selected, text: value.selected }]);
  assert.deepEqual(value.calls.map(call => call.action), ['add', 'details', 'side']);
  assert.equal(value.calls[1].target, 'a');
  assert.deepEqual(value.reads, [{ root: 'a', text: value.selected }]);
});

test('cross-part range uses only an explicit owner, stays exact, and exposes speech alone', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a p').firstChild, b = document.querySelector('#b p').firstChild;
    f.register(root); const original = f.select(a, 6, b, 6);
    const snapshot = f.snapshot(), menu = f.menu(snapshot);
    getSelection().removeAllRanges(); menu.click('Read aloud');
    return { text: original.toString(), target: snapshot.target.id, speechOnly: snapshot.codexReadAloudOnly,
      exact: snapshot.codexReadAloudRange.startContainer === a && snapshot.codexReadAloudRange.startOffset === 6 && snapshot.codexReadAloudRange.endContainer === b && snapshot.codexReadAloudRange.endOffset === 6,
      labels: menu.labels, annotations: f.annotations, calls: f.calls, reads: f.reads };
  });
  assert.equal(value.target, 'answer'); assert.equal(value.speechOnly, true); assert.equal(value.exact, true);
  assert.deepEqual(value.labels, ['Read aloud']); assert.deepEqual(value.annotations, []); assert.deepEqual(value.calls, []);
  assert.deepEqual(value.reads, [{ root: 'answer', text: value.text }]);
});

test('backward cross-part selection retains the same ordered exact range', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a p').firstChild, b = document.querySelector('#b p').firstChild;
    f.register(root); const forward = f.select(a, 3, b, 7).toString();
    f.select(a, 3, b, 7, true); const snapshot = f.snapshot();
    return { forward, backward: snapshot.codexReadAloudRange.toString(), target: snapshot.target.id };
  });
  assert.equal(value.forward, value.backward); assert.equal(value.target, 'answer');
});

test('DOM ancestry alone and registry denial cannot join separate native targets', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a p').firstChild, b = document.querySelector('#b p').firstChild;
    f.select(a, 0, b, 6); delete window.codexResolveReadAloudSelection;
    const absent = f.resolve(); window.codexResolveReadAloudSelection = () => null;
    return { absent, denied: f.resolve() };
  });
  assert.deepEqual(value, { absent: null, denied: null });
});

test('malformed, throwing, detached or wrong owner resolvers fail closed', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a p').firstChild, b = document.querySelector('#b p').firstChild;
    f.select(a, 0, b, 6);
    const results = [];
    for (const resolver of [() => { throw Error('Registry unavailable'); }, () => ({}), () => ({ root: document.createElement('section') }), () => ({ root: document.querySelector('#a') })]) {
      window.codexResolveReadAloudSelection = resolver; results.push(f.resolve());
    }
    return results;
  });
  assert.deepEqual(value, [null, null, null, null]);
});

test('native clipping never substitutes a partial range for speech', async () => {
  const value = await fixture('<p id="outside">Foreign prompt.</p>' + parts, () => {
    const f = fixture, outside = document.querySelector('#outside').firstChild, a = document.querySelector('#a p').firstChild;
    f.register(document.querySelector('#a'));
    f.select(outside, 1, a, 5); const first = f.snapshot(), menu = f.menu(first);
    f.select(outside, 4, a, 5); const second = f.snapshot();
    return { nativeText: first.selectionRange.toString(), exactText: first.codexReadAloudRange.toString(),
      nativeUnchanged: first.selectionRange.toString() === second.selectionRange.toString(), equal: f.equal(first, second),
      exactStart: first.codexReadAloudRange.startContainer === outside, speechRoot: first.codexReadAloudRoot, labels: menu.labels };
  });
  assert.equal(value.nativeText, 'First'); assert.notEqual(value.nativeText, value.exactText);
  assert.equal(value.nativeUnchanged, true); assert.equal(value.equal, false); assert.equal(value.exactStart, true); assert.equal(value.speechRoot, null);
  assert.deepEqual(value.labels, ['Add to chat', 'More details', 'Ask in side chat']);
});

test('single target can show speech with all native callbacks absent', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a'); f.register(a);
    f.select(a.querySelector('p').firstChild, 0, a.querySelector('p').firstChild, 5);
    const snapshot = f.snapshot(), menu = f.menu(snapshot, false);
    menu.click('Read aloud'); delete window.codexResolveReadAloudSelection;
    return { labels: menu.labels, reads: f.reads, withoutRegistry: f.menu(snapshot, false) };
  });
  assert.deepEqual(value, { labels: ['Read aloud'], reads: [{ root: 'a', text: 'First' }], withoutRegistry: null });
});

test('a contenteditable endpoint cannot be widened through an otherwise valid owner', async () => {
  const value = await fixture(parts.replace('<p>Second', '<p contenteditable="true">Second'), () => {
    const f = fixture; f.register(document.querySelector('#answer'));
    const a = document.querySelector('#a p').firstChild, b = document.querySelector('#b p').firstChild;
    f.select(a, 0, b, 6); return f.resolve();
  });
  assert.equal(value, null);
});

test('table cells and list items remain eligible inside one registered target', async () => {
  const value = await fixture('<div id="a" data-selected-text-overlay-target="a"><table><tbody><tr><td>Cell text.</td></tr></tbody></table><ul><li>List text.</li></ul></div>', () => {
    const f = fixture, root = document.querySelector('#a'); f.register(root);
    const a = root.querySelector('td').firstChild, b = root.querySelector('li').firstChild;
    const text = f.select(a, 0, b, b.length).toString(), menu = f.menu(f.snapshot()); menu.click('Read aloud');
    return { text, labels: menu.labels, reads: f.reads };
  });
  assert.ok(value.labels.includes('Read aloud')); assert.deepEqual(value.reads, [{ root: 'a', text: value.text }]);
});

test('owner outside the native observer container cannot produce a popover', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b'); f.register(document.querySelector('#answer'));
    f.select(a.querySelector('p').firstChild, 0, b.querySelector('p').firstChild, 6); return f.snapshot(a);
  });
  assert.equal(value, null);
});

test('real hidden commentary controller registers through the native host menu and speaks exact DOM text', async () => {
  const value = await fixture('<div id="commentary" data-selected-text-overlay-target="commentary"><p>Ordinary <strong>progress prose</strong> remains selectable.</p></div>', async () => {
    const f = fixture, root = document.querySelector('#commentary'), text = root.querySelector('strong').firstChild;
    f.mount(root); f.select(text, 0, text, text.length);
    const menu = f.menu(f.snapshot(), false); getSelection().removeAllRanges(); menu.click('Read aloud'); await f.tick();
    return { labels: menu.labels, texts: f.starts.map(request => request.text), alerts: f.alerts };
  }, true);
  assert.deepEqual(value, { labels: ['Read aloud'], texts: ['progress prose'], alerts: [] });
});

test('real registered group routes exact cross-part selection through native host without native callbacks', async () => {
  const value = await fixture(parts, async () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a'), b = document.querySelector('#b');
    f.mount(a); f.mount(b); f.mount(root, { getTextRoots: () => [a, b] });
    f.select(a.querySelector('p').firstChild, 6, b.querySelector('p').firstChild, 6);
    const snapshot = f.snapshot(), menu = f.menu(snapshot); menu.click('Read aloud'); await f.tick();
    return { labels: menu.labels, root: snapshot.target.id, texts: f.starts.map(request => request.text), annotations: f.annotations, calls: f.calls, alerts: f.alerts };
  }, true);
  assert.deepEqual(value, { labels: ['Read aloud'], root: 'answer', texts: ['paragraph.\n\nSecond'], annotations: [], calls: [], alerts: [] });
});

test('real independent controllers do not acquire a cross-answer owner from their shared wrapper', async () => {
  const value = await fixture(parts, () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b'); f.mount(a); f.mount(b);
    f.select(a.querySelector('p').firstChild, 6, b.querySelector('p').firstChild, 6); return f.snapshot();
  }, true);
  assert.equal(value, null);
});

test('real group can cross reviewed excluded status text without speaking the event', async () => {
  const markup = parts.replace('<div id="b"', '<aside data-markdown-copy="exclude">Worker finished</aside><div id="b"');
  const value = await fixture(markup, async () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a'), b = document.querySelector('#b');
    f.mount(root, { getTextRoots: () => [a, b] });
    f.select(a.querySelector('p').firstChild, 6, b.querySelector('p').firstChild, 6);
    const snapshot = f.snapshot(), menu = f.menu(snapshot); menu.click('Read aloud'); await f.tick();
    return { selected: snapshot.codexReadAloudRange.toString(), texts: f.starts.map(request => request.text), alerts: f.alerts };
  }, true);
  assert.ok(value.selected.includes('Worker finished'));
  assert.deepEqual(value.texts, ['paragraph.\n\nSecond']); assert.deepEqual(value.alerts, []);
});

test('real group refuses unowned prose between otherwise approved endpoints', async () => {
  const markup = parts.replace('<div id="b"', '<aside>User interjection.</aside><div id="b"');
  const value = await fixture(markup, () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a'), b = document.querySelector('#b');
    f.mount(root, { getTextRoots: () => [a, b] });
    f.select(a.querySelector('p').firstChild, 6, b.querySelector('p').firstChild, 6); return f.snapshot();
  }, true);
  assert.equal(value, null);
});

test('real registry rejects speech for a host-clipped range while native callbacks retain their original clipping', async () => {
  const value = await fixture('<p id="outside">Foreign prompt.</p>' + parts, () => {
    const f = fixture, a = document.querySelector('#a'); f.mount(a);
    f.select(document.querySelector('#outside').firstChild, 2, a.querySelector('p').firstChild, 5);
    const snapshot = f.snapshot(), menu = f.menu(snapshot);
    return { nativeText: snapshot.selectionRange.toString(), labels: menu.labels, speechOnlyMenu: f.menu(snapshot, false) };
  }, true);
  assert.deepEqual(value, { nativeText: 'First', labels: ['Add to chat', 'More details', 'Ask in side chat'], speechOnlyMenu: null });
});

test('real native menu click rechecks registered ownership after the selected group detaches', async () => {
  const value = await fixture(parts, async () => {
    const f = fixture, root = document.querySelector('#answer'), a = document.querySelector('#a'), b = document.querySelector('#b');
    f.mount(root, { getTextRoots: () => [a, b] });
    f.select(a.querySelector('p').firstChild, 6, b.querySelector('p').firstChild, 6);
    const menu = f.menu(f.snapshot()); root.remove(); menu.click('Read aloud'); await f.tick();
    return { starts: f.starts, alerts: f.alerts };
  }, true);
  assert.deepEqual(value, { starts: [], alerts: [] });
});


// The screenshot crosses an Ik transcript and an Ek promoted markdown block.
// Exercise their real group host + controller + native J4e popup pipeline while
// the canonical page starts mid-answer. This previously lacked a group owner.
const partialResearchMarkup = `<section id="voice-answer">
  <div data-codex-read-aloud-part="transcript:intro" data-codex-read-aloud-part-state="complete"><div id="intro" data-selected-text-overlay-target="intro"><p>So, one thing to note from Sparkle: updates install a replacement app bundle.</p></div></div>
  <div data-codex-local-read-aloud="group-auxiliary">Update compatibility research finished</div>
  <div data-codex-read-aloud-part="presentation:research" data-codex-read-aloud-part-state="complete"><div id="research" data-selected-text-overlay-target="research"><h2>Research: keeping Read Aloud working through updates</h2><p>The right design is to check compatibility.</p><h3>What the research established</h3><p>Unselected following prose.</p></div></div>
</section>`;

async function partialResearchSetup() {
  const f = fixture, root = document.querySelector('#voice-answer');
  const intro = { id: 'intro', role: 'assistant', text: document.querySelector('#intro').textContent, completed: true };
  const entries = [{ type: 'voice-transcript', conversationId: 'thread', hostId: 'host', turnKey: 'intro',
    block: { canonical: true, type: 'tail', entries: [intro] } },
    { type: 'voice-presentation', conversationId: 'thread', hostId: 'host', turnKey: 'research', presentation: {
      type: 'inline-markdown', presentationId: 'research', content: document.querySelector('#research').textContent, completed: true } }];
  const rt = item => ({ type: 'realtime', item: { realtimeSessionId: 'session', ...item } });
  const timeline = { activeRealtimeSessionAtPageStart: 'session', entries: [rt({ type: 'transcriptSegment', ...intro }),
    rt({ type: 'bemItemPromoted', id: 'research', presentation: { type: 'inlineMarkdown' } }), rt({ type: 'realtimeSessionClosed' })] };
  const mode = root.dataset.mode;
  if (mode === 'active work' || mode === 'unresolved research') {
    entries.push(mode === 'active work' ? { turnKey: 'work', voiceWorkActivity: 'active' } :
      { type: 'voice-presentation', turnKey: 'pending', presentation: { type: 'pending-artifact' } });
    timeline.activeRealtimeSessionAtPageStart = null;
    timeline.entries.unshift(rt({ type: 'realtimeSessionStarted' }));
  } else if (mode === 'pending prose after selection') {
    const pending = { id: 'pending', role: 'assistant', text: 'Unfinished following prose.', completed: false };
    entries.push({ ...entries[0], turnKey: 'pending', block: { canonical: true, type: 'tail', entries: [pending] } });
    timeline.entries.splice(-1, 0, rt({ type: 'transcriptSegment', ...pending }));
  }
  const entry = actualGroupVoiceResponses(entries, timeline)[0];
  // Metadata comes from the actual pinned Ik/Ek wrappers, not hand-invented
  // ownership markers. Native markdown contents are controlled fixture prose.
  for (const child of entry.block.codexReadAloudGroup.children) {
    if (child.type !== 'voice-transcript' && child.presentation?.type !== 'inline-markdown') continue;
    const props = child.type === 'voice-transcript'
      ? actualVoiceTranscript({ canonical: true, entry: child.block.entries[0], conversationId: 'thread' }).props
      : actualVoiceResearch({ presentation: child.presentation, conversationId: 'thread' }).props;
    const part = root.querySelector(`[data-codex-read-aloud-part="${props['data-codex-read-aloud-part']}"]`);
    for (const [name, value] of Object.entries(props)) if (name.startsWith('data-') && value !== undefined) part.setAttribute(name, value);
  }
  f.mount(document.querySelector('#intro')); f.mount(document.querySelector('#research'));
  const group = f.mountGroup(root, entry);
  return { entry, group, root };
}

// Serialize the setup because browser fixtures run in isolated contexts.
const partialSetupSource = partialResearchSetup.toString();

test('partial canonical voice page offers Read aloud across transcript and research headings without an idle footer', async () => {
  const value = await fixture(partialResearchMarkup, async () => {
    const setup = await window.partialResearchSetup(), f = fixture;
    const a = document.querySelector('#intro p').firstChild, b = document.querySelector('#research h3').firstChild;
    f.select(a, 0, a, a.length);
    const small = f.menu(f.snapshot()).labels;
    const range = f.select(a, 0, b, b.length), native = range.toString(), visibleSelection = getSelection().toString();
    const wideSnapshot = f.snapshot(), wide = f.menu(wideSnapshot);
    wide?.click('Read aloud'); await f.tick();
    return { completed: setup.entry.block.codexReadAloudGroup.completed, selectionOnly: setup.group.props.selectionOnly,
      idleFooter: setup.group.props.renderContent('controls'), small, wide: wide?.labels ?? null, spoken: f.starts[0]?.text,
      exactRange: wideSnapshot?.codexReadAloudRange.toString() === native, nativeUnchanged: getSelection().toString() === visibleSelection && getSelection().getRangeAt(0).startContainer === a && getSelection().getRangeAt(0).startOffset === 0 && getSelection().getRangeAt(0).endContainer === b && getSelection().getRangeAt(0).endOffset === b.length };
  }, true);
  assert.equal(value.completed, false); assert.equal(value.selectionOnly, true); assert.equal(value.idleFooter, null);
  assert.deepEqual(value.small, ['Add to chat', 'More details', 'Ask in side chat', 'Read aloud']);
  assert.deepEqual(value.wide, ['Read aloud']);
  assert.equal(value.spoken, 'So, one thing to note from Sparkle: updates install a replacement app bundle.\n\nResearch: keeping Read Aloud working through updates\n\nThe right design is to check compatibility.\n\nWhat the research established');
  assert.equal(value.exactRange, true); assert.equal(value.nativeUnchanged, true);
});

for (const mode of ['active work', 'unresolved research', 'pending prose after selection']) {
  test(`completed neighboring passages remain selectable with ${mode}`, async () => {
    const pending = '<div data-codex-read-aloud-part="transcript:pending"><div data-selected-text-overlay-target="pending">Unfinished following prose.</div></div>';
    const markup = partialResearchMarkup.replace('<section id="voice-answer">', `<section id="voice-answer" data-mode="${mode}">`)
      .replace('</section>', (mode === 'pending prose after selection' ? pending : '') + '</section>');
    const value = await fixture(markup, async () => {
      const setup = await window.partialResearchSetup(), f = fixture;
      const a = document.querySelector('#intro p').firstChild, b = document.querySelector('#research h3').firstChild;
      f.select(a, 0, b, b.length);
      const menu = f.menu(f.snapshot(setup.root)); menu.click('Read aloud'); await f.tick();
      return { completed: setup.entry.block.codexReadAloudGroup.completed, footer: setup.group.props.renderContent('controls'),
        labels: menu.labels, spoken: f.starts[0]?.text };
    }, true);
    assert.equal(value.completed, false); assert.equal(value.footer, null); assert.deepEqual(value.labels, ['Read aloud']);
    assert.match(value.spoken, /^So, one thing to note/); assert.match(value.spoken, /What the research established$/);
    assert.ok(!value.spoken.includes('Unfinished'));
  });
}

for (const failure of ['unowned prose', 'pending part', 'foreign owner', 'missing part']) {
  test(`partial voice selection rejects ${failure} without falling back to clipped text`, async () => {
    const value = await fixture(partialResearchMarkup.replace('<section id="voice-answer">', `<section id="voice-answer" data-failure="${failure}">`), async () => {
      const setup = await window.partialResearchSetup(), f = fixture, failure = setup.root.dataset.failure;
      const parts = setup.root.querySelectorAll('[data-codex-read-aloud-part]');
      if (failure === 'unowned prose') {
        const foreign = document.createElement('p'); foreign.textContent = 'A separate user answer.'; parts[0].after(foreign);
      } else if (failure === 'pending part') parts[1].setAttribute('data-codex-read-aloud-part-state', 'pending');
      else if (failure === 'foreign owner') parts[1].setAttribute('data-codex-read-aloud-owner', 'different-answer');
      else parts[1].removeAttribute('data-codex-read-aloud-part');
      f.select(document.querySelector('#intro p').firstChild, 0, document.querySelector('#research h3').firstChild, 8);
      return { snapshot: f.snapshot(), starts: f.starts.length };
    }, true);
    assert.deepEqual(value, { snapshot: null, starts: 0 });
  });
}

for (const mode of ['visible', 'partly-scrolled', 'wholly-offscreen', 'narrow-visible']) {
  test(`real host selection geometry ${mode}`, async () => {
    const markup = `<body data-mode="${mode}"><style>
      #thread { width:680px; height:200px; overflow:auto; margin:20px }
      #voice-answer { padding:5px } h2 { font-size:24px } h3 { font-size:20px }
      </style><div id="thread"><div style="height:120px"></div>${partialResearchMarkup}
      <div style="height:600px"></div></div>`;
    const value = await fixture(markup, async () => {
      const f = fixture;
      await window.partialResearchSetup();
      const thread = document.querySelector('#thread'), mode = document.body.dataset.mode;
      if (mode === 'narrow-visible') { thread.style.width = '320px'; thread.style.height = '420px'; }
      thread.scrollTop = mode === 'wholly-offscreen' ? 700 : mode === 'partly-scrolled' ? 170 : 70;
      const a = document.querySelector('#intro p').firstChild, b = document.querySelector('#research h3').firstChild;
      f.select(a, 0, b, b.length);
      const snapshot = f.snapshot(thread), menu = snapshot ? f.menu(snapshot) : null;
      if (menu) { menu.click('Read aloud'); await f.tick(); }
      return { snapshot: snapshot !== null, labels: menu?.labels ?? [], spoken: f.starts[0]?.text,
        rect: snapshot ? { top: snapshot.rect.top, bottom: snapshot.rect.bottom } : null,
        bounds: { top: thread.getBoundingClientRect().top, bottom: thread.getBoundingClientRect().bottom } };
    }, true);
    if (mode === 'wholly-offscreen') assert.equal(value.snapshot, false);
    else {
      assert.equal(value.snapshot, true); assert.deepEqual(value.labels, ['Read aloud']);
      assert.match(value.spoken, /Research: keeping Read Aloud/);
      assert.ok(value.rect.top >= value.bounds.top && value.rect.bottom <= value.bounds.bottom);
    }
  });
}
