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
  'import json; from selection_host_adapter import SELECTION_BUTTON; print(json.dumps(SELECTION_BUTTON))'],
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
      const starts = [], nexts = [], cancels = [], audios = [], alerts = [], voiceJobs = [], voiceChecks = [], voiceSaves = [], nativeUtterances = [];
      let interruption, holdVoices = false, nativeEnabled = false, nativeCancels = 0;
      const react = {
        useState(initial) { const index = hooks.index++, state = hooks; if (!(index in state.slots)) state.slots[index] = initial; return [state.slots[index], value => { state.slots[index] = value; }]; },
        useRef(initial) { const index = hooks.index++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
        useEffect(callback, deps) { const index = hooks.index++, previous = hooks.effects.get(index); if (!previous || deps === undefined || deps.length !== previous.deps?.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) { hooks.effects.set(index, { callback, deps }); hooks.pending.push(index); } },
      };
      window.Fo = () => react;
      window.Y = window.UG = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment') };
      window.Dr = window.HT = 'button'; window.qi = 'tooltip';
      window.CodexReadAloudVoicePicker = () => {};
      window.alert = message => alerts.push(message);
      const synthesis = { cancel() { nativeCancels++; }, getVoices() { return []; },
        speak(utterance) { if (!nativeEnabled) throw new Error('Unexpected Apple fallback'); nativeUtterances.push(utterance); } };
      // speechSynthesis is a getter on Window; plain assignment can leave the
      // browser's real API intact. Explicitly replace it for every test page.
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: undefined });
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
        setVoice(voice) { voiceSaves.push(voice); return Promise.resolve({ selectedVoice: voice }); },
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
          render() { hooks = state; state.index = 0; const tree = window.__actualComponent({ ...fallback.props, getRoot: () => root, getTextRoots: fallback.getTextRoots, getText: () => fallback.text ?? 'WRONG Markdown [copy](url)', getHtml: () => 'html' in fallback ? fallback.html : '<p>WRONG HTML</p>' }); host.replaceChildren(treeNode(tree)); for (const index of state.pending.splice(0)) { state.cleanups.get(index)?.(); state.cleanups.set(index, state.effects.get(index).callback()); } return host; },
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
      window.fixture = { mount, select, tick, fire, highlighted, starts, nexts, cancels, audios, alerts, voiceJobs, voiceChecks, voiceSaves, nativeUtterances, chunk,
        menu(root, range) { const tree = makeMenu(root, range); const node = treeNode(tree); if (node) document.body.append(node); return node; },
        holdVoices(value) { holdVoices = value; }, interrupt(id) { interruption?.({ requestId: id }); },
        enableNative() { nativeEnabled = true; window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } }; },
        get nativeCancels() { return nativeCancels; },
      };
    }, { source: sources, menu: selectionButton });
    return await page.evaluate(run);
  } finally { await context.close(); }
}

test('selection-only commentary has no idle toolbar and keeps Stop and Escape usable', async () => {
  const value = await isolated('<p id="commentary">Finished progress text.</p>', async () => {
    const f = fixture, root = document.querySelector('#commentary');
    const mounted = f.mount(root, { props: { selectionOnly: true, renderContent: () => null } });
    const range = f.select(root.firstChild, 0, root.textContent.length);
    const idleButtons = document.querySelectorAll('[data-codex-local-read-aloud="response"], [data-codex-local-read-aloud="voice"]').length;
    const owner = codexResolveReadAloudSelection(range)?.root === root;
    f.fire(f.menu(root, range), 'click'); await f.tick(); mounted.render();
    const stop = document.querySelector('[data-codex-local-read-aloud="selection-stop"]');
    const offeredStop = !!stop;
    f.fire(stop, 'click'); await f.tick(); mounted.render();
    const firstCanceled = f.cancels.includes(f.starts[0].id);
    f.fire(f.menu(root, range), 'click'); await f.tick(); mounted.render();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await f.tick(); mounted.render();
    return { idleButtons, owner, offeredStop, firstCanceled, secondCanceled: f.cancels.includes(f.starts[1].id),
      visibleStops: document.querySelectorAll('[data-codex-local-read-aloud="selection-stop"]').length,
      spoken: f.starts.map(request => request.text), alerts: f.alerts };
  });
  assert.deepEqual(value, { idleButtons: 0, owner: true, offeredStop: true, firstCanceled: true, secondCanceled: true,
    visibleStops: 0, spoken: ['Finished progress text.', 'Finished progress text.'], alerts: [] });
});

