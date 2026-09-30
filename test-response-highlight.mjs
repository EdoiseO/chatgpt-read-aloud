// Real DOM/Range and CSS Highlight checks in a new, offline synthetic browser.
// This never connects to or controls a running app/browser instance.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { before, after, test } from 'node:test';

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE_PATH || 'playwright';
const { chromium } = require(modulePath);
const source = readFileSync(new URL('./response-highlight.mjs', import.meta.url), 'utf8');
let browser;

before(async () => {
  const options = { headless: true };
  if (!existsSync(chromium.executablePath())) options.channel = 'chrome';
  browser = await chromium.launch(options);
});
after(async () => { await browser?.close(); });

async function documentTest(markup, run) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  try {
    await page.setContent(markup);
    await page.evaluate(async content => {
      window.helpers = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(content));
    }, source);
    return await page.evaluate(run);
  } finally { await context.close(); }
}

test('visible prose, link labels, lists, BRs and code keep readable block boundaries', async () => {
  const value = await documentTest(`<section id="response">
    <p> First <strong>bold</strong> <a href="https://example.invalid/not-spoken">link label</a>.</p>
    <ul><li>One</li><li>Two<br>line<br><br>next</li></ul>
    <pre><button>Copy code</button><code>const x = 1;\n  console.log(x);</code></pre>
    <div role="toolbar">Copy response</div><button>Read response</button>
    <span aria-hidden="true">Secret icon label</span><span hidden>Hidden text</span>
    <span style="display:none">CSS hidden</span><span style="visibility:hidden">Invisible</span>
    <span inert>Inert control</span><script>notSpoken()</script><style>.not-spoken{}</style>
    <span data-markdown-copy="exclude">Excluded annotation</span><span class="sr-only">Screenreader duplicate</span>
  </section>`, () => window.helpers.buildResponseTextMap(document.querySelector('#response')).text);
  assert.equal(value, 'First bold link label.\n\nOne\nTwo\nline\n\nnext\n\nconst x = 1;\n  console.log(x);');
});

test('trimming, collapsed whitespace and UTF-16 emoji offsets retain exact DOM ranges', async () => {
  const value = await documentTest('<div id="response"><p>  Before   😀 <em>café</em>.  </p></div>', () => {
    const map = window.helpers.buildResponseTextMap(document.querySelector('#response'));
    const start = map.text.indexOf('😀');
    return { text: map.text, emoji: map.rangeForOffsets(start, start + 2).toString(),
      word: map.rangeForOffsets(map.text.indexOf('café'), map.text.indexOf('café') + 4).toString(),
      invalid: [-1, NaN, 1.5].map(start => map.rangeForOffsets(start, 4)),
      full: map.rangesForOffsets(0, map.text.length).map(range => range.toString()).join('') };
  });
  assert.equal(value.text, 'Before 😀 café.');
  assert.equal(value.emoji, '😀');
  assert.equal(value.word, 'café');
  assert.deepEqual(value.invalid, [null, null, null]);
  assert.equal(value.full.replace(/\s+/g, ' '), value.text);
});

test('selected map is clipped to a cloned range and does not change native selection', async () => {
  const value = await documentTest('<div id="response"><p>one <strong>two</strong> three</p></div><button id="focus">Focus</button>', () => {
    const root = document.querySelector('#response'), text = root.querySelector('strong').firstChild;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 3);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const captured = window.helpers.captureResponseSelection(root);
    const highlighter = window.helpers.createResponseHighlighter(captured.map);
    highlighter.onProgress({ start: 0, end: 3 });
    const unchanged = selection.toString();
    selection.removeAllRanges(); document.querySelector('#focus').focus();
    const value = { text: captured.text, cloned: captured.range !== range,
      cloneText: captured.range.toString(), mapRange: captured.map.rangeForOffsets(0, 3).toString(),
      unchanged, nativeAfterFocus: selection.toString() };
    highlighter.dispose(); return value;
  });
  assert.deepEqual(value, { text: 'two', cloned: true, cloneText: 'two', mapRange: 'two', unchanged: 'two', nativeAfterFocus: '' });
});

