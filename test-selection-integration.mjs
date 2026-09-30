// Actual component + manager + helper on a fresh offline synthetic browser.
// Fake JSX/hooks preserve event/effect/state wiring; no installed-app control.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { before, after, test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const sources = ['speech-controller.mjs', 'kokoro-response-speaker.mjs', 'response-highlight.mjs', 'response-button.js']
  .map(name => read(name).replace(/^export /gm, '')).join('\n');
const selectionButton = JSON.parse(execFileSync('python3', ['-B', '-c',
  'import ast,json,pathlib; t=ast.parse(pathlib.Path("build_copy.py").read_text()); print(json.dumps(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=="SELECTION_BUTTON" for x in n.targets))))'],
  { cwd: new URL('.', import.meta.url), encoding: 'utf8' }));
let browser;
before(async () => { browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' }); });
after(async () => { await browser?.close(); });

async function isolated(markup, run) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  try {
    await page.setContent(markup);
    await page.evaluate(({ source, menu }) => {
      const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
      let hooks;
      const starts = [], nexts = [], cancels = [], audios = [], alerts = [], voiceJobs = [], voiceChecks = [];
      let interruption, holdVoices = false;
      const react = {
        useState(initial) { const index = hooks.index++, state = hooks; if (!(index in state.slots)) state.slots[index] = initial; return [state.slots[index], value => { state.slots[index] = value; }]; },
        useRef(initial) { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
        useEffect(callback) { const index = hooks.index++; if (!hooks.effects.has(index)) { hooks.effects.set(index, callback); hooks.pending.push(index); } },
      };
      window.Fo = () => react;
      window.Y = window.UG = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment') };
      window.Dr = window.HT = 'button'; window.qi = 'tooltip';
      window.CodexReadAloudVoicePicker = () => {};
      window.alert = message => alerts.push(message);
      window.speechSynthesis = { cancel() {}, getVoices() { return []; }, speak() { throw new Error('Unexpected Apple fallback'); } };
      window.SpeechSynthesisUtterance = undefined;
      window.Audio = class {
        constructor(src) { this.src = src; this.started = deferred(); this.paused = false; this.disposed = false; audios.push(this); }
        play() { return this.started.promise; }
        pause() { this.paused = true; }
        removeAttribute() { this.src = ''; }
        load() {}
        playing() { this.onplaying?.(); this.started.resolve(); }
        ended() { this.onended?.(); }
      };
      window.codexLocalReadAloud = {
        getVoices() { voiceChecks.push(true); if (!holdVoices) return Promise.resolve({ selectedVoice: 'af_aoede' }); const job = deferred(); voiceJobs.push(job); return job.promise; },
        start(id, text, options) { const job = { id, text, options, ...deferred() }; starts.push(job); return job.promise; },
        next(id) { const job = { id, ...deferred() }; nexts.push(job); return job.promise; },
        cancel(id) { cancels.push(id); return Promise.resolve({ done: true }); },
        onInterrupted(callback) { interruption = callback; return () => { interruption = null; }; },
      };
      window.eval(source + '\nwindow.__actualComponent=CodexLocalReadAloudButton;');
      const makeMenu = new Function('codexSelectionRoot', 'codexSelectionRange', 'return (' + menu + ')');
      function treeNode(tree) {
        if (tree == null || typeof tree === 'boolean') return null;
        if (typeof tree !== 'object') return document.createTextNode(String(tree));
        if (typeof tree.type === 'function') return null; // Picker is not invoked for a saved voice.
        const node = typeof tree.type === 'symbol' ? document.createDocumentFragment() : document.createElement(tree.type);
        for (const [key, value] of Object.entries(tree.props || {})) {
          if (key === 'children' || key === 'ref') continue;
          if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
          else if (value != null && !['color', 'size'].includes(key)) node.setAttribute(key, String(value));
        }
        const children = tree.props?.children;
        for (const child of Array.isArray(children) ? children : [children]) { const rendered = treeNode(child); if (rendered) node.append(rendered); }
        return node;
      }
      function mount(root, fallback = {}) {
        const state = { slots: [], effects: new Map(), cleanups: new Map(), pending: [], index: 0 };
        const host = document.createElement('div'); document.body.append(host);
        const instance = {
          render() { hooks = state; state.index = 0; const tree = window.__actualComponent({ getRoot: () => root, getText: () => fallback.text ?? 'WRONG Markdown [copy](url)', getHtml: () => 'html' in fallback ? fallback.html : '<p>WRONG HTML</p>' }); host.replaceChildren(treeNode(tree)); for (const index of state.pending.splice(0)) state.cleanups.set(index, state.effects.get(index)()); return host; },
          get button() { return host.querySelector('[data-codex-local-read-aloud="response"]'); },
          unmount() { for (const cleanup of state.cleanups.values()) cleanup?.(); host.remove(); },
        };
        instance.render(); return instance;
      }
      function select(root, start, end) {
        const range = document.createRange(); range.setStart(root, start); range.setEnd(root, end);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange')); return range;
      }
      const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
      const fire = (node, type, init = {}) => node.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }) : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: type === 'click' ? 1 : 0, ...init }));
      const highlighted = () => { const highlight = CSS.highlights.get('codex-read-aloud-active-sentence'); return highlight ? [...highlight].map(range => range.toString()).join('') : null; };
      const chunk = (request, index = 0) => ({ done: false, mimeType: 'audio/wav', audioBase64: 'AA==', sentenceStart: request.options.sentenceRanges[index].start, sentenceEnd: request.options.sentenceRanges[index].end });
      window.fixture = { mount, select, tick, fire, highlighted, starts, nexts, cancels, audios, alerts, voiceJobs, voiceChecks, chunk,
        menu(root, range) { const tree = makeMenu(root, range); const node = treeNode(tree); if (node) document.body.append(node); return node; },
        holdVoices(value) { holdVoices = value; }, interrupt(id) { interruption?.({ requestId: id }); },
      };
    }, { source: sources, menu: selectionButton });
    return await page.evaluate(run);
  } finally { await context.close(); }
}

