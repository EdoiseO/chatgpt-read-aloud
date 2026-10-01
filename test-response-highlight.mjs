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

test('explicit assistant roots preserve prose/table ranges without reading surrounding timeline content', async () => {
  const value = await documentTest('<section id="group"><p id="a">Opening.</p><div>Research finished.</div><p>User turn.</p><div id="b"><table><tr><td>Plan</td><td>Ready</td></tr></table><pre>secret_code()</pre></div><p id="c">Closing.</p></section><p id="foreign">Other response.</p>', () => {
    const root = document.querySelector('#group'), parts = ['a', 'b', 'c'].map(id => document.getElementById(id));
    // Input root order and duplicate nested entries cannot reorder/duplicate speech.
    const map = window.helpers.buildResponseTextMap(root, { textRoots: [parts[2], parts[0], parts[1], parts[1].querySelector('td')] });
    const pieces = map.rangesForOffsets(0, map.text.length).map(range => range.toString());
    const broadRange = map.rangeForOffsets(0, map.text.length);
    const empty = window.helpers.buildResponseTextMap(root, { textRoots: [] }).text;
    const foreign = window.helpers.buildResponseTextMap(root, { textRoots: [parts[0], document.querySelector('#foreign')] }).text;
    parts[0].remove();
    return { text: map.text, pieces, broadRange: broadRange?.toString() ?? null, empty, foreign, stale: map.rangesForOffsets(0, 8).length };
  });
  assert.deepEqual(value, { text: 'Opening.\n\nPlan Ready\n\nClosing.', pieces: ['Opening.', 'Plan', 'Ready', 'Closing.'], broadRange: null, empty: '', foreign: '', stale: 0 });
});

test('grouped selection must begin and end in assistant text and excludes intervening status', async () => {
  const value = await documentTest('<section id="group"><p id="a">Alpha.</p><p id="work" data-codex-local-read-aloud="group-auxiliary">Working.</p><p id="b">Bravo.</p></section>', () => {
    const root = document.querySelector('#group'), a = root.querySelector('#a'), b = root.querySelector('#b'), work = root.querySelector('#work');
    const range = document.createRange(); range.setStart(a.firstChild, 1); range.setEnd(b.firstChild, 4);
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
    const selected = window.helpers.captureResponseSelection(root, selection, { textRoots: [a, b] });
    range.setEnd(work.firstChild, 3);
    const statusEndpoint = window.helpers.captureResponseSelection(root, selection, { textRoots: [a, b] });
    return { text: selected.text, pieces: selected.map.rangesForOffsets(0, selected.text.length).map(range => range.toString()), statusEndpoint };
  });
  assert.deepEqual(value, { text: 'lpha.\n\nBrav', pieces: ['lpha.', 'Brav'], statusEndpoint: null });
});

test('visible prose, link labels, lists and BRs remain readable while code blocks are skipped', async () => {
  const value = await documentTest(`<section id="response">
    <p> First <strong>bold</strong> <a href="https://example.invalid/not-spoken">link label</a>.</p>
    <ul><li>One</li><li>Two<br>line<br><br>next</li></ul>
    <pre><button>Copy code</button><code>const x = 1;\n  console.log(x);</code></pre>
    <div role="toolbar">Copy response</div><button>Read response</button>
    <span aria-hidden="true">Secret icon label</span><span hidden>Hidden text</span>
    <span style="display:none">CSS hidden</span><span style="visibility:hidden">Invisible</span>
    <span inert>Inert control</span><script>notSpoken()</script><style>.not-spoken{}</style>
    <span data-markdown-copy="exclude">Excluded annotation</span><span class="sr-only">Screenreader duplicate</span>
    <svg><title>Standalone icon title</title></svg>
  </section>`, () => window.helpers.buildResponseTextMap(document.querySelector('#response')).text);
  assert.equal(value, 'First bold link label.\n\nOne\nTwo\nline\n\nnext');
});