test('cross-response, collapsed, multiple, and toolbar-only selections are rejected', async () => {
  const value = await documentTest('<div id="a"><p>Response A</p><button>Copy</button></div><div id="b">Response B</div>', () => {
    const a = document.querySelector('#a'), b = document.querySelector('#b'), selection = getSelection();
    const range = document.createRange(); range.setStart(a.querySelector('p').firstChild, 0); range.setEnd(b.firstChild, 4);
    selection.removeAllRanges(); selection.addRange(range);
    const cross = window.helpers.captureResponseSelection(a);
    range.selectNodeContents(a.querySelector('button')); selection.removeAllRanges(); selection.addRange(range);
    const toolbar = window.helpers.captureResponseSelection(a);
    range.setStart(a.querySelector('p').firstChild, 1); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    const collapsed = window.helpers.captureResponseSelection(a);
    const multiple = window.helpers.captureResponseSelection(a, { rangeCount: 2, isCollapsed: false });
    return { cross, toolbar, collapsed, multiple };
  });
  assert.deepEqual(value, { cross: null, toolbar: null, collapsed: null, multiple: null });
});

test('selection element boundaries and preformatted CRLF text have aligned ranges', async () => {
  const value = await documentTest('<div id="response"><p>alpha <em>beta</em> gamma <strong>delta</strong></p><pre id="code"></pre></div>', () => {
    const root = document.querySelector('#response'), p = root.querySelector('p');
    const range = document.createRange(); range.setStart(p, 1); range.setEnd(p, 3);
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
    const selected = window.helpers.captureResponseSelection(root, selection);
    const code = root.querySelector('#code'); code.textContent = '  one\r\n  two  ';
    const codeMap = window.helpers.buildResponseTextMap(code);
    const start = codeMap.text.indexOf('two');
    return { selected: selected.text, code: codeMap.text, lastWord: codeMap.rangeForOffsets(start, start + 3).toString() };
  });
  assert.deepEqual(value, { selected: 'beta gamma', code: 'one\n  two', lastWord: 'two' });
});

test('sentence spans preserve abbreviations, paragraph/list boundaries, and cover nonwhitespace content', async () => {
  const value = await documentTest('<div id="response"><p>Dr. Smith arrived. Then he left!</p><ul><li>First bullet without punctuation</li><li>Second bullet?</li></ul></div>', () => {
    const map = window.helpers.buildResponseTextMap(document.querySelector('#response'));
    const spans = map.sentenceSpans('en');
    let position = 0;
    const gaps = spans.map(span => { const gap = map.text.slice(position, span.start); position = span.end; return gap; });
    gaps.push(map.text.slice(position));
    return { sentences: spans.map(span => map.text.slice(span.start, span.end)), gaps,
      fallback: map.sentenceSpans('invalid-locale-@').map(span => map.text.slice(span.start, span.end)) };
  });
  assert.deepEqual(value.sentences, ['Dr. Smith arrived.', 'Then he left!', 'First bullet without punctuation', 'Second bullet?']);
  assert.ok(value.gaps.every(gap => /^\s*$/.test(gap)));
  assert.deepEqual(value.fallback, ['Dr. Smith arrived. Then he left!', 'First bullet without punctuation', 'Second bullet?']);
});

test('sentence metadata stays bounded at 4096 without dropping remaining content', async () => {
  const value = await documentTest('<div id="response"></div>', () => {
    const root = document.querySelector('#response'); root.textContent = 'Sentence. '.repeat(5000);
    const map = window.helpers.buildResponseTextMap(root), spans = map.sentenceSpans('en');
    return { count: spans.length, first: spans[0].start, last: spans.at(-1).end, length: map.text.length,
      allNonempty: spans.every(span => span.end > span.start) };
  });
  assert.deepEqual(value, { count: 4096, first: 0, last: value.length, length: value.length, allNonempty: true });
});

