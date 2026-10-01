// Fo, Y, Dr, and qi are the installed toolbar's React, JSX, button, and tooltip bindings.
let codexLocalResponseSpeaker;
let codexReadAloudSelection = null;
const codexReadAloudResponses = new Map();
let codexSelectionRefreshQueued = false;
function codexRefreshReadAloudSelection() {
  const document = globalThis.document;
  if (codexSelectionRefreshQueued || !document?.getSelection?.()?.rangeCount ||
      typeof globalThis.Event !== "function") return;
  codexSelectionRefreshQueued = true;
  Promise.resolve().then(() => {
    codexSelectionRefreshQueued = false;
    if (document.getSelection()?.rangeCount) document.dispatchEvent(new globalThis.Event("selectionchange"));
  });
}
function codexRangeIntersectsResponse(root, range) {
  try {
    return !!(root?.isConnected && range && !range.collapsed &&
      (root.contains(range.startContainer) || root.contains(range.endContainer) || range.intersectsNode(root)));
  } catch { return false; }
}
function codexSelectionBoundaryError() {
  return Object.assign(new Error("Select text within one answer to read a passage."), { code: "CROSS_RESPONSE_SELECTION" });
}
function codexRangeBelongsToResponse(root, range, textRoots = null) {
  if (textRoots !== null) {
    try {
      const parts = Array.from(textRoots);
      if (!parts.length || !parts.every(part => part?.nodeType === 1 && root?.contains(part)) ||
          !parts.some(part => part.contains(range?.startContainer)) ||
          !parts.some(part => part.contains(range?.endContainer))) return false;
    } catch { return false; }
  }
  return !!(root?.isConnected && range && !range.collapsed
    && root.contains(range.startContainer) && root.contains(range.endContainer));
}
function codexFindSelectedResponse(root, range) {
  if (!codexRangeBelongsToResponse(root, range)) return null;
  let found = null;
  for (const response of codexReadAloudResponses.values()) {
    const responseRoot = response.root();
    if ((responseRoot === root || responseRoot?.contains(root)) &&
        codexRangeBelongsToResponse(responseRoot, range) && response.canReadRange(range) &&
        (!found || found.root()?.contains(responseRoot))) found = response;
  }
  return found;
}
// Only registered assistant content can widen the host's single-target menu.
// Prefer the smallest owner; adjacent answers never acquire a shared owner by
// walking arbitrary DOM ancestors. Group owners supply explicit text roots.
globalThis.codexResolveReadAloudSelection = range => {
  let found = null;
  for (const response of codexReadAloudResponses.values()) {
    const root = response.root();
    if (codexRangeBelongsToResponse(root, range) && response.canReadRange(range) &&
        (!found || found.contains(root))) found = root;
  }
  return found ? { root: found } : null;
};
globalThis.codexCanReadSelectionAloud = (root, range) => {
  return !!codexFindSelectedResponse(root, range);
};
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
function codexWithoutFencedCode(value) {
  const readable = [];
  let fence = null;
  for (const line of String(value ?? "").split(/\r\n?|\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)[\t ]*$/);
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { character: open[1][0], length: open[1].length };
      readable.push("");
    } else readable.push(line);
  }
  // An unclosed fence owns everything after it, as in a streamed response.
  return readable.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function codexReadableResponseText(html, fallback) {
  if (!html) return codexWithoutFencedCode(fallback);
  if (typeof globalThis.DOMParser !== "function") return "";
  try {
    // The same mapper skips fenced-code wrappers/headers and preserves inline
    // code. A valid empty HTML result must never resurrect raw copied code.
    const document = new globalThis.DOMParser().parseFromString(html, "text/html");
    return buildResponseTextMap(document.body).text;
  } catch {
    return "";
  }
}
function codexVoiceHelperUnavailable(error) {
  // Electron invoke may prefix the main process's fixed message. Invalid
  // metadata/protocol and trust errors must not offer a different speech path.
  const message = typeof error?.message === "string" ? error.message : "";
  return [
    "Unable to start local read-aloud worker.",
    "Local read-aloud worker stopped.",
    "Local read-aloud worker timed out.",
    "Local read-aloud is unavailable.",
    "Unable to generate local read-aloud audio.",
  ].some(fixed => message === fixed || message.endsWith(": " + fixed));
}
function codexValidVoiceSettings(settings) {
  try {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    const id = settings.selectedVoice;
    const validId = voice => typeof voice === "string" && /^(?:af|am|bf|bm)_[a-z0-9]+$/.test(voice);
    if (id !== null && !validId(id)) return false;
    if (settings.voices !== undefined) {
      if (!Array.isArray(settings.voices) || settings.voices.length > 64) return false;
      const ids = settings.voices.map(voice => voice?.id);
      if (!ids.every(validId) || new Set(ids).size !== ids.length || id !== null && !ids.includes(id)) return false;
    }
    return (settings.speed === undefined || settings.speed === 1) &&
      (settings.engine === undefined || ["mlx", "onnx"].includes(settings.engine));
  } catch { return false; }
}
function CodexLocalReadAloudButton({ getText, getHtml, getRoot, getTextRoots,
  enabled = true, renderContent, selectionOnly = false }) {
  const React = Fo();
  const [active, setActive] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [selectionPresent, setSelectionPresent] = React.useState(false);
  const [nativeOffer, setNativeOffer] = React.useState(null);
  const token = React.useRef(null);
  const activeNow = React.useRef(false);
  const mounted = React.useRef(false);
  const pendingRead = React.useRef(null);
  const capturedRead = React.useRef(null);
  const highlight = React.useRef(null);
  const activeRead = React.useRef(null);
  const activeObserver = React.useRef(null);
  const rootGetter = React.useRef(getRoot);
  rootGetter.current = getRoot;
  const enabledNow = React.useRef(enabled);
  enabledNow.current = enabled === true;
  const textRootsGetter = React.useRef(getTextRoots);
  textRootsGetter.current = getTextRoots;
  const textRoots = () => textRootsGetter.current ? Array.from(textRootsGetter.current() ?? []) : null;
  if (token.current === null) token.current = Symbol("response-speaker");
  const speaker = codexGetReadAloudSpeaker();
  const bridge = globalThis.codexLocalReadAloud;
  React.useEffect(() => {
    mounted.current = true;
    // An eligibility transition tears down the previous session. Its cleanup
    // deliberately avoids state updates after unmount; reset UI on the next
    // mounted lifecycle so a disabled root cannot retain a dialog or Stop.
    setChecking(false); setPickerOpen(false); setNativeOffer(null);
    const unsubscribe = speaker.subscribe(token.current, value => {
      activeNow.current = value;
      if (!value) {
        highlight.current?.dispose(); highlight.current = null;
        activeRead.current = null;
        activeObserver.current?.disconnect(); activeObserver.current = null;
      }
      if (mounted.current) setActive(value);
    });
    if (enabled) codexReadAloudResponses.set(token.current, {
      root: () => enabledNow.current ? rootGetter.current?.() : null,
      readRange: range => beginRead(range, true),
      canReadRange: range => {
        if (!enabledNow.current) return false;
        try { return !!captureResponseSelection(rootGetter.current?.(), {
          isCollapsed: range.collapsed, rangeCount: 1, getRangeAt: () => range,
        }, { textRoots: textRoots() })?.map.text.trim(); } catch { return false; }
      },
    });
    const selectionChanged = () => {
      const selection = globalThis.document?.getSelection?.();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      try { setSelectionPresent(enabledNow.current && codexRangeBelongsToResponse(rootGetter.current?.(), range, textRoots())); }
      catch { setSelectionPresent(false); }
    };
    const escape = event => {
      if (event.key === "Escape" && (activeNow.current || codexReadAloudSelection?.owner === token.current)) {
        stopReading();
      }
    };
    globalThis.document?.addEventListener?.("selectionchange", selectionChanged);
    globalThis.document?.addEventListener?.("keydown", escape);
    selectionChanged();
    return () => {
      mounted.current = false;
      codexReadAloudResponses.delete(token.current);
      codexRefreshReadAloudSelection();
      globalThis.document?.removeEventListener?.("selectionchange", selectionChanged);
      globalThis.document?.removeEventListener?.("keydown", escape);
      highlight.current?.dispose(); highlight.current = null;
      activeObserver.current?.disconnect(); activeObserver.current = null; activeRead.current = null;
      capturedRead.current = null; pendingRead.current = null;
      unsubscribe();
      if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
    };
  }, [speaker, enabled]);
  // Group membership is a rendering prop. Recheck after each commit rather
  // than waiting for another audio progress event (which may be deduplicated).
  React.useEffect(() => {
    const read = activeRead.current;
    if (read?.isCurrent && (!read.isCurrent() || !read.map.isCurrent())) speaker.stop();
    codexRefreshReadAloudSelection();
  });

  function closePicker() {
    if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
    pendingRead.current = null;
    if (mounted.current) setPickerOpen(false);
  }

  function stopReading(event) {
    event?.stopPropagation?.();
    if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
    pendingRead.current = null;
    capturedRead.current = null;
    if (activeNow.current) speaker.stop();
    if (mounted.current) { setChecking(false); setPickerOpen(false); setNativeOffer(null); }
  }

  function prepareRead(range = null) {
    if (!enabledNow.current) return null;
    const root = rootGetter.current?.();
    if (root?.isConnected) {
      const parts = textRoots();
      const selection = range ? { isCollapsed: range.collapsed, rangeCount: 1, getRangeAt: () => range }
        : globalThis.document?.getSelection?.();
      const selectedRange = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const ownedSelection = codexRangeBelongsToResponse(root, selectedRange, parts);
      if (range && !ownedSelection) throw new Error("The selected passage is no longer available.");
      if (!ownedSelection && codexRangeIntersectsResponse(root, selectedRange)) throw codexSelectionBoundaryError();
      const selected = ownedSelection ? captureResponseSelection(root, selection, { textRoots: parts }) : null;
      // An owned selection containing only omitted code stays an empty read;
      // it must not become a request for the whole response.
      if (ownedSelection && !selected) return null;
      const map = selected ? selected.map : buildResponseTextMap(root, { textRoots: parts });
      if (!map.text.trim()) return null;
      const read = { text: map.text, map, sentenceRanges: map.sentenceSpans() };
      read.isCurrent = () => {
          try {
            const current = textRoots();
            return enabledNow.current && rootGetter.current?.() === root && root.isConnected &&
              (parts === null ? current === null : current !== null &&
              current.length === parts.length && current.every((part, index) => part === parts[index] && root.contains(part)));
          } catch { return false; }
      };
      return read;
    }
    if (textRootsGetter.current) throw new Error("The grouped response is no longer available.");
    if (range) throw new Error("The selected response is no longer available.");
    const html = getHtml?.();
    const text = String(codexReadableResponseText(html, html ? "" : getText()) ?? "").trim();
    return text ? { text } : null;
  }

  function startRead(read, mode = "kokoro") {
    if (!enabledNow.current || !mounted.current) return;
    if (read.isCurrent && (!read.isCurrent() || !read.map.isCurrent())) {
      globalThis.alert("The response changed. Please read it again.");
      return;
    }
    highlight.current?.dispose(); highlight.current = null;
    const nextHighlight = mode !== "native" && read.map ? createResponseHighlighter(read.map) : null;
    try {
      const options = mode === "native" ? {
        mode: "native", ...(read.map ? { sentenceRanges: read.sentenceRanges } : {}),
      } : read.map ? {
        sentenceRanges: read.sentenceRanges, onProgress: progress => {
          if (progress && read.isCurrent && !read.isCurrent()) {
            nextHighlight.dispose(); speaker.stop(); return;
          }
          nextHighlight.onProgress(progress);
        },
      } : undefined;
      speaker.toggle(token.current, read.text, options);
      if (mounted.current && activeNow.current) {
        highlight.current = nextHighlight;
        activeRead.current = read;
        if (read.isCurrent && typeof globalThis.MutationObserver === "function") {
          const observer = new globalThis.MutationObserver(() => {
            if (activeRead.current === read && (!read.isCurrent() || !read.map.isCurrent())) speaker.stop();
          });
          observer.observe(read.map.root, { childList: true, characterData: true, subtree: true,
            attributes: true, attributeFilter: ['data-markdown-copy', 'data-codex-read-aloud-part',
              'data-codex-read-aloud-owner', 'data-codex-read-aloud-part-state',
              'data-codex-local-read-aloud', 'role', 'aria-hidden', 'hidden', 'inert', 'class', 'style'] });
          activeObserver.current = observer;
        }
      }
      else nextHighlight?.dispose();
    } catch {
      nextHighlight?.dispose();
      globalThis.alert("Could not read this response. Please try again.");
    }
  }

  async function beginRead(range = null, restart = false, captured = null) {
    if (!enabledNow.current) return;
    if (!restart && (activeNow.current || codexReadAloudSelection?.owner === token.current)) {
      if (codexReadAloudSelection?.owner === token.current) codexCancelReadAloudSelection();
      speaker.stop();
      return;
    }
    codexCancelReadAloudSelection();
    speaker.stop();
    let read;
    try {
      if (captured?.error) throw captured.error;
      read = captured ? captured.read : prepareRead(range);
    }
    catch (error) {
      globalThis.alert(error?.code === "CROSS_RESPONSE_SELECTION"
        ? "Select text within one answer to read a passage." : "Could not read this response. Please try again.");
      return;
    }
    if (!read) return;
    if (read.isCurrent && (!read.isCurrent() || !read.map.isCurrent())) {
      globalThis.alert("The response changed. Please read it again.");
      return;
    }
    const selection = {
      owner: token.current,
      cancel() {
        pendingRead.current = null;
        if (mounted.current) { setChecking(false); setPickerOpen(false); setNativeOffer(null); }
      },
    };
    codexReadAloudSelection = selection;
    setChecking(true);
    let settings;
    try {
      if (typeof bridge?.getVoices !== "function") throw new Error("Local read-aloud is unavailable.");
      settings = await bridge.getVoices();
    } catch (error) {
      if (!mounted.current || codexReadAloudSelection !== selection) return;
      setChecking(false);
      if (codexVoiceHelperUnavailable(error)) {
        pendingRead.current = read;
        setNativeOffer({ selection, read });
      } else {
        codexCancelReadAloudSelection();
        globalThis.alert("Could not load local voices. Please try again.");
      }
      return;
    }
    if (!mounted.current || codexReadAloudSelection !== selection) return;
    setChecking(false);
    if (!codexValidVoiceSettings(settings)) {
      codexCancelReadAloudSelection();
      globalThis.alert("Could not load local voices. Please try again.");
    } else if (settings.selectedVoice !== null) {
      codexReadAloudSelection = null;
      startRead(read);
    } else {
      pendingRead.current = read;
      setPickerOpen(true);
    }
  }

  function useMacVoice(event, offer) {
    event.stopPropagation();
    if (!mounted.current || !offer || codexReadAloudSelection !== offer.selection ||
        pendingRead.current !== offer.read) return;
    const read = offer.read;
    codexCancelReadAloudSelection();
    startRead(read, "native");
  }

  function dismissMacVoice(event, offer) {
    event.stopPropagation();
    if (offer && codexReadAloudSelection === offer.selection) codexCancelReadAloudSelection();
  }

  function captureBeforeFocus(event) {
    if (event.type === "pointerdown" || event.button && event.button !== 0) capturedRead.current = null;
    if (event.button && event.button !== 0) return;
    const selection = globalThis.document?.getSelection?.();
    const root = rootGetter.current?.();
    let owned = false;
    try { owned = selection?.rangeCount && codexRangeBelongsToResponse(root, selection.getRangeAt(0), textRoots()); }
    catch { /* A stale group cannot capture a broader selection. */ }
    if (!owned) {
      if (codexRangeIntersectsResponse(root, selection?.rangeCount ? selection.getRangeAt(0) : null)) {
        capturedRead.current = { error: codexSelectionBoundaryError() };
      }
      if (event.type === "mousedown" && capturedRead.current) event.preventDefault();
      return;
    }
    try { capturedRead.current = { read: prepareRead(selection.getRangeAt(0).cloneRange()) }; }
    catch { /* The click handler reports an unavailable selection. */ }
    if (event.type === "mousedown") event.preventDefault();
  }

  function readResponse(event) {
    event.stopPropagation();
    const captured = event.detail === 0 ? null : capturedRead.current;
    capturedRead.current = null;
    return beginRead(null, false, captured);
  }

  const busy = active || checking || nativeOffer !== null;
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
  const controls = enabled ? Y.jsxs(Y.Fragment, { children: [readButton, voiceButton] }) : null;
  // Rendering text, registering speech, and placing controls have independent
  // lifetimes. In particular, progress prose needs selection reading without a
  // permanent second toolbar. Dialogs must survive that visual choice.
  return Y.jsxs(Y.Fragment, {
    children: [renderContent ? renderContent(controls) : controls,
      selectionOnly && busy ? Y.jsx("div", {
        role: "status", "data-codex-local-read-aloud": "selection-status",
        style: { position: "fixed", right: 24, bottom: 96, zIndex: 1000 },
        children: Y.jsx("button", {
          type: "button", "aria-label": "Stop reading aloud", title: "Stop reading aloud (Esc)",
          "data-codex-local-read-aloud": "selection-stop",
          className: "rounded-full border px-3 py-2 shadow-lg",
          style: { background: "var(--color-token-main-surface-primary, Canvas)", color: "inherit" },
          onClick: stopReading, children: "Stop reading aloud",
        }),
      }) : null, pickerOpen ? Y.jsx(CodexReadAloudVoicePicker, {
      bridge, speaker, onClose: closePicker,
      onChosen: () => {
        const read = pendingRead.current;
        pendingRead.current = null;
        if (codexReadAloudSelection?.owner === token.current) codexReadAloudSelection = null;
        if (mounted.current && read) startRead(read);
      },
    }) : null, nativeOffer ? Y.jsxs("span", {
      role: "alert", "data-codex-local-read-aloud": "native-status",
      className: "inline-flex items-center gap-2 text-xs",
      children: [
        Y.jsx("span", { children: "Local speech is unavailable." }),
        Y.jsx("button", { type: "button", className: "rounded px-2 py-1 underline",
          "data-codex-local-read-aloud": "use-native", onClick: event => useMacVoice(event, nativeOffer),
          children: "Use Mac voice" }),
        Y.jsx("button", { type: "button", className: "rounded px-2 py-1 underline",
          "data-codex-local-read-aloud": "dismiss-native", onClick: event => dismissMacVoice(event, nativeOffer),
          children: "Dismiss" }),
      ],
    }) : null],
  });
}