test('pointer capture survives focus/selection loss before mousedown and click', async () => {
  const value = await isolated('<div id="response"><p>Alpha one. Beta two.</p></div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root), text = root.querySelector('p').firstChild;
    f.select(text, 11, 20); mounted.render();
    f.fire(mounted.button, 'pointerdown'); getSelection().removeAllRanges(); mounted.button.focus();
    f.fire(mounted.button, 'mousedown'); f.fire(mounted.button, 'click'); await f.tick();
    return { text: f.starts[0]?.text, voiceOverride: f.starts[0]?.options?.voice, sentences: f.starts[0]?.options?.sentenceRanges, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Beta two.', voiceOverride: undefined, sentences: [{ start: 0, end: 9 }], alerts: [] });
});

test('keyboard activation and canceled/context/right gestures cannot reuse an old pointer snapshot', async () => {
  const value = await isolated('<div id="response">Alpha one. Beta two.</div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root), results = [];
    for (const mode of ['keyboard', 'pointercancel', 'contextmenu', 'right-mousedown']) {
      f.select(root.firstChild, 11, 20); f.fire(mounted.button, 'pointerdown');
      getSelection().removeAllRanges();
      if (mode === 'pointercancel' || mode === 'contextmenu') f.fire(mounted.button, mode);
      if (mode === 'right-mousedown') f.fire(mounted.button, 'mousedown', { button: 2 });
      f.fire(mounted.button, 'click', { detail: mode === 'keyboard' ? 0 : 1 }); await f.tick();
      results.push(f.starts.at(-1).text);
      f.fire(mounted.button, 'click'); await f.tick();
    }
    return { results, starts: f.starts.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { results: Array(4).fill('Alpha one. Beta two.'), starts: 4, alerts: [] });
});

test('actual selected DOM text uses saved Aoede without fallback HTML or voice override', async () => {
  const value = await isolated('<div id="response"><p>Read <strong>only this</strong> <a href="https://example.invalid">link label</a>.</p><span data-markdown-copy="exclude">Annotation</span><span class="sr-only">Duplicate</span></div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root), p = root.querySelector('p');
    const range = document.createRange(); range.setStart(p.querySelector('strong').firstChild, 0); range.setEnd(p.querySelector('a').firstChild, 10);
    getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); mounted.render();
    const label = mounted.button.getAttribute('aria-label');
    f.fire(mounted.button, 'pointerdown'); f.fire(mounted.button, 'mousedown'); f.fire(mounted.button, 'click'); await f.tick();
    const request = f.starts[0]; request.resolve(f.chunk(request)); await f.tick();
    f.audios[0].playing(); await f.tick();
    return { label, spoken: request.text, options: request.options, native: getSelection().toString(), highlight: f.highlighted(), alerts: f.alerts };
  });
  assert.deepEqual(value, { label: 'Read aloud', spoken: 'only this link label', options: { sentenceRanges: [{ start: 0, end: 20 }] }, native: 'only this link label', highlight: 'only this link label', alerts: [] });
});

test('builder floating-menu action routes fresh root/range when another response has identical text', async () => {
  const value = await isolated('<div id="a"><p>A <strong>Same words.</strong></p></div><div id="b"><p>B <strong>Same words.</strong></p></div>', async () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b');
    f.mount(a); f.mount(b);
    const aRange = f.select(a.querySelector('strong').firstChild, 0, 11), firstMenu = f.menu(a, aRange);
    f.fire(firstMenu, 'mousedown'); f.fire(firstMenu, 'click'); await f.tick();
    f.starts[0].resolve(f.chunk(f.starts[0])); await f.tick(); f.audios[0].playing(); await f.tick();
    const firstNode = [...CSS.highlights.get('codex-read-aloud-active-sentence')][0].startContainer;
    const stalePlaying = f.audios[0].onplaying;
    const bRange = f.select(b.querySelector('strong').firstChild, 0, 11), secondMenu = f.menu(b, bRange);
    getSelection().removeAllRanges(); f.fire(secondMenu, 'mousedown'); f.fire(secondMenu, 'click'); await f.tick();
    f.starts[1].resolve(f.chunk(f.starts[1])); await f.tick(); f.audios[1].playing(); await f.tick();
    const secondNode = [...CSS.highlights.get('codex-read-aloud-active-sentence')][0].startContainer;
    stalePlaying(); f.interrupt(f.starts[0].id); await f.tick();
    return { texts: f.starts.map(request => request.text), firstRoot: a.contains(firstNode), secondRoot: b.contains(secondNode),
      oldPaused: f.audios[0].paused, currentHighlight: f.highlighted(), firstCanceled: f.cancels.includes(f.starts[0].id), alerts: f.alerts };
  });
  assert.deepEqual(value, { texts: ['Same words.', 'Same words.'], firstRoot: true, secondRoot: true, oldPaused: true, currentHighlight: 'Same words.', firstCanceled: true, alerts: [] });
});

