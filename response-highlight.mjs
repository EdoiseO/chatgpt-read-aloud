// Readable response text and UTF-16 DOM offsets share one immutable snapshot.
// Callers provide the exact response element; no assistant-container selector
// or native-selection mutation belongs in this module.
export const RESPONSE_HIGHLIGHT_NAME = 'codex-read-aloud-active-sentence';
// Group footer visibility is scoped to its own answer. A generic Tailwind
// `group` ancestor would also reveal unrelated native buttons in child cards.
export const RESPONSE_HIGHLIGHT_CSS = `::highlight(${RESPONSE_HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.34); color: inherit; }
[data-codex-read-aloud-group] > [data-codex-local-read-aloud="response-controls"] { opacity: 0; }
[data-codex-read-aloud-group]:hover > [data-codex-local-read-aloud="response-controls"],
[data-codex-read-aloud-group]:focus-within > [data-codex-local-read-aloud="response-controls"],
[data-codex-read-aloud-group] > [data-codex-local-read-aloud="response-controls"][data-codex-read-aloud-active="true"] { opacity: 1; }`;

const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'CANVAS']);
const OMIT_ROLES = new Set(['toolbar', 'button', 'menu', 'menubar', 'menuitem', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'textbox', 'combobox']);
const PARAGRAPHS = new Set(['P', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL']);
const BLOCKS = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'TR', 'TABLE', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION']);
const MAX_SENTENCES = 4096;

function within(root, node) {
  return node === root || !!root?.contains?.(node);
}

function tagName(element) {
  return (element?.tagName || '').toUpperCase();
}

// The supported app marks fenced-code wrappers this way, including their
// language header and copy controls. Never omit a generic ancestor of PRE:
// it may also contain the explanation surrounding a code example.
export function isResponseCodeBlock(element, view = element?.ownerDocument?.defaultView) {
  const tag = tagName(element);
  if (tag === 'PRE' || element?.getAttribute?.('data-markdown-copy') === 'code-block') return true;
  if (tag !== 'CODE') return false;
  let style = element.style;
  try { style = view?.getComputedStyle?.(element) || style; } catch { /* Detached copy HTML uses inline styles. */ }
  if (/^(block|flow-root|flex|grid|table|list-item)$/.test(style?.display || '')) return true;
  // Inline snippets may use pre-wrap without being fenced blocks. Require
  // actual line breaks for a preformatted CODE element lacking a block box.
  return /^(pre|pre-wrap|break-spaces)$/.test(style?.whiteSpace || '') && /[\r\n]/.test(element.textContent || '');
}

function visibleElement(element, view) {
  if (OMIT_TAGS.has(tagName(element)) || element.hidden || element.inert ||
      element.getAttribute?.('aria-hidden') === 'true' ||
      element.getAttribute?.('data-markdown-copy') === 'exclude' ||
      element.classList?.contains('sr-only') ||
      element.hasAttribute?.('data-codex-local-read-aloud') ||
      OMIT_ROLES.has((element.getAttribute?.('role') || '').toLowerCase())) return false;
  try {
    const style = view?.getComputedStyle?.(element);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' ||
        style?.contentVisibility === 'hidden') return false;
  } catch { /* Detached synthetic documents may not expose computed style. */ }
  return true;
}

function sentenceSpans(text, locale) {
  let segmenter;
  try { segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' }); } catch { /* Paragraph fallback below. */ }
  const spans = [];
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    let previous = null;
    const pieces = segmenter ? segmenter.segment(line[0]) : [{ segment: line[0], index: 0 }];
    for (const piece of pieces) {
      const leading = piece.segment.length - piece.segment.trimStart().length;
      const clean = piece.segment.trim();
      if (!clean) continue;
      const start = line.index + piece.index + leading;
      const end = start + clean.length;
      if (previous && /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i.test(text.slice(previous.start, previous.end))) {
        previous.end = end;
        continue;
      }
      if (spans.length === MAX_SENTENCES) {
        // Cover all remaining content instead of silently omitting sentences.
        spans[MAX_SENTENCES - 1].end = text.trimEnd().length;
        return spans;
      }
      previous = { start, end };
      spans.push(previous);
    }
  }
  return spans;
}

export function buildResponseTextMap(root, { range = null, textRoots = null } = {}) {
  const document = root?.ownerDocument;
  const view = document?.defaultView;
  // A voice reply may contain transcript, research, and non-speech work cards.
  // Explicit roots restrict speech to reviewed assistant content. Invalid or
  // empty roots fail closed; they must never fall back to the entire wrapper.
  let allowed = null;
  if (textRoots !== null) {
    try {
      allowed = Array.from(textRoots);
      if (!allowed.every(part => part?.nodeType === 1 && within(root, part))) allowed = [];
    } catch { allowed = []; }
  }
  const ownedText = node => allowed === null || allowed.some(part => within(part, node));
  const traversable = node => allowed === null || allowed.some(part => within(part, node) || within(node, part));
  const units = [];
  const snapshots = new Map();
  let pendingSpace = null;
  let pendingBreaks = 0;

  function boundary(count) {
    pendingSpace = null;
    pendingBreaks = Math.max(pendingBreaks, count);
  }
  function flush() {
    if (units.length) {
      if (pendingBreaks) {
        let trailing = 0;
        for (let i = units.length - 1; i >= 0 && units[i].char === '\n'; i--) trailing++;
        for (let i = trailing; i < pendingBreaks; i++) units.push({ char: '\n' });
      } else if (pendingSpace && !/\s/u.test(units.at(-1).char)) units.push(pendingSpace);
    }
    pendingSpace = null;
    pendingBreaks = 0;
  }
  function text(node, preserve) {
    if (!ownedText(node)) return;
    const raw = node.data ?? node.textContent ?? '';
    let first = 0, last = raw.length;
    if (range) {
      try {
        if (range.comparePoint(node, last) < 0 || range.comparePoint(node, 0) > 0) return;
        if (range.startContainer === node) first = range.startOffset;
        if (range.endContainer === node) last = range.endOffset;
      } catch { return; }
    }
    if (last <= first) return;
    snapshots.set(node, raw);
    for (let i = first; i < last; i++) {
      let char = raw[i], end = i + 1;
      if (char === '\r') {
        if (raw[end] === '\n' && end < last) end++;
        char = '\n';
      }
      const unit = { char, node, first: i, last: end };
      if (!preserve && /[\t\n\r\f ]/.test(char)) {
        if (!pendingSpace) pendingSpace = { ...unit, char: ' ' };
        else if (pendingSpace.node === node) pendingSpace.last = end;
      } else {
        flush();
        units.push(unit);
      }
      i = end - 1;
    }
  }
  function walk(node, preserve = false) {
    if (node.nodeType === 3) { text(node, preserve); return; }
    if (node.nodeType !== 1 || !traversable(node) || !visibleElement(node, view)) return;
    if (range) {
      try { if (!range.intersectsNode(node)) return; } catch { return; }
    }
    if (isResponseCodeBlock(node, view)) {
      boundary(2);
      return;
    }
    const tag = tagName(node);
    if (tag === 'BR') {
      pendingSpace = null;
      pendingBreaks = Math.min(2, pendingBreaks + 1);
      return;
    }
    const breaks = PARAGRAPHS.has(tag) ? 2 : BLOCKS.has(tag) ? 1 : 0;
    if (breaks) boundary(breaks);
    // Cells have no separating text node in minified/copied HTML. Use an
    // unmapped space so 10|20 stays two values and highlights stay on real text.
    const cell = tag === 'TD' || tag === 'TH';
    if (cell && !pendingSpace) pendingSpace = { char: ' ' };
    let whitespace;
    try { whitespace = view?.getComputedStyle?.(node)?.whiteSpace; } catch { /* Fall back to PRE. */ }
    const preformatted = preserve || /^(pre|pre-wrap|break-spaces)$/.test(whitespace || '');
    for (const child of node.childNodes || []) walk(child, preformatted);
    if (breaks) boundary(breaks);
    else if (cell && !pendingSpace) pendingSpace = { char: ' ' };
  }
  let blockAncestor = root;
  while (blockAncestor && !isResponseCodeBlock(blockAncestor, view)) blockAncestor = blockAncestor.parentElement;
  if (root && !blockAncestor && document?.createRange &&
      (!range || within(root, range.startContainer) && within(root, range.endContainer))) walk(root);
  // Trim units with the exact same operation as speech text, retaining offset
  // alignment even when a selection starts/ends inside collapsed whitespace.
  const untrimmed = units.map(unit => unit.char).join('');
  const leading = untrimmed.length - untrimmed.trimStart().length;
  const cleanUnits = units.slice(leading, untrimmed.trimEnd().length);
  const content = cleanUnits.map(unit => unit.char).join('');

  function valid(start, end) {
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= content.length &&
      !!root?.isConnected && cleanUnits.slice(start, end).every(unit => !unit.node ||
        within(root, unit.node) && ownedText(unit.node) &&
        (unit.node.data ?? unit.node.textContent) === snapshots.get(unit.node));
  }
  function rangesForOffsets(start, end) {
    if (!valid(start, end)) return [];
    const ranges = [];
    let current = null;
    for (let i = start; i < end; i++) {
      const unit = cleanUnits[i];
      if (!unit.node) continue;
      if (current?.node === unit.node && unit.first <= current.end) current.end = unit.last;
      else {
        current = { node: unit.node, start: unit.first, end: unit.last };
        ranges.push(current);
      }
    }
    return ranges.map(piece => {
      const result = document.createRange();
      result.setStart(piece.node, piece.start);
      result.setEnd(piece.node, piece.end);
      return result;
    });
  }
  function rangeForOffsets(start, end) {
    const pieces = rangesForOffsets(start, end);
    if (!pieces.length) return null;
    const result = document.createRange();
    result.setStart(pieces[0].startContainer, pieces[0].startOffset);
    result.setEnd(pieces.at(-1).endContainer, pieces.at(-1).endOffset);
    // One encompassing Range must not reintroduce skipped code or controls.
    // Callers needing disjoint prose fragments use rangesForOffsets instead.
    if (result.toString().replace(/\s/gu, '') !== content.slice(start, end).replace(/\s/gu, '')) return null;
    return result;
  }
  function isCurrent() {
    if (!content.length || !valid(0, content.length)) return false;
    // Exclusions, insertions, and DOM order can change without changing an old
    // text node. Rebuild eligibility before a queued grouped read is dispatched.
    const fresh = buildResponseTextMap(root, { range, textRoots: allowed });
    if (fresh.text !== content) return false;
    if (range && allowed !== null &&
        buildResponseTextMap(root, { range }).text.replace(/\s+/gu, ' ').trim() !==
        fresh.text.replace(/\s+/gu, ' ').trim()) return false;
    const before = rangesForOffsets(0, content.length);
    const after = fresh.rangesForOffsets(0, content.length);
    return before.length === after.length && before.every((piece, index) =>
      piece.startContainer === after[index].startContainer && piece.startOffset === after[index].startOffset &&
      piece.endContainer === after[index].endContainer && piece.endOffset === after[index].endOffset);
  }
  return Object.freeze({ root, text: content, rangeForOffsets, rangesForOffsets,
    isCurrent,
    sentenceSpans: locale => sentenceSpans(content, locale) });
}

export function captureResponseSelection(root, selection = root?.ownerDocument?.defaultView?.getSelection?.(), { textRoots = null } = {}) {
  try {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (range.collapsed || !within(root, range.startContainer) || !within(root, range.endContainer)) return null;
    if (textRoots !== null) {
      const parts = Array.from(textRoots);
      if (!parts.length || !parts.every(part => part?.nodeType === 1 && within(root, part)) ||
          !parts.some(part => within(part, range.startContainer)) ||
          !parts.some(part => within(part, range.endContainer))) return null;
    }
    const map = buildResponseTextMap(root, { range, textRoots });
    if (textRoots !== null) {
      // A group cannot silently drop intervening user/foreign prose. Known
      // code, controls and reviewed auxiliary cards are excluded by the same
      // mapper in both views; all remaining selected text must be owned.
      const selectedText = buildResponseTextMap(root, { range }).text;
      const comparable = text => text.replace(/\s+/gu, ' ').trim();
      if (comparable(selectedText) !== comparable(map.text)) return null;
    }
    return map.text ? Object.freeze({ text: map.text, range, map }) : null;
  } catch { return null; }
}

export function createResponseHighlighter(map, { name = RESPONSE_HIGHLIGHT_NAME } = {}) {
  const view = map?.root?.ownerDocument?.defaultView;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  let owned = null;
  let disposed = false;
  function clear() {
    // A late stop from another response must not remove a newer highlight.
    try { if (owned && registry?.get?.(name) === owned) registry.delete?.(name); } catch { /* Unsupported registries are inert. */ }
    owned = null;
  }
  function onProgress(progress) {
    clear();
    if (disposed || !progress || typeof Highlight !== 'function' || !registry?.set || !registry?.get ||
        !/^[a-z][a-z0-9-]*$/i.test(name)) return;
    try {
      const ranges = map.rangesForOffsets(progress.start, progress.end);
      if (!ranges.length) return;
      owned = new Highlight(...ranges);
      registry.set(name, owned);
    } catch { clear(); }
  }
  return Object.freeze({ onProgress, clear, dispose() { clear(); disposed = true; } });
}