test('table headers and numeric cells stay separate with exact unmapped separators', async () => {
  const value = await documentTest('<div id="response"><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$20</td></tr><tr id="numeric"><td>10</td><td>20</td></tr></table></div>', () => {
    const root = document.querySelector('#response'), row = document.querySelector('#numeric');
    const map = window.helpers.buildResponseTextMap(root);
    const range = document.createRange(); range.selectNodeContents(row);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const before = getSelection().toString(), selected = window.helpers.captureResponseSelection(root);
    const highlighter = window.helpers.createResponseHighlighter(selected.map);
    highlighter.onProgress({ start: 0, end: selected.text.length });
    const ranges = [...CSS.highlights.get(window.helpers.RESPONSE_HIGHLIGHT_NAME)].map(piece => piece.toString());
    const result = { text: map.text, selected: selected.text, ranges, unchanged: getSelection().toString() === before };
    highlighter.dispose(); return result;
  });
  assert.deepEqual(value, { text: 'Plan Price\nPro $20\n10 20', selected: '10 20', ranges: ['10', '20'], unchanged: true });
});

test('partial and cross-row table selections omit hidden/empty/code cells without merging values', async () => {
  const value = await documentTest('<div id="response"><table><tr><td>First</td><td></td><td hidden>Hidden</td><td><code>x</code></td></tr><tr><td>10</td><td><pre>secret()</pre></td><td>20</td></tr></table></div>', () => {
    const root = document.querySelector('#response'), cells = root.querySelectorAll('td');
    const map = window.helpers.buildResponseTextMap(root);
    const range = document.createRange(); range.setStart(cells[0].firstChild, 2); range.setEnd(cells[6].firstChild, 1);
    const selected = window.helpers.buildResponseTextMap(root, { range });
    return { text: map.text, selected: selected.text,
      ranges: selected.rangesForOffsets(0, selected.text.length).map(piece => piece.toString()) };
  });
  assert.deepEqual(value, { text: 'First x\n10\n\n20', selected: 'rst x\n10\n\n2', ranges: ['rst', 'x', '10', '2'] });
});