test('highlight follows actual playing sentence, clears during synthesis gaps and stop, leaves blue selection intact', async () => {
  const value = await isolated('<div id="response"><p>First sentence. Second sentence.</p></div><div id="blue">Keep blue.</div>', async () => {
    const f = fixture, root = document.querySelector('#response'), original = root.innerHTML, mounted = f.mount(root);
    f.select(document.querySelector('#blue').firstChild, 0, 10);
    f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0];
    const beforeChunk = f.highlighted(); request.resolve(f.chunk(request, 0)); await f.tick();
    const beforePlaying = f.highlighted(); f.audios[0].playing(); await f.tick(); const first = f.highlighted();
    f.audios[0].ended(); await f.tick(); const gap = f.highlighted();
    f.nexts[0].resolve(f.chunk(request, 1)); await f.tick(); const beforeSecondPlaying = f.highlighted();
    f.audios[1].playing(); await f.tick(); const second = f.highlighted();
    f.nexts[1].resolve({ done: true }); await f.tick(); const prefetchedDone = f.highlighted();
    const latePlaying = f.audios[1].onplaying; f.fire(mounted.button, 'click'); await f.tick(); latePlaying(); await f.tick();
    return { beforeChunk, beforePlaying, first, gap, beforeSecondPlaying, second, prefetchedDone,
      stopped: f.highlighted(), native: getSelection().toString(), unchanged: original === root.innerHTML,
      audioReleased: f.audios.every(audio => audio.paused && audio.src === ''), alerts: f.alerts };
  });
  assert.deepEqual(value, { beforeChunk: null, beforePlaying: null, first: 'First sentence.', gap: null, beforeSecondPlaying: null,
    second: 'Second sentence.', prefetchedDone: 'Second sentence.', stopped: null, native: 'Keep blue.', unchanged: true, audioReleased: true, alerts: [] });
});

test('unmount and switching while settings or audio are pending prevent stale playback/highlights', async () => {
  const value = await isolated('<div id="a">Response A.</div><div id="b">Response B.</div>', async () => {
    const f = fixture, a = f.mount(document.querySelector('#a')), b = f.mount(document.querySelector('#b'));
    f.holdVoices(true); f.fire(a.button, 'click'); await f.tick(); a.unmount();
    f.voiceJobs[0].resolve({ selectedVoice: 'af_aoede' }); await f.tick(); const startsAfterSettings = f.starts.length;
    f.holdVoices(false); f.fire(b.button, 'click'); await f.tick(); const pending = f.starts[0]; b.unmount();
    pending.resolve(f.chunk(pending)); await f.tick();
    return { startsAfterSettings, createdAudio: f.audios.length, canceled: f.cancels.includes(pending.id), highlight: f.highlighted(), alerts: f.alerts };
  });
  assert.deepEqual(value, { startsAfterSettings: 0, createdAudio: 0, canceled: true, highlight: null, alerts: [] });
});

