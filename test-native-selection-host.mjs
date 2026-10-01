// Actual pinned host J4e/G4e/q4e/c3e/i3e, patched in memory, on offline DOM.
// Geometry, text serialization, React primitives, and the owner registry are
// controlled dependencies. These tests do not launch or modify the desktop app.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { before, after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const speechSource = ['speech-controller.mjs', 'kokoro-response-speaker.mjs', 'response-highlight.mjs', 'response-button.js']
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
for name in ['codexReadAloudSelectionOwner','J4e','Y4e','X4e','G4e','q4e','c3e','i3e']:
    start=source.index('function '+name+'(')
    following=re.search(r'function [A-Za-z_$][\w$]*\(',source[start+9:])
    if following is None: raise ValueError('Cannot delimit '+name)
    function=source[start:start+9+following.start()]
    # The menu functions end immediately before their module's declarations.
    function=function.split('var GG,KG,qG;')[0].split('var a3e,HG,UG;')[0]
    functions.append(function)
print(json.dumps({'sha256':digest,'source':'\n'.join(functions)}))
`], { cwd: new URL('.', import.meta.url), encoding: 'utf8' }));

let browser;
before(async () => { browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' }); });
after(async () => { await browser?.close(); });

async function fixture(markup, run, actualSpeech = false) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  try {
    await page.setContent(markup);
    await page.evaluate(({ source, speechSource }) => {
      window.PG = node => node instanceof Element ? node : node?.parentElement;
      window.QNe = range => range.toString();
      window.K4e = () => ({ rect: new DOMRect(10, 20, 30, 40) });
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
        Object.assign(window.fixture, {
          starts, alerts,
          mount(root, options = {}) {
            hooks = { index: 0, slots: [], effects: [] };
            window.actualReadController({ getRoot: () => root, getText: () => 'UNUSED fallback', getHtml: () => '<p>UNUSED fallback</p>', selectionOnly: true, ...options });
            const cleanups = hooks.effects.map(callback => callback());
            return () => cleanups.forEach(cleanup => cleanup?.());
          },
          async tick() { for (let index = 0; index < 12; index++) await Promise.resolve(); },
        });
      }
    }, { source: host.source, speechSource: actualSpeech ? speechSource : null });
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