test('eligibility changes remove selection ownership and cancel pending voice lookup', async () => {
  const value = await isolated('<p id="commentary">A completed fragment.</p>', async () => {
    const f = fixture, root = document.querySelector('#commentary');
    const props = { enabled: false, selectionOnly: true, renderContent: () => null };
    const mounted = f.mount(root, { props });
    const range = f.select(root.firstChild, 0, root.textContent.length);
    const before = codexResolveReadAloudSelection(range);
    props.enabled = true; mounted.render();
    const during = codexResolveReadAloudSelection(range)?.root === root;
    f.holdVoices(true); f.fire(f.menu(root, range), 'click'); await f.tick();
    props.enabled = false; mounted.render();
    const after = codexResolveReadAloudSelection(range);
    f.voiceJobs[0].resolve({ selectedVoice: 'af_aoede' }); await f.tick();
    mounted.render();
    return { before, during, after, starts: f.starts.length, textPreserved: root.textContent, alerts: f.alerts,
      staleStop: !!document.querySelector('[data-codex-local-read-aloud="selection-stop"]') };
  });
  assert.deepEqual(value, { before: null, during: true, after: null, starts: 0, textPreserved: 'A completed fragment.', alerts: [], staleStop: false });
});

test('ordinary selected text changing during lookup cannot start stale speech', async () => {
  const value = await isolated('<p id="commentary">Original words.</p>', async () => {
    const f = fixture, root = document.querySelector('#commentary');
    f.mount(root, { props: { selectionOnly: true, renderContent: () => null } });
    const range = f.select(root.firstChild, 0, root.textContent.length);
    f.holdVoices(true); f.fire(f.menu(root, range), 'click'); await f.tick();
    root.textContent = 'Replacement words.';
    f.voiceJobs[0].resolve({ selectedVoice: 'af_aoede' }); await f.tick();
    return { starts: f.starts.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { starts: 0, alerts: ['The response changed. Please read it again.'] });
});

test('one grouped action reads assistant parts in DOM order and excludes work/user text', async () => {
  const value = await isolated('<section id="group"><p data-part>Opening.</p><div>Research task finished.</div><p>User text must stay out.</p><div data-part><table><tr><td>Plan</td><td>Ready</td></tr></table><pre>hidden_code()</pre></div><p data-part>Closing.</p></section>', async () => {
    const f = fixture, root = document.querySelector('#group');
    const mounted = f.mount(root, { getTextRoots: () => root.querySelectorAll('[data-part]') });
    f.fire(mounted.button, 'click'); await f.tick();
    const request = f.starts[0]; request.resolve(f.chunk(request, 0)); await f.tick(); f.audios[0].playing(); await f.tick();
    f.audios[0].ended(); await f.tick(); f.nexts[0].resolve(f.chunk(request, 1)); await f.tick(); f.audios[1].playing(); await f.tick();
    const during = f.highlighted(); f.fire(mounted.button, 'click'); await f.tick(); mounted.render();
    return { text: request.text, during, after: f.highlighted(), idle: mounted.button.getAttribute('aria-pressed'), alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Opening.\n\nPlan Ready\n\nClosing.', during: 'PlanReady', after: null, idle: 'false', alerts: [] });
});

test('group action captures a selection spanning transcript and table without speaking intervening work', async () => {
  const value = await isolated('<section id="group"><p data-part>First words.</p><div data-codex-local-read-aloud="group-auxiliary">Work finished.</div><div data-part><table><tr><td>Final words.</td></tr></table></div></section>', async () => {
    const f = fixture, root = document.querySelector('#group'), parts = [...root.querySelectorAll('[data-part]')];
    const mounted = f.mount(root, { getTextRoots: () => parts });
    const range = document.createRange(); range.setStart(parts[0].firstChild, 6); range.setEnd(parts[1].querySelector('td').firstChild, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); mounted.render();
    const label = mounted.button.getAttribute('aria-label');
    f.fire(mounted.button, 'pointerdown'); getSelection().removeAllRanges(); f.fire(mounted.button, 'mousedown'); f.fire(mounted.button, 'click'); await f.tick();
    return { label, text: f.starts[0]?.text, alerts: f.alerts };
  });
  assert.deepEqual(value, { label: 'Read aloud', text: 'words.\n\nFinal', alerts: [] });
});

test('floating selection inside any assistant part routes to its group and rejects work or outside roots', async () => {
  const value = await isolated('<section id="group"><p data-part>Opening.</p><p id="work">Work status.</p><p data-part>Closing.</p></section><p id="outside">Other reply.</p>', async () => {
    const f = fixture, root = document.querySelector('#group'), parts = [...root.querySelectorAll('[data-part]')];
    f.mount(root, { getTextRoots: () => parts });
    const work = document.querySelector('#work'), outside = document.querySelector('#outside');
    const workMenu = f.menu(work, f.select(work.firstChild, 0, 4));
    const outsideMenu = f.menu(outside, f.select(outside.firstChild, 0, 5));
    const menu = f.menu(parts[1], f.select(parts[1].firstChild, 0, 8));
    f.fire(menu, 'click'); await f.tick();
    return { workMenu: !!workMenu, outsideMenu: !!outsideMenu, text: f.starts[0]?.text, alerts: f.alerts };
  });
  assert.deepEqual(value, { workMenu: false, outsideMenu: false, text: 'Closing.', alerts: [] });
});

test('missing, foreign, or detached group content never falls back to wrapper or copied text', async () => {
  const value = await isolated('<section id="group"><p data-part>Allowed.</p><p>Private work text.</p></section><p id="foreign">Foreign.</p>', async () => {
    const f = fixture, root = document.querySelector('#group'), part = root.querySelector('[data-part]');
    let parts = [], mounted = f.mount(root, { getTextRoots: () => parts });
    f.fire(mounted.button, 'click'); await f.tick();
    parts = [part, document.querySelector('#foreign')]; f.fire(mounted.button, 'click'); await f.tick();
    parts = [part]; root.remove(); f.fire(mounted.button, 'click'); await f.tick();
    return { starts: f.starts.length, alerts: f.alerts };
  });
  assert.equal(value.starts, 0);
  assert.deepEqual(value.alerts, ['Could not read this response. Please try again.']);
});

test('a group does not shadow another registered response outside its allowed text roots', async () => {
  const value = await isolated('<section id="group"><p id="part">Group prose.</p><section id="nested"><p>Separate response.</p></section></section>', async () => {
    const f = fixture, group = document.querySelector('#group'), nested = document.querySelector('#nested');
    f.mount(group, { getTextRoots: () => [document.querySelector('#part')] });
    f.mount(nested);
    const menu = f.menu(nested, f.select(nested.querySelector('p').firstChild, 0, 18));
    f.fire(menu, 'click'); await f.tick();
    return { text: f.starts[0]?.text, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'Separate response.', alerts: [] });
});

for (const mutation of ['membership', 'detached', 'content', 'code', 'inserted', 'hidden']) {
  test(`group ${mutation} change while voice lookup waits cancels the captured read`, async () => {
    const value = await isolated(`<body data-mutation="${mutation}"><section id="group"><p id="a">Original.</p><p id="b">Replacement.</p></section></body>`, async () => {
      const f = fixture, root = document.querySelector('#group'), a = root.querySelector('#a'), b = root.querySelector('#b');
      const props = { getTextRoots: () => [a] }, mounted = f.mount(root, props);
      f.holdVoices(true); f.fire(mounted.button, 'click'); await f.tick();
      // The mode is encoded on the page by the test wrapper below.
      const mode = document.body.dataset.mutation;
      if (mode === 'membership') props.getTextRoots = () => [b];
      else if (mode === 'detached') root.remove();
      else if (mode === 'code') a.setAttribute('data-markdown-copy', 'code-block');
      else if (mode === 'inserted') a.append(document.createTextNode(' More text.'));
      else if (mode === 'hidden') a.hidden = true;
      else a.firstChild.data = 'Changed.';
      mounted.render(); f.voiceJobs[0].resolve({ selectedVoice: 'af_aoede' }); await f.tick();
      return { starts: f.starts.length, alerts: f.alerts };
    });
    assert.deepEqual(value, { starts: 0, alerts: ['The response changed. Please read it again.'] });
  });
}

test('group ownership changes after capture or during playback cannot use stale parts/highlights', async () => {
  const value = await isolated('<section id="group"><p id="a">Original.</p><p id="b">Replacement.</p></section>', async () => {
    const f = fixture, root = document.querySelector('#group'), a = root.querySelector('#a'), b = root.querySelector('#b');
    let parts = [a]; const mounted = f.mount(root, { getTextRoots: () => parts });
    f.select(a.firstChild, 0, 9); f.fire(mounted.button, 'pointerdown'); parts = [b]; getSelection().removeAllRanges();
    f.fire(mounted.button, 'click'); await f.tick(); const staleStarts = f.starts.length;
    f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0];
    request.resolve(f.chunk(request)); await f.tick(); f.audios[0].playing(); await f.tick(); const initialHighlight = f.highlighted();
    parts = [a]; mounted.render(); await f.tick();
    return { staleStarts, initialHighlight, highlight: f.highlighted(), paused: f.audios[0].paused, canceled: f.cancels.includes(request.id), alerts: f.alerts };
  });
  assert.deepEqual(value, { staleStarts: 0, initialHighlight: 'Replacement.', highlight: null, paused: true, canceled: true, alerts: ['The response changed. Please read it again.'] });
});

test('a playing group stops immediately when its readable content becomes excluded without a rerender', async () => {
  const value = await isolated('<section id="group"><p id="part">Visible prose.</p></section>', async () => {
    const f = fixture, root = document.querySelector('#group'), part = root.querySelector('#part');
    const mounted = f.mount(root, { getTextRoots: () => [part] });
    f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0];
    request.resolve(f.chunk(request)); await f.tick(); f.audios[0].playing(); await f.tick();
    part.setAttribute('data-markdown-copy', 'code-block'); await f.tick();
    return { highlight: f.highlighted(), paused: f.audios[0].paused, canceled: f.cancels.includes(request.id), alerts: f.alerts };
  });
  assert.deepEqual(value, { highlight: null, paused: true, canceled: true, alerts: [] });
});

for (const attribute of ['data-codex-read-aloud-owner', 'data-codex-read-aloud-part-state']) {
  test(`child-only ${attribute} changes stop group playback without a footer rerender`, async () => {
    const value = await isolated(`<body data-change="${attribute}"><section id="group"><div id="part" data-codex-read-aloud-owner="group" data-codex-read-aloud-part-state="complete"><p>Owned prose.</p></div></section></body>`, async () => {
      const f = fixture, root = document.querySelector('#group'), part = root.querySelector('#part');
      const mounted = f.mount(root, { getTextRoots: () =>
        part.getAttribute('data-codex-read-aloud-owner') === 'group' &&
        part.getAttribute('data-codex-read-aloud-part-state') === 'complete' ? [part.querySelector('p')] : [] });
      f.fire(mounted.button, 'click'); await f.tick(); const request = f.starts[0];
      request.resolve(f.chunk(request)); await f.tick(); f.audios[0].playing(); await f.tick();
      part.setAttribute(document.body.dataset.change, 'changed'); await f.tick();
      return { highlight: f.highlighted(), paused: f.audios[0].paused, canceled: f.cancels.includes(request.id), alerts: f.alerts };
    });
    assert.deepEqual(value, { highlight: null, paused: true, canceled: true, alerts: [] });
  });
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

test('cross-response selections cannot silently become a whole-response read', async () => {
  const value = await isolated('<div id="a">Response A.</div><div id="b">Response B.</div>', async () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b'), mounted = f.mount(a); f.mount(b);
    const range = document.createRange(); range.setStart(a.firstChild, 2); range.setEnd(b.firstChild, 3);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const rejected = f.menu(a, range) === null;
    f.fire(mounted.button, 'click'); await f.tick();
    return { rejected, requests: f.starts.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { rejected: true, requests: 0, alerts: ['Select text within one answer to read a passage.'] });
});

test('cross-answer rejection survives pointer focus loss and enclosing selections', async () => {
  const value = await isolated('<p id="a">First answer.</p><p id="b">Middle answer.</p><p id="c">Last answer.</p>', async () => {
    const f = fixture, a = document.querySelector('#a'), b = document.querySelector('#b'), c = document.querySelector('#c');
    const first = f.mount(a), middle = f.mount(b);
    const range = document.createRange(); range.setStart(a.firstChild, 2); range.setEnd(b.firstChild, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    f.fire(first.button, 'pointerdown'); getSelection().removeAllRanges(); first.button.focus();
    f.fire(first.button, 'mousedown'); f.fire(first.button, 'click'); await f.tick();
    range.setStart(a.firstChild, 2); range.setEnd(c.firstChild, 5);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    f.fire(middle.button, 'click', { detail: 0 }); await f.tick();
    return { requests: f.starts.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { requests: 0, alerts: Array(2).fill('Select text within one answer to read a passage.') });
});

test('foreign prose inserted inside a captured grouped selection prevents stale playback', async () => {
  const value = await isolated('<section id="group"><p data-part>Alpha.</p><p data-part>Bravo.</p></section>', async () => {
    const f = fixture, root = document.querySelector('#group'), parts = [...root.querySelectorAll('[data-part]')];
    const mounted = f.mount(root, { getTextRoots: () => parts });
    const range = document.createRange(); range.setStart(parts[0].firstChild, 0); range.setEnd(parts[1].firstChild, 6);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    f.holdVoices(true); f.fire(mounted.button, 'click'); await f.tick();
    const other = document.createElement('p'); other.textContent = 'Unowned user prose.'; root.insertBefore(other, parts[1]);
    f.voiceJobs[0].resolve({ selectedVoice: 'af_aoede' }); await f.tick();
    return { requests: f.starts.length, owner: codexResolveReadAloudSelection(range), alerts: f.alerts };
  });
  assert.deepEqual(value, { requests: 0, owner: null, alerts: ['The response changed. Please read it again.'] });
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

test('completed transcript research selection reads table cells and stops cleanly when switching or unmounting', async () => {
  const value = await isolated('<section data-realtime-handoff-id="fixture"><div id="user">Do not read user words.</div><div class="group"><div id="research" data-selected-text-overlay-target><h2>Research</h2><table><tbody><tr><th>Version</th><th>Result</th></tr><tr><td>One</td><td>Ready.</td></tr><tr><td>Two</td><td>Pending.</td></tr></tbody></table></div></div><div class="group"><div id="other" data-selected-text-overlay-target><p>Another response.</p></div></div></section>', async () => {
    const f = fixture, root = document.querySelector('#research'), other = document.querySelector('#other');
    const mounted = f.mount(root), second = f.mount(other), cells = root.querySelectorAll('td');
    const range = document.createRange(); range.setStart(cells[0].firstChild, 0); range.setEnd(cells[1].firstChild, cells[1].textContent.length);
    getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange'));
    const menu = f.menu(root, range); f.fire(menu, 'mousedown'); f.fire(menu, 'click'); await f.tick();
    const request = f.starts[0]; request.resolve(f.chunk(request)); await f.tick(); f.audios[0].playing(); await f.tick();
    const reading = f.highlighted(), selected = getSelection().toString();
    f.fire(second.button, 'click', { detail: 0 }); await f.tick();
    const stoppedFirst = f.cancels.includes(request.id), clearedOnSwitch = f.highlighted() === null;
    const next = f.starts[1]; next.resolve(f.chunk(next)); await f.tick(); f.audios[1].playing(); await f.tick();
    const otherReading = f.highlighted(); second.unmount(); mounted.unmount(); await f.tick();
    return { text: request.text, reading, selected, stoppedFirst, clearedOnSwitch,
      secondText: next.text, otherReading, finalHighlight: f.highlighted(),
      stoppedSecond: f.cancels.includes(next.id), selectionRemoved: f.menu(root, range) === null,
      untouchedUser: document.querySelector('#user').textContent, alerts: f.alerts };
  });
  assert.deepEqual(value, { text: 'One Ready.', reading: 'OneReady.', selected: 'One\tReady.',
    stoppedFirst: true, clearedOnSwitch: true, secondText: 'Another response.', otherReading: 'Another response.',
    finalHighlight: null, stoppedSecond: true, selectionRemoved: true, untouchedUser: 'Do not read user words.', alerts: [] });
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

test('explicit Mac speech preserves a selected mixed passage after focus loss, skips code, and never highlights or invokes the helper', async () => {
  const value = await isolated('<div id="response"><p>Outside. Selected before.</p><pre><code>neverRead();\n}</code></pre><p>Selected after. Outside tail.</p></div>', async () => {
    const f = fixture; f.enableNative(); f.holdVoices(true);
    const root = document.querySelector('#response'), before = root.innerHTML, mounted = f.mount(root), paragraphs = root.querySelectorAll('p');
    const range = document.createRange(); range.setStart(paragraphs[0].firstChild, 9); range.setEnd(paragraphs[1].firstChild, 15);
    getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange')); mounted.render();
    f.fire(mounted.button, 'pointerdown'); getSelection().removeAllRanges(); mounted.button.focus();
    f.fire(mounted.button, 'mousedown'); f.fire(mounted.button, 'click'); await f.tick();
    f.voiceJobs[0].reject(new Error('Local read-aloud worker timed out.')); await f.tick();
    const host = mounted.render(), alert = host.querySelector('[role="alert"]');
    const offered = alert.textContent, beforeChoice = f.nativeUtterances.length;
    const nativeButton = host.querySelector('[data-codex-local-read-aloud="use-native"]'); nativeButton.focus();
    f.fire(nativeButton, 'click'); await f.tick(); mounted.render();
    const text = f.nativeUtterances[0]?.text, highlight = f.highlighted(), stopsBefore = f.nativeCancels;
    const staleEnd = f.nativeUtterances[0].onend;
    f.fire(mounted.button, 'click'); await f.tick(); staleEnd(); await f.tick(); mounted.render();
    return { offered, beforeChoice, text, highlight, stopped: f.nativeCancels > stopsBefore,
      statusCleared: !host.querySelector('[data-codex-local-read-aloud="native-status"]'),
      noHelperCalls: f.starts.length === 0 && f.nexts.length === 0 && f.cancels.length === 0,
      noAudio: f.audios.length === 0, voiceChecks: f.voiceChecks.length, voiceSaves: f.voiceSaves.length,
      nativeSelection: getSelection().toString(), markupUnchanged: root.innerHTML === before, alerts: f.alerts };
  });
  assert.deepEqual(value, { offered: 'Local speech is unavailable.Use Mac voiceDismiss', beforeChoice: 0,
    text: 'Selected before.\n\nSelected after.', highlight: null, stopped: true, statusCleared: true,
    noHelperCalls: true, noAudio: true, voiceChecks: 1, voiceSaves: 0, nativeSelection: '', markupUnchanged: true, alerts: [] });
});

test('dismissed and superseded native offers cannot widen selection or cancel another response', async () => {
  const value = await isolated('<div id="a">Response A.</div><div id="b">Response B.</div>', async () => {
    const f = fixture; f.enableNative(); f.holdVoices(true);
    const a = f.mount(document.querySelector('#a')), b = f.mount(document.querySelector('#b'));
    f.fire(a.button, 'click'); await f.tick(); f.voiceJobs[0].reject(new Error('Local read-aloud worker stopped.')); await f.tick();
    let host = a.render(), oldUse = host.querySelector('[data-codex-local-read-aloud="use-native"]');
    f.fire(host.querySelector('[data-codex-local-read-aloud="dismiss-native"]'), 'click'); await f.tick();
    const dismissed = !a.render().querySelector('[role="alert"]'); f.fire(oldUse, 'click'); await f.tick();
    const afterDismiss = f.nativeUtterances.length;
    f.fire(a.button, 'click'); await f.tick(); f.voiceJobs[1].reject(new Error('Local read-aloud worker stopped.')); await f.tick();
    host = a.render(); oldUse = host.querySelector('[data-codex-local-read-aloud="use-native"]');
    const oldDismiss = host.querySelector('[data-codex-local-read-aloud="dismiss-native"]');
    f.fire(b.button, 'click'); await f.tick(); f.voiceJobs[2].reject(new Error('Unable to start local read-aloud worker.')); await f.tick();
    const bHost = b.render(); f.fire(oldUse, 'click'); f.fire(oldDismiss, 'click'); await f.tick();
    const bOfferPreserved = !!bHost.querySelector('[data-codex-local-read-aloud="use-native"]');
    f.fire(bHost.querySelector('[data-codex-local-read-aloud="use-native"]'), 'click'); await f.tick();
    a.unmount(); const playingB = b.render().querySelector('[data-codex-local-read-aloud="response"]').getAttribute('aria-pressed');
    return { dismissed, afterDismiss, bOfferPreserved, texts: f.nativeUtterances.map(utterance => utterance.text), playingB,
      helperCalls: f.starts.length + f.nexts.length + f.cancels.length, voiceSaves: f.voiceSaves.length,
      highlight: f.highlighted(), alerts: f.alerts };
  });
  assert.deepEqual(value, { dismissed: true, afterDismiss: 0, bOfferPreserved: true, texts: ['Response B.'], playingB: 'true',
    helperCalls: 0, voiceSaves: 0, highlight: null, alerts: [] });
});

test('unavailable native API reports failure after explicit choice without reopening lookup or speaking through the helper', async () => {
  const value = await isolated('<div id="response">Held passage.</div>', async () => {
    const f = fixture; f.holdVoices(true); const mounted = f.mount(document.querySelector('#response'));
    f.fire(mounted.button, 'click'); await f.tick(); f.voiceJobs[0].reject(new Error('Local read-aloud worker stopped.')); await f.tick();
    const host = mounted.render(); f.fire(host.querySelector('[data-codex-local-read-aloud="use-native"]'), 'click'); await f.tick();
    mounted.render();
    return { offerCleared: !host.querySelector('[role="alert"]'), inactive: mounted.button.getAttribute('aria-pressed'),
      helperCalls: f.starts.length + f.nexts.length + f.cancels.length, voiceChecks: f.voiceChecks.length,
      voiceSaves: f.voiceSaves.length, highlight: f.highlighted(), alerts: f.alerts };
  });
  assert.deepEqual(value, { offerCleared: true, inactive: 'false', helperCalls: 0, voiceChecks: 1,
    voiceSaves: 0, highlight: null, alerts: ['Unable to read this response aloud. Please try again.'] });
});

test('malformed voice metadata and a late failure after unmount never offer native speech', async () => {
  const value = await isolated('<div id="response">Selected passage.</div><div id="other">Other.</div>', async () => {
    const f = fixture; f.enableNative(); f.holdVoices(true); const mounted = f.mount(document.querySelector('#response'));
    f.fire(mounted.button, 'click'); await f.tick(); f.voiceJobs[0].resolve({ selectedVoice: 'af_unknown', voices: [{ id: 'af_aoede' }] }); await f.tick();
    const noMalformedOffer = !mounted.render().querySelector('[role="alert"]');
    f.fire(mounted.button, 'click'); await f.tick(); f.voiceJobs[1].resolve({ selectedVoice: null }); await f.tick();
    const noNullOffer = !mounted.render().querySelector('[data-codex-local-read-aloud="use-native"]');
    f.fire(mounted.button, 'click'); await f.tick(); // Cancel the held picker read.
    f.fire(mounted.button, 'click'); await f.tick(); mounted.unmount();
    f.voiceJobs[2].reject(new Error('Local read-aloud worker stopped.')); await f.tick();
    return { noMalformedOffer, noNullOffer, nativeCount: f.nativeUtterances.length,
      helperCalls: f.starts.length + f.nexts.length + f.cancels.length, voiceSaves: f.voiceSaves.length, alerts: f.alerts };
  });
  assert.deepEqual(value, { noMalformedOffer: true, noNullOffer: true, nativeCount: 0,
    helperCalls: 0, voiceSaves: 0, alerts: ['Could not load local voices. Please try again.'] });
});
