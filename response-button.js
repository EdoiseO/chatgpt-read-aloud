// Fo, Y, Dr, and qi are the installed toolbar's React, JSX, button, and tooltip bindings.
let codexLocalResponseSpeaker;
let codexReadAloudSelection = null;
const codexReadAloudResponses = new Map();
function codexRangeBelongsToResponse(root, range) {
  return !!(root?.isConnected && range && !range.collapsed
    && root.contains(range.startContainer) && root.contains(range.endContainer)
    && range.toString().trim());
}
function codexFindSelectedResponse(root, range) {
  if (!codexRangeBelongsToResponse(root, range)) return null;
  for (const response of codexReadAloudResponses.values()) {
    const responseRoot = response.root();
    if ((responseRoot === root || responseRoot?.contains(root)) && codexRangeBelongsToResponse(responseRoot, range)) return response;
  }
  return null;
}
globalThis.codexCanReadSelectionAloud = (root, range) => !!codexFindSelectedResponse(root, range);
globalThis.codexReadSelectionAloud = (root, range) => {
  const response = codexFindSelectedResponse(root, range);
  if (response) return response.readRange(range.cloneRange());
};
function codexCancelReadAloudSelection() {
  const pending = codexReadAloudSelection;
  codexReadAloudSelection = null;
  pending?.cancel();
}
function codexCreateReadAloudAudio(source) {
  if (typeof globalThis.Blob !== "function" || typeof globalThis.URL?.createObjectURL !== "function") {
    return new globalThis.Audio(source);
  }
  const decoded = globalThis.atob(source.slice(source.indexOf(",") + 1));
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const url = globalThis.URL.createObjectURL(new globalThis.Blob([bytes], { type: "audio/wav" }));
  try {
    const audio = new globalThis.Audio(url);
    let disposed = false;
    audio.dispose = () => {
      if (!disposed) globalThis.URL.revokeObjectURL(url);
      disposed = true;
    };
    return audio;
  } catch (error) {
    globalThis.URL.revokeObjectURL(url);
    throw error;
  }
}
function codexGetReadAloudSpeaker() {
  if (codexLocalResponseSpeaker) return codexLocalResponseSpeaker;
  const document = globalThis.document;
  if (document?.head && document.createElement && !document.querySelector("style[data-codex-read-aloud-highlight]")) {
    const style = document.createElement("style");
    style.setAttribute("data-codex-read-aloud-highlight", "");
    style.textContent = RESPONSE_HIGHLIGHT_CSS;
    document.head.appendChild(style);
  }
  const friendlyError = () => globalThis.alert("Unable to read this response aloud. Please try again.");
  const fallback = createResponseSpeaker({
    synthesis: globalThis.speechSynthesis,
    createUtterance: typeof globalThis.SpeechSynthesisUtterance === "function"
      ? text => new globalThis.SpeechSynthesisUtterance(text) : null,
    onError: friendlyError,
  });
  const bridge = globalThis.codexLocalReadAloud;
  codexLocalResponseSpeaker = createKokoroResponseSpeaker({
    backend: bridge, createAudio: codexCreateReadAloudAudio, fallback, onError: friendlyError,
  });
  const removeInterrupt = bridge?.onInterrupted?.(message => codexLocalResponseSpeaker.interrupt(message?.requestId));
  globalThis.addEventListener("pagehide", () => {
    codexCancelReadAloudSelection();
    codexLocalResponseSpeaker.stop();
    if (typeof removeInterrupt === "function") removeInterrupt();
  });
  return codexLocalResponseSpeaker;
}
function codexReadableResponseText(html, fallback) {
  if (!html || typeof globalThis.DOMParser !== "function") return fallback;
  try {
    // A detached document keeps response markup inert while retaining link labels.
    const document = new globalThis.DOMParser().parseFromString(html, "text/html");
    document.querySelectorAll("script,style,[aria-hidden='true']").forEach(node => node.remove());
    document.querySelectorAll("p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,tr,br").forEach(node => node.append("\n"));
    return document.body.textContent.replace(/\n{3,}/g, "\n\n").trim() || fallback;
  } catch {
    return fallback;
  }
}
function CodexLocalReadAloudButton({ getText, getHtml, getRoot }) {
  const React = Fo();
  const [active, setActive] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [selectionPresent, setSelectionPresent] = React.useState(false);
  const token = React.useRef(null);
  const activeNow = React.useRef(false);
  const mounted = React.useRef(false);
  const pendingRead = React.useRef(null);
  const capturedRead = React.useRef(null);
  const highlight = React.useRef(null);
  const rootGetter = React.useRef(getRoot);
  rootGetter.current = getRoot;
  if (token.current === null) token.current = Symbol("response-speaker");
  const speaker = codexGetReadAloudSpeaker();
  const bridge = globalThis.codexLocalReadAloud;
  React.useEffect(() => {
    mounted.current = true;
    const unsubscribe = speaker.subscribe(token.current, value => {
      activeNow.current = value;
      if (!value) { highlight.current?.dispose(); highlight.current = null; }
      if (mounted.current) setActive(value);
    });
    codexReadAloudResponses.set(token.current, {
      root: () => rootGetter.current?.(),
      readRange: range => beginRead(range, true),
    });
    const selectionChanged = () => {
      const selection = globalThis.document?.getSelection?.();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      setSelectionPresent(codexRangeBelongsToResponse(rootGetter.current?.(), range));
    };
    globalThis.document?.addEventListener?.("selectionchange", selectionChanged);
    selectionChanged();
    return () => {
      mounted.current = false;
      codexReadAloudResponses.delete(token.current);
      globalThis.document?.removeEventListener?.("selectionchange", selectionChanged);
      highlight.current?.dispose(); highlight.current = null;
      capturedRead.current = null; pendingRead.current = null;
      unsubscribe();
      if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
    };
  }, [speaker]);

  function closePicker() {
    if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
    pendingRead.current = null;
    if (mounted.current) setPickerOpen(false);
  }

  function prepareRead(range = null) {
    const root = rootGetter.current?.();
    if (root?.isConnected) {
      const selection = range ? { isCollapsed: range.collapsed, rangeCount: 1, getRangeAt: () => range }
        : globalThis.document?.getSelection?.();
      const selected = captureResponseSelection(root, selection);
      if (range && !selected) throw new Error("The selected passage is no longer available.");
      const map = selected?.map ?? buildResponseTextMap(root);
      if (!map.text.trim()) return null;
      return { text: map.text, map, sentenceRanges: map.sentenceSpans() };
    }
    if (range) throw new Error("The selected response is no longer available.");
    const text = String(codexReadableResponseText(getHtml?.(), getText()) ?? "").trim();
    return text ? { text } : null;
  }

  function startRead(read) {
    highlight.current?.dispose(); highlight.current = null;
    const nextHighlight = read.map ? createResponseHighlighter(read.map) : null;
    try {
      speaker.toggle(token.current, read.text, read.map ? {
        sentenceRanges: read.sentenceRanges,
        onProgress: progress => nextHighlight.onProgress(progress),
      } : undefined);
      if (mounted.current && activeNow.current) highlight.current = nextHighlight;
      else nextHighlight?.dispose();
    } catch {
      nextHighlight?.dispose();
      globalThis.alert("Could not read this response. Please try again.");
    }
  }

  async function beginRead(range = null, restart = false, captured = null) {
    if (!restart && (activeNow.current || codexReadAloudSelection?.owner === token.current)) {
      if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
      speaker.stop();
      return;
    }
    codexCancelReadAloudSelection();
    speaker.stop();
    let read;
    try { read = captured ?? prepareRead(range); }
    catch { globalThis.alert("Could not read this response. Please try again."); return; }
    if (!read) return;
    const selection = {
      owner: token.current,
      cancel() {
        pendingRead.current = null;
        if (mounted.current) { setChecking(false); setPickerOpen(false); }
      },
    };
    codexReadAloudSelection = selection;
    setChecking(true);
    try {
      const settings = await bridge.getVoices();
      if (!mounted.current || codexReadAloudSelection !== selection) return;
      setChecking(false);
      if (typeof settings?.selectedVoice === "string" && settings.selectedVoice) {
        codexReadAloudSelection = null;
        startRead(read);
      } else if (settings?.selectedVoice === null) {
        pendingRead.current = read;
        setPickerOpen(true);
      } else throw new Error("Voice selection unavailable");
    } catch {
      if (!mounted.current || codexReadAloudSelection !== selection) return;
      codexCancelReadAloudSelection();
      globalThis.alert("Could not load local voices. Please try again.");
    }
  }

  function captureBeforeFocus(event) {
    if (event.type === "pointerdown" || event.button && event.button !== 0) capturedRead.current = null;
    if (event.button && event.button !== 0) return;
    const selection = globalThis.document?.getSelection?.();
    const root = rootGetter.current?.();
    if (!selection?.rangeCount || !codexRangeBelongsToResponse(root, selection.getRangeAt(0))) {
      if (event.type === "mousedown" && capturedRead.current) event.preventDefault();
      return;
    }
    try { capturedRead.current = prepareRead(selection.getRangeAt(0).cloneRange()); }
    catch { /* The click handler reports an unavailable selection. */ }
    if (event.type === "mousedown") event.preventDefault();
  }

  function readResponse(event) {
    event.stopPropagation();
    const captured = event.detail === 0 ? null : capturedRead.current;
    capturedRead.current = null;
    return beginRead(null, false, captured);
  }

  const busy = active || checking;
  const label = busy ? "Stop reading aloud" : selectionPresent ? "Read aloud" : "Read this response aloud";
  const icon = busy
    ? Y.jsx("rect", { x: 6, y: 6, width: 12, height: 12, rx: 1 })
    : Y.jsxs(Y.Fragment, { children: [
        Y.jsx("path", { d: "M11 5 6 9H3v6h3l5 4V5Z" }),
        Y.jsx("path", { d: "M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" }),
      ] });
  const readButton = Y.jsx(qi, {
    tooltipContent: label,
    children: Y.jsx(Dr, {
      color: "ghost", size: "icon", type: "button",
      "aria-label": label, "aria-pressed": busy,
      "data-codex-local-read-aloud": "response",
      onPointerDown: captureBeforeFocus, onMouseDown: captureBeforeFocus,
      onPointerCancel: () => { capturedRead.current = null; },
      onContextMenu: () => { capturedRead.current = null; },
      onClick: readResponse,
      children: Y.jsx("svg", {
        className: "icon-xs", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.7,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
        children: icon,
      }),
    }),
  });
  const voiceButton = Y.jsx(qi, {
    tooltipContent: "Choose reading voice",
    children: Y.jsx(Dr, {
      color: "ghost", size: "icon", type: "button", "aria-label": "Choose reading voice",
      "aria-haspopup": "dialog", "data-codex-local-read-aloud": "voice",
      onClick: event => {
        event.stopPropagation();
        codexCancelReadAloudSelection();
        pendingRead.current = null;
        setPickerOpen(true);
      },
      children: Y.jsxs("svg", {
        className: "icon-xs", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
        children: [
          Y.jsx("path", { d: "M4 7h16M4 12h16M4 17h16" }),
          Y.jsx("circle", { cx: 8, cy: 7, r: 2, fill: "currentColor", stroke: "none" }),
          Y.jsx("circle", { cx: 16, cy: 12, r: 2, fill: "currentColor", stroke: "none" }),
          Y.jsx("circle", { cx: 10, cy: 17, r: 2, fill: "currentColor", stroke: "none" }),
        ],
      }),
    }),
  });
  return Y.jsxs(Y.Fragment, {
    children: [readButton, voiceButton, pickerOpen ? Y.jsx(CodexReadAloudVoicePicker, {
      bridge, speaker, onClose: closePicker,
      onChosen: () => {
        const read = pendingRead.current;
        pendingRead.current = null;
        if (codexReadAloudSelection?.owner === token.current) codexReadAloudSelection = null;
        if (mounted.current && read) startRead(read);
      },
    }) : null],
  });
}
