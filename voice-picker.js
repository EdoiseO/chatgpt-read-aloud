// Appended to the response toolbar bundle; Fo and Y are its React/JSX bindings.
function CodexReadAloudVoicePicker({ bridge, speaker, onClose, onChosen }) {
  const React = Fo();
  const [voices, setVoices] = React.useState([]);
  const [draft, setDraft] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [previewActive, setPreviewActive] = React.useState(false);
  const dialog = React.useRef(null);
  const panel = React.useRef(null);
  const select = React.useRef(null);
  const mounted = React.useRef(false);
  const subscription = React.useRef(null);
  const previewKey = React.useRef(null);
  if (previewKey.current === null) previewKey.current = Symbol("voice-preview");
  const labelId = React.useId();
  const selectId = React.useId();

  React.useEffect(() => {
    mounted.current = true;
    const previousFocus = globalThis.document?.activeElement;
    const modal = dialog.current;
    try { if (typeof modal?.showModal === "function" && !modal.open) modal.showModal(); } catch { /* The fixed overlay remains usable. */ }
    panel.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      // The manager's unsubscribe stops only this preview if it is still active.
      subscription.current?.();
      subscription.current = null;
      try { if (modal?.open) modal.close?.(); } catch { /* It may already be detached. */ }
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    };
  }, []);

  React.useEffect(() => {
    subscription.current = speaker.subscribe(previewKey.current, active => {
      if (mounted.current) setPreviewActive(active);
    });
    return () => {
      subscription.current?.();
      subscription.current = null;
    };
  }, [speaker]);

  React.useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const result = await bridge.getVoices();
        if (canceled) return;
        if (!Array.isArray(result?.voices)) throw new Error("Voice list unavailable");
        const available = result.voices.filter(voice => voice && typeof voice.id === "string"
          && typeof voice.name === "string" && typeof voice.lang === "string");
        setVoices(available);
        setDraft(available.some(voice => voice.id === result.selectedVoice) ? result.selectedVoice : "");
        if (!available.length) setError("No voices are available. Close this window and try again.");
      } catch {
        if (!canceled) setError("Could not load voices. Close this window and try again.");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();
    return () => { canceled = true; };
  }, [bridge]);

  React.useEffect(() => {
    if (!loading && globalThis.document?.activeElement === panel.current) {
      select.current?.focus({ preventScroll: true });
    }
  }, [loading]);

  function close(event) {
    event?.stopPropagation();
    subscription.current?.();
    subscription.current = null;
    onClose();
  }

  function changeVoice(event) {
    event.stopPropagation();
    // Unsubscribe/re-subscribe is an exact-key cancellation. A response playing
    // outside this picker is left alone, including when preview state is stale.
    subscription.current?.();
    subscription.current = speaker.subscribe(previewKey.current, active => {
      if (mounted.current) setPreviewActive(active);
    });
    setDraft(event.target.value);
    setError("");
  }

  function preview(event) {
    event.stopPropagation();
    if (!draft || loading || saving) return;
    setError("");
    try {
      speaker.toggle(previewKey.current,
        "This is a preview of your reading voice. You can choose the sound you prefer.",
        { voice: draft, fallback: false });
    } catch {
      setError("Could not preview this voice. Try another voice.");
    }
  }

  async function save(event) {
    event.stopPropagation();
    if (!draft || loading || saving) return;
    setSaving(true);
    setError("");
    try {
      speaker.stop();
      const result = await bridge.setVoice(draft);
      if (!mounted.current) return;
      if (result?.selectedVoice !== draft) throw new Error("Voice was not saved");
      onChosen?.({ selectedVoice: result.selectedVoice });
      close();
    } catch {
      if (mounted.current) setError("Could not save your voice. Please try again.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function keyDown(event) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...panel.current.querySelectorAll("button:not(:disabled),select:not(:disabled),[tabindex='0']")];
    if (!focusable.length) { event.preventDefault(); panel.current.focus(); return; }
    const index = focusable.indexOf(globalThis.document.activeElement);
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
    }
  }

  const disabled = loading || saving;
  const buttonStyle = {
    border: "1px solid #555", borderRadius: 8, padding: "8px 12px",
    font: "inherit", color: "#f5f5f5", background: "#333", cursor: "pointer",
  };
  return Y.jsx(typeof globalThis.HTMLDialogElement === "function" ? "dialog" : "div", {
    ref: dialog,
    role: "dialog", "aria-modal": true, "aria-labelledby": labelId,
    style: { position: "fixed", inset: 0, zIndex: 100000, background: "rgba(0,0,0,.55)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      margin: 0, border: 0, width: "100vw", height: "100vh", maxWidth: "none", maxHeight: "none", boxSizing: "border-box" },
    onCancel: event => { event.preventDefault(); close(event); },
    onPointerDown: event => event.stopPropagation(),
    onClick: event => { event.stopPropagation(); if (event.target === event.currentTarget) close(); },
    onKeyDown: keyDown,
    children: Y.jsxs("div", {
      ref: panel,
      "aria-busy": loading || saving, tabIndex: -1,
      style: { width: 340, maxWidth: "100%", boxSizing: "border-box", borderRadius: 14,
        padding: 20, background: "#242424", color: "#f5f5f5", border: "1px solid #555",
        boxShadow: "0 12px 48px rgba(0,0,0,.4)", fontSize: 14, lineHeight: 1.5 },
      children: [
        Y.jsxs("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 },
          children: [
            Y.jsx("h2", { id: labelId, style: { fontSize: 18, fontWeight: 600, margin: 0 }, children: "Choose a voice" }),
            Y.jsx("button", { type: "button", "aria-label": "Close voice picker", onClick: close,
              style: { ...buttonStyle, padding: "4px 9px", fontSize: 18 }, children: "×" }),
          ],
        }),
        Y.jsx("label", { htmlFor: selectId, style: { display: "block", marginBottom: 6 }, children: "Reading voice" }),
        Y.jsxs("select", {
          ref: select, id: selectId, value: draft, disabled: disabled || !voices.length, onChange: changeVoice,
          style: { width: "100%", boxSizing: "border-box", padding: "9px 8px", borderRadius: 8,
            border: "1px solid #666", background: "#303030", color: "#f5f5f5", font: "inherit" },
          children: [
            Y.jsx("option", { value: "", disabled: true, children: loading ? "Loading voices…" : "Choose a voice" }),
            ...voices.map(voice => Y.jsx("option", {
              value: voice.id, children: `${voice.name} (${voice.lang})`,
            }, voice.id)),
          ],
        }),
        Y.jsx("p", { style: { color: "#bdbdbd", margin: "10px 0 16px" }, children: "Preview a voice, then save it for reading responses aloud." }),
        error ? Y.jsx("p", { role: "alert", style: { color: "#ffb4a9", margin: "0 0 12px" }, children: error }) : null,
        Y.jsxs("div", {
          style: { display: "flex", justifyContent: "space-between", gap: 10 },
          children: [
            Y.jsx("button", { type: "button", disabled: disabled || !draft, onClick: preview,
              "aria-pressed": previewActive,
              style: { ...buttonStyle, opacity: disabled || !draft ? .5 : 1 },
              children: previewActive ? "Stop preview" : "Preview" }),
            Y.jsx("button", { type: "button", disabled: disabled || !draft, onClick: save,
              style: { ...buttonStyle, background: "#f0f0f0", color: "#202020", opacity: disabled || !draft ? .5 : 1 },
              children: saving ? "Saving…" : "Use this voice" }),
          ],
        }),
      ],
    }),
  });
}