test('real CSS Highlight works without modifying response text, controls, or native selection', async () => {
  const value = await documentTest('<div id="response">Read <em>this</em><button>Copy</button> sentence.</div><div id="other">Other</div>', () => {
    const { buildResponseTextMap, createResponseHighlighter, RESPONSE_HIGHLIGHT_NAME, RESPONSE_HIGHLIGHT_CSS } = window.helpers;
    const root = document.querySelector('#response'), before = root.innerHTML;
    const map = buildResponseTextMap(root), highlighter = createResponseHighlighter(map);
    const style = document.createElement('style'); style.textContent = RESPONSE_HIGHLIGHT_CSS; document.head.append(style);
    const selected = document.createRange(); selected.selectNodeContents(document.querySelector('#other'));
    getSelection().removeAllRanges(); getSelection().addRange(selected);
    const foreign = new Highlight(selected); CSS.highlights.set('unrelated-selection', foreign);
    highlighter.onProgress({ start: 0, end: map.text.length });
    const highlight = CSS.highlights.get(RESPONSE_HIGHLIGHT_NAME);
    const spans = [...highlight].map(range => range.toString());
    const result = { supported: !!highlight, spans, unchangedMarkup: before === root.innerHTML,
      nativeSelection: getSelection().toString(), cssColor: getComputedStyle(root, `::highlight(${RESPONSE_HIGHLIGHT_NAME})`).backgroundColor };
    highlighter.onProgress(null);
    result.cleared = !CSS.highlights.has(RESPONSE_HIGHLIGHT_NAME);
    result.foreignPreserved = CSS.highlights.get('unrelated-selection') === foreign;
    return result;
  });
  assert.equal(value.supported, true);
  assert.equal(value.spans.join(''), 'Read this sentence.');
  assert.equal(value.unchangedMarkup, true);
  assert.equal(value.nativeSelection, 'Other');
  assert.equal(value.cssColor, 'rgba(250, 204, 21, 0.34)');
  assert.equal(value.cleared, true);
  assert.equal(value.foreignPreserved, true);
});

test('old clear/dispose cannot delete a newer owner; disconnected or mutated text cannot be highlighted', async () => {
  const value = await documentTest('<div id="a">One.</div><div id="b">Two.</div>', () => {
    const { buildResponseTextMap, createResponseHighlighter, RESPONSE_HIGHLIGHT_NAME } = window.helpers;
    const a = document.querySelector('#a'), b = document.querySelector('#b');
    const mapA = buildResponseTextMap(a), mapB = buildResponseTextMap(b);
    const first = createResponseHighlighter(mapA), second = createResponseHighlighter(mapB);
    first.onProgress({ start: 0, end: 4 }); second.onProgress({ start: 0, end: 4 });
    const newest = CSS.highlights.get(RESPONSE_HIGHLIGHT_NAME); first.dispose();
    const preserved = CSS.highlights.get(RESPONSE_HIGHLIGHT_NAME) === newest;
    a.remove(); first.onProgress({ start: 0, end: 4 });
    const detachedRange = mapA.rangeForOffsets(0, 4);
    b.firstChild.data = 'Different response text'; second.onProgress({ start: 0, end: 4 });
    const staleCleared = !CSS.highlights.has(RESPONSE_HIGHLIGHT_NAME);
    second.dispose(); second.onProgress({ start: 0, end: 4 });
    return { preserved, detachedRange, staleCleared, disposedInert: !CSS.highlights.has(RESPONSE_HIGHLIGHT_NAME) };
  });
  assert.deepEqual(value, { preserved: true, detachedRange: null, staleCleared: true, disposedInert: true });
});

test('missing Highlight API and malformed progress safely do nothing', async () => {
  const value = await documentTest('<div id="response">Text.</div>', () => {
    const root = document.querySelector('#response'), map = window.helpers.buildResponseTextMap(root);
    const highlighter = window.helpers.createResponseHighlighter(map);
    for (const progress of [null, {}, { start: -1, end: 4 }, { start: 0, end: 999 }, { start: 0.5, end: 3 }]) highlighter.onProgress(progress);
    window.Highlight = undefined;
    highlighter.onProgress({ start: 0, end: 5 }); highlighter.clear(); highlighter.dispose();
    return { absent: !CSS.highlights.has(window.helpers.RESPONSE_HIGHLIGHT_NAME), text: root.textContent };
  });
  assert.deepEqual(value, { absent: true, text: 'Text.' });
});