test('cross-response floating selections are rejected and toolbar reads only its own response', async () => {
  const value = await isolated('<div id="a">Response A.</div><div id="b">Response B.</div>', async () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b'), mounted = f.mount(a); f.mount(b);
    const range = document.createRange(); range.setStart(a.firstChild, 2); range.setEnd(b.firstChild, 3);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const rejected = f.menu(a, range) === null;
    f.fire(mounted.button, 'click'); await f.tick();
    return { rejected, text: f.starts[0].text, alerts: f.alerts };
  });
  assert.deepEqual(value, { rejected: true, text: 'Response A.', alerts: [] });
});

test('normal completion clears last sentence and unmount removes floating selection capability', async () => {
  const value = await isolated('<div id="response">Finished sentence.</div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root);
    f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0]; request.resolve(f.chunk(request)); await f.tick();
    f.audios[0].playing(); await f.tick(); f.nexts[0].resolve({ done: true }); await f.tick();
    const beforeEnded = f.highlighted(); f.audios[0].ended(); await f.tick();
    const afterEnded = f.highlighted(), range = f.select(root.firstChild, 0, root.firstChild.length);
    mounted.unmount();
    return { beforeEnded, afterEnded, canceled: f.cancels.includes(request.id), removedRegistration: f.menu(root, range) === null, alerts: f.alerts };
  });
  assert.deepEqual(value, { beforeEnded: 'Finished sentence.', afterEnded: null, canceled: true, removedRegistration: true, alerts: [] });
});

test('whole-response reading skips the code wrapper and headers, keeps inline code and later prose, and never highlights code', async () => {
  const value = await isolated('<div id="response"><p>Before <code>git status</code>.</p><div data-markdown-copy="code-block"><div>JavaScript example <button>Copy</button></div><pre><code>doNotRead();\n}</code></pre></div><p>After the example.</p></div>', async () => {
    const f = fixture, root = document.querySelector('#response'), code = root.querySelector('[data-markdown-copy="code-block"]');
    const original = root.innerHTML, mounted = f.mount(root);
    f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0];
    request.resolve(f.chunk(request)); await f.tick();
    const highlights = [], onlyProse = [];
    for (let index = 0; index < request.options.sentenceRanges.length; index++) {
      f.audios[index].playing(); await f.tick();
      highlights.push(f.highlighted());
      onlyProse.push([...CSS.highlights.get('codex-read-aloud-active-sentence')]
        .every(range => !code.contains(range.startContainer) && !code.contains(range.endContainer)));
      f.nexts[index].resolve(index + 1 < request.options.sentenceRanges.length ? f.chunk(request, index + 1) : { done: true });
      await f.tick(); f.audios[index].ended(); await f.tick();
    }
    return { text: request.text, highlights, onlyProse, finished: f.highlighted(), unchanged: original === root.innerHTML, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Before git status.\n\nAfter the example.', highlights: ['Before git status.', 'After the example.'],
    onlyProse: [true, true], finished: null, unchanged: true, alerts: [] });
});

