// Readable response text and UTF-16 DOM offsets share one immutable snapshot.
// Callers provide the exact response element; no assistant-container selector
// or native-selection mutation belongs in this module.
export const RESPONSE_HIGHLIGHT_NAME = 'codex-read-aloud-active-sentence';
export const RESPONSE_HIGHLIGHT_CSS = `::highlight(${RESPONSE_HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.34); color: inherit; }`;

const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'CANVAS']);
const OMIT_ROLES = new Set(['toolbar', 'button', 'menu', 'menubar', 'menuitem', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'textbox', 'combobox']);
const PARAGRAPHS = new Set(['P', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL']);
const BLOCKS = new Set(['DIV', 'SECTION', 'ARTICLE', 'LI', 'TR', 'TABLE', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION']);
const MAX_SENTENCES = 4096;

function within(root, node) {
  return node === root || !!root?.contains?.(node);
}

function visibleElement(element, view) {
  if (OMIT_TAGS.has(element.tagName) || element.hidden || element.inert ||
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

export function buildResponseTextMap(root, { range = null } = {}) {
  const document = root?.ownerDocument;
  const view = document?.defaultView;
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
    if (node.nodeType !== 1 || !visibleElement(node, view)) return;
    if (range) {
      try { if (!range.intersectsNode(node)) return; } catch { return; }
    }
    if (node.tagName === 'BR') {
      pendingSpace = null;
      pendingBreaks = Math.min(2, pendingBreaks + 1);
      return;
    }
    const breaks = PARAGRAPHS.has(node.tagName) ? 2 : BLOCKS.has(node.tagName) ? 1 : 0;
    if (breaks) boundary(breaks);
    let whitespace;
    try { whitespace = view?.getComputedStyle?.(node)?.whiteSpace; } catch { /* Fall back to PRE. */ }
    const preformatted = preserve || node.tagName === 'PRE' || /^(pre|pre-wrap|break-spaces)$/.test(whitespace || '');
    for (const child of node.childNodes || []) walk(child, preformatted);
    if (breaks) boundary(breaks);
  }
  if (root && document?.createRange && (!range || within(root, range.startContainer) && within(root, range.endContainer))) walk(root);
  // Trim units with the exact same operation as speech text, retaining offset
  // alignment even when a selection starts/ends inside collapsed whitespace.
  const untrimmed = units.map(unit => unit.char).join('');
  const leading = untrimmed.length - untrimmed.trimStart().length;
  const cleanUnits = units.slice(leading, untrimmed.trimEnd().length);
  const content = cleanUnits.map(unit => unit.char).join('');

  function valid(start, end) {
    return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= content.length &&
      !!root?.isConnected && cleanUnits.slice(start, end).every(unit => !unit.node ||
        within(root, unit.node) && (unit.node.data ?? unit.node.textContent) === snapshots.get(unit.node));
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
    return result;
  }
  return Object.freeze({ root, text: content, rangeForOffsets, rangesForOffsets,
    sentenceSpans: locale => sentenceSpans(content, locale) });
}

export function captureResponseSelection(root, selection = root?.ownerDocument?.defaultView?.getSelection?.()) {
  try {
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (range.collapsed || !within(root, range.startContainer) || !within(root, range.endContainer)) return null;
    const map = buildResponseTextMap(root, { range });
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