test('detached copied HTML tables use the same cell separators', async () => {
  const value = await documentTest('<div></div>', () => {
    const document = new DOMParser().parseFromString('<table><tr><th>10</th><th>20</th></tr><tr><td> A </td><td> B </td></tr></table>', 'text/html');
    return window.helpers.buildResponseTextMap(document.body).text;
  });
  assert.equal(value, '10 20\nA B');
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

test('element selections and preformatted prose retain aligned CRLF ranges; PRE maps empty', async () => {
  const value = await documentTest('<div id="response"><p>alpha <em>beta</em> gamma <strong>delta</strong></p><div id="formatted" style="white-space:pre-wrap"></div><pre id="code"></pre></div>', () => {
    const root = document.querySelector('#response'), p = root.querySelector('p');
    const range = document.createRange(); range.setStart(p, 1); range.setEnd(p, 3);
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
    const selected = window.helpers.captureResponseSelection(root, selection);
    const code = root.querySelector('#code'); code.textContent = '  one\r\n  two  ';
    const codeMap = window.helpers.buildResponseTextMap(code);
    const formatted = root.querySelector('#formatted'); formatted.textContent = '  one\r\n  two  ';
    const proseMap = window.helpers.buildResponseTextMap(formatted), start = proseMap.text.indexOf('two');
    return { selected: selected.text, code: codeMap.text, codeSpans: codeMap.sentenceSpans(),
      prose: proseMap.text, lastWord: proseMap.rangeForOffsets(start, start + 3).toString() };
  });
  assert.deepEqual(value, { selected: 'beta gamma', code: '', codeSpans: [], prose: 'one\n  two', lastWord: 'two' });
});

test('fenced wrapper excludes code, language header and controls without swallowing surrounding explanation', async () => {
  const value = await documentTest(`<section id="response">
    <p>Before the example.</p>
    <div data-markdown-copy="code-block" data-markdown-copy-text="def example():">
      <div><span>Python</span><button>Copy code</button></div><pre><code>def example():\n    return 1</code></pre>
    </div>
    <div><p>Nested explanation.</p><pre><code>const hidden = true;</code></pre><p>Further explanation.</p></div>
    <span data-markdown-copy-text="ordinary copy metadata">After the example.</span>
  </section>`, () => {
    const map = window.helpers.buildResponseTextMap(document.querySelector('#response'));
    return { text: map.text, sentences: map.sentenceSpans('en').map(span => map.text.slice(span.start, span.end)) };
  });
  assert.equal(value.text, 'Before the example.\n\nNested explanation.\n\nFurther explanation.\n\nAfter the example.');
  assert.deepEqual(value.sentences, ['Before the example.', 'Nested explanation.', 'Further explanation.', 'After the example.']);
});

test('skipped PRE introduces a paragraph break between adjacent prose text nodes', async () => {
  const value = await documentTest('<section id="response">Before.<pre><code>{}</code></pre>After.</section>', () => {
    const map = window.helpers.buildResponseTextMap(document.querySelector('#response'));
    return { text: map.text, sentences: map.sentenceSpans('en').map(span => map.text.slice(span.start, span.end)),
      mappedRanges: map.rangesForOffsets(0, map.text.length).map(range => range.toString()),
      encompassingRange: map.rangeForOffsets(0, map.text.length) };
  });
  assert.deepEqual(value, { text: 'Before.\n\nAfter.', sentences: ['Before.', 'After.'],
    mappedRanges: ['Before.', 'After.'], encompassingRange: null });
});

test('code-only maps and selections are empty, including header/subtree roots, and native selection remains', async () => {
  const value = await documentTest(`<section id="response"><div data-markdown-copy="code-block">
    <span id="header">javascript</span><pre><code id="code">const answer = 1;</code></pre>
  </div></section>`, () => {
    const root = document.querySelector('#response'), code = document.querySelector('#code'), header = document.querySelector('#header');
    const before = root.innerHTML, range = document.createRange(), selection = getSelection();
    range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range);
    const selectedBefore = selection.toString(), captured = window.helpers.captureResponseSelection(root);
    const codeSelectionUnchanged = selection.toString() === selectedBefore;
    const codeMap = window.helpers.buildResponseTextMap(code), rootMap = window.helpers.buildResponseTextMap(root);
    range.selectNodeContents(header); selection.removeAllRanges(); selection.addRange(range);
    const headerBefore = selection.toString(), capturedHeader = window.helpers.captureResponseSelection(root);
    return { rootText: rootMap.text, codeText: codeMap.text, rootSpans: rootMap.sentenceSpans(),
      captured, capturedHeader, headerText: window.helpers.buildResponseTextMap(header).text,
      codeSelectionBefore: selectedBefore, codeSelectionUnchanged, headerSelectionUnchanged: selection.toString() === headerBefore,
      markupUnchanged: root.innerHTML === before };
  });
  assert.deepEqual(value, { rootText: '', codeText: '', rootSpans: [], captured: null, capturedHeader: null,
    headerText: '', codeSelectionBefore: 'const answer = 1;', codeSelectionUnchanged: true,
    headerSelectionUnchanged: true, markupUnchanged: true });
});

test('mixed selected range omits code and highlights only selected prose without modifying blue selection', async () => {
  const value = await documentTest('<section id="response"><p>Start before.</p><pre><code id="code">{\n  secret();\n}</code></pre><p>Continue after.</p></section>', () => {
    const root = document.querySelector('#response'), paragraphs = root.querySelectorAll('p'), before = root.innerHTML;
    const range = document.createRange(); range.setStart(paragraphs[0].firstChild, 6); range.setEnd(paragraphs[1].firstChild, 8);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    const nativeBefore = getSelection().toString(), selected = window.helpers.captureResponseSelection(root);
    const highlighter = window.helpers.createResponseHighlighter(selected.map);
    const spans = selected.map.sentenceSpans('en');
    highlighter.onProgress({ start: 0, end: selected.text.length });
    const highlighted = [...CSS.highlights.get(window.helpers.RESPONSE_HIGHLIGHT_NAME)].map(piece => piece.toString());
    const text = selected.text, sentences = spans.map(span => selected.text.slice(span.start, span.end));
    highlighter.onProgress(spans[1]);
    const second = [...CSS.highlights.get(window.helpers.RESPONSE_HIGHLIGHT_NAME)].map(piece => piece.toString()).join('');
    highlighter.onProgress(null);
    return { text, sentences, highlighted, second,
      nativeSelectionUnchanged: getSelection().toString() === nativeBefore, nativeSelectionStillContainsCode: nativeBefore.includes('secret();'),
      markupUnchanged: root.innerHTML === before, cleared: !CSS.highlights.has(window.helpers.RESPONSE_HIGHLIGHT_NAME) };
  });
  assert.deepEqual(value, { text: 'before.\n\nContinue', sentences: ['before.', 'Continue'],
    highlighted: ['before.', 'Continue'], second: 'Continue', nativeSelectionUnchanged: true,
    nativeSelectionStillContainsCode: true, markupUnchanged: true, cleared: true });
});

test('block or multiline preformatted CODE is skipped while ordinary inline code stays in prose', async () => {
  const value = await documentTest(`<style>.block-code{display:block}</style><section id="response">
    <p>Run <code class="language-shell">git status</code> then <code style="white-space:pre-wrap">git diff</code>
      or <code style="display:inline-block">git show</code>.</p>
    <code class="block-code">const dropped = true;</code>
    <code style="white-space:pre-wrap">first dropped line\nsecond dropped line</code>
    <code style="display:grid">also dropped</code>
    <p>Continue reading.</p>
  </section>`, () => {
    const root = document.querySelector('#response'), map = window.helpers.buildResponseTextMap(root);
    return { text: map.text, blocks: [...root.querySelectorAll('code')].map(code => window.helpers.isResponseCodeBlock(code)),
      sentences: map.sentenceSpans('en').map(span => map.text.slice(span.start, span.end)) };
  });
  assert.equal(value.text, 'Run git status then git diff or git show.\n\nContinue reading.');
  assert.deepEqual(value.blocks, [false, false, false, true, true, true]);
  assert.deepEqual(value.sentences, ['Run git status then git diff or git show.', 'Continue reading.']);
});

test('selection beginning or ending inside code keeps only its selected surrounding prose', async () => {
  const value = await documentTest('<section id="response"><p>Before explanation.</p><pre><code id="code">const hidden = true;</code></pre><p>After explanation.</p></section>', () => {
    const root = document.querySelector('#response'), paragraphs = root.querySelectorAll('p'), code = root.querySelector('code').firstChild;
    const range = document.createRange(); range.setStart(code, 6); range.setEnd(paragraphs[1].firstChild, 5);
    const selected = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
    const fromCode = window.helpers.captureResponseSelection(root, selected);
    range.setStart(paragraphs[0].firstChild, 7); range.setEnd(code, 12);
    const toCode = window.helpers.captureResponseSelection(root, selected);
    return { fromCode: fromCode.text, toCode: toCode.text,
      fromCodeRange: fromCode.map.rangeForOffsets(0, fromCode.text.length).toString(),
      toCodeRange: toCode.map.rangeForOffsets(0, toCode.text.length).toString() };
  });
  assert.deepEqual(value, { fromCode: 'After', toCode: 'explanation.', fromCodeRange: 'After', toCodeRange: 'explanation.' });
});

test('shared code-block classifier handles detached copy HTML without omitting inline CODE', async () => {
  const value = await documentTest('<div></div>', () => {
    const document = new DOMParser().parseFromString('<div data-markdown-copy="code-block"><span>javascript</span><code>hidden()</code></div><pre>more()</pre><code style="display:block">block()</code><code style="white-space:pre-wrap">one\ntwo</code><code style="white-space:pre-wrap">inline()</code>', 'text/html');
    return [...document.body.children].map(element => window.helpers.isResponseCodeBlock(element));
  });
  assert.deepEqual(value, [true, true, true, true, false]);
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