test('code-only selection stays silent after pointer focus loss and has no floating reading action', async () => {
  const value = await isolated('<div id="response"><p>Do not widen to this prose.</p><div data-markdown-copy="code-block"><div>Python <button>Copy</button></div><pre><code>onlyCode()\n   </code></pre></div><p>Or this later prose.</p></div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root), text = root.querySelector('code').firstChild;
    const range = f.select(text, 0, text.length); mounted.render();
    const menuMissing = f.menu(root, range) === null;
    // Even a direct stale invocation of the public action must not widen.
    await window.codexReadSelectionAloud(root, range); await f.tick();
    f.fire(mounted.button, 'pointerdown'); getSelection().removeAllRanges(); mounted.button.focus();
    f.fire(mounted.button, 'mousedown'); f.fire(mounted.button, 'click'); await f.tick();
    f.select(text, 0, text.length); f.fire(mounted.button, 'click', { detail: 0 }); await f.tick();
    f.select(text, text.length - 3, text.length); f.fire(mounted.button, 'click', { detail: 0 }); await f.tick();
    return { menuMissing, requests: f.starts.length, voiceChecks: f.voiceChecks.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { menuMissing: true, requests: 0, voiceChecks: 0, alerts: [] });
});

test('a mixed selection reads only its clipped prose on both sides of code and keeps native selection unchanged', async () => {
  const value = await isolated('<div id="response"><p>Outside. Chosen before.</p><pre><code>unselectedCode();\n}</code></pre><p>Chosen after. Outside tail.</p></div>', async () => {
    const f = fixture, root = document.querySelector('#response'), mounted = f.mount(root), paragraphs = root.querySelectorAll('p');
    const range = document.createRange(); range.setStart(paragraphs[0].firstChild, 9); range.setEnd(paragraphs[1].firstChild, 13);
    getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange'));
    const native = getSelection().toString(), menu = f.menu(root, range);
    f.fire(menu, 'mousedown'); f.fire(menu, 'click'); await f.tick(); const request = f.starts[0];
    request.resolve(f.chunk(request)); await f.tick(); f.audios[0].playing(); await f.tick(); const first = f.highlighted();
    f.nexts[0].resolve(f.chunk(request, 1)); await f.tick(); f.audios[0].ended(); await f.tick(); f.audios[1].playing(); await f.tick();
    const code = root.querySelector('pre');
    const highlightedProseOnly = [...CSS.highlights.get('codex-read-aloud-active-sentence')]
      .every(piece => !code.contains(piece.startContainer) && !code.contains(piece.endContainer));
    return { text: request.text, first, second: f.highlighted(), highlightedProseOnly,
      nativeUnchanged: native === getSelection().toString(), nativeIncludesCode: native.includes('unselectedCode'), alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Chosen before.\n\nChosen after.', first: 'Chosen before.', second: 'Chosen after.',
    highlightedProseOnly: true, nativeUnchanged: true, nativeIncludesCode: true, alerts: [] });
});

test('root-missing HTML fallback strips code headers and blocks without dropping later prose or inline code', async () => {
  const value = await isolated('', async () => {
    const f = fixture, mounted = f.mount(null, {
      html: '<p>Use <code style="white-space:pre-wrap">git status</code>.</p><div data-markdown-copy="code-block"><div>Shell header</div><pre><code>neverRead()</code></pre></div><code style="display:block">alsoCode()</code><p>Continue here.</p>',
      get text() { throw new Error('Raw copy getter must not run for usable structured HTML'); },
    });
    f.fire(mounted.button, 'click'); await f.tick();
    return { text: f.starts[0]?.text, options: f.starts[0]?.options, voiceChecks: f.voiceChecks.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Use git status.\n\nContinue here.', options: undefined, voiceChecks: 1, alerts: [] });
});

test('code-only HTML fallback and disconnected response do not resurrect raw copied code', async () => {
  const value = await isolated('', async () => {
    const f = fixture, disconnected = document.createElement('div'); disconnected.innerHTML = '<pre>alsoRawCode()</pre>';
    for (const root of [null, disconnected]) {
      const mounted = f.mount(root, { html: '<div data-markdown-copy="code-block"><div>JSON</div><pre>{ "code": true }</pre></div>', text: 'unfencedRawCode()' });
      f.fire(mounted.button, 'click'); await f.tick(); mounted.unmount();
    }
    return { requests: f.starts.length, voiceChecks: f.voiceChecks.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { requests: 0, voiceChecks: 0, alerts: [] });
});

test('raw-only Markdown fallback skips closed and streamed fences without DOMParser; supplied HTML fails closed', async () => {
  const value = await isolated('', async () => {
    const f = fixture;
    window.DOMParser = undefined;
    const mounted = f.mount(null, { html: null, text: 'Before `inline()`.\n```js\nhiddenCode()\n```\nAfter.\n~~~sh\nunclosedCode()' });
    f.fire(mounted.button, 'click'); await f.tick(); const text = f.starts[0]?.text; mounted.unmount();
    const html = f.mount(null, { html: '<p>Structured prose.</p><pre>rawCode()</pre>', text: 'rawCode()' });
    f.fire(html.button, 'click'); await f.tick(); html.unmount();
    window.DOMParser = class { parseFromString() { throw new Error('Parser unavailable'); } };
    const failed = f.mount(null, { html: '<pre>rawCode()</pre>', text: 'rawCode()' });
    f.fire(failed.button, 'click'); await f.tick(); failed.unmount();
    return { text, requests: f.starts.length, voiceChecks: f.voiceChecks.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Before `inline()`.\n\nAfter.', requests: 1, voiceChecks: 1, alerts: [] });
});
