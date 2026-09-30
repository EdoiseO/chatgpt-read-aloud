// The bridge returns a WAV chunk, an explicit skipped sentence, or { done: true }.
// createAudio receives a data URL and returns an HTMLAudio-like object. An
// adapter that uses a Blob URL can expose dispose() to revoke that URL.
export function createKokoroResponseSpeaker({ backend, createAudio, fallback, onError = () => {} }) {
  const listeners = new Map();
  const canceled = Symbol("canceled speech request");
  const prefix = globalThis.crypto?.randomUUID?.()
    ?? `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let current = null;

  function notify() {
    for (const [key, callback] of listeners) callback(current?.key === key);
  }

  function isCurrent(request) {
    return current === request && request.active;
  }

  function progress(request, range, stopping = false) {
    if (!stopping && (!isCurrent(request) || request.mode !== "kokoro")) return;
    if (range === null && request.progress === null) return;
    if (range && request.progress?.start === range.start && request.progress?.end === range.end) return;
    request.progress = range;
    try { request.onProgress?.(range && { start: range.start, end: range.end }); } catch {
      // A view that has unmounted or failed must not interrupt audio cleanup.
    }
  }

  function boundarySafe(text, index) {
    if (index === 0 || index === text.length) return true;
    const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
    return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
  }

  function sentenceRanges(text, ranges) {
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 4096) {
      throw new Error("The response sentence ranges are invalid.");
    }
    let previousEnd = 0;
    const result = ranges.map(range => {
      const start = range?.start, end = range?.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < previousEnd || start >= end || end > text.length
          || !boundarySafe(text, start) || !boundarySafe(text, end)
          || /\S/u.test(text.slice(previousEnd, start)) || !/\S/u.test(text.slice(start, end))) {
        throw new Error("The response sentence ranges are invalid.");
      }
      previousEnd = end;
      return { start, end };
    });
    if (/\S/u.test(text.slice(previousEnd))) throw new Error("The response sentence ranges are invalid.");
    return result;
  }

  function chunkSentence(request, chunk, skipped = false) {
    if (!request.sentenceRanges) {
      if (skipped || chunk.sentenceStart !== undefined || chunk.sentenceEnd !== undefined) {
        throw new Error("The local speech helper returned invalid sentence progress.");
      }
      return null;
    }
    const start = chunk.sentenceStart, end = chunk.sentenceEnd;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new Error("The local speech helper returned invalid sentence progress.");
    }
    const index = request.sentenceIndexes.get(`${start}:${end}`);
    if (index === undefined || index < request.lastSentenceIndex || index > request.lastSentenceIndex + 1
        || (index === request.lastSentenceIndex && (skipped || request.lastSentenceSkipped))) {
      throw new Error("The local speech helper returned invalid sentence progress.");
    }
    request.lastSentenceIndex = index;
    request.lastSentenceSkipped = skipped;
    return request.sentenceRanges[index];
  }

  function cancelBackend(request) {
    if (request.native) return;
    if (request.cancelRequested) return;
    request.cancelRequested = true;
    try {
      Promise.resolve(backend?.cancel?.(request.id)).catch(() => {});
    } catch {
      // Stopping playback must remain immediate even if the helper has exited.
    }
  }

  function stop() {
    const request = current;
    current = null;
    if (request) {
      request.active = false;
      request.abort(canceled);
      request.releaseAudio?.(canceled);
      request.unsubscribeFallback?.();
      request.unsubscribeFallback = null;
      if (request.mode === "fallback") {
        try { fallback.stop(); } catch { /* The response is already inactive. */ }
      }
      progress(request, null, true);
      cancelBackend(request);
      request.text = "";
    }
    notify();
  }

  function finish(request) {
    if (isCurrent(request)) stop();
  }

  async function backendCall(request, call) {
    if (!isCurrent(request) || request.mode !== "kokoro") throw canceled;
    const operation = Promise.resolve().then(() => {
      // Stop/switch can happen before this microtask reaches the bridge.
      if (!isCurrent(request) || request.mode !== "kokoro") throw canceled;
      return call();
    });
    const result = await Promise.race([operation, request.aborted]);
    if (result === canceled || !isCurrent(request) || request.mode !== "kokoro") throw canceled;
    return result;
  }

  function playChunk(request, chunk) {
    if (!chunk || chunk.done !== false || chunk.skipped !== undefined || typeof chunk.audioBase64 !== "string" || !chunk.audioBase64) {
      throw new Error("The local speech helper returned no audio.");
    }
    if (chunk.mimeType != null && chunk.mimeType !== "audio/wav") {
      throw new Error("The local speech helper returned an unsupported audio format.");
    }
    const range = chunkSentence(request, chunk);
    const audio = createAudio(`data:audio/wav;base64,${chunk.audioBase64}`);
    if (!audio || typeof audio.play !== "function" || typeof audio.pause !== "function") {
      throw new Error("Audio playback is unavailable in this app.");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = error => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        if (request.releaseAudio === release) request.releaseAudio = null;
        progress(request, null);
        try { audio.pause(); } catch { /* Continue releasing the source. */ }
        try {
          if (typeof audio.removeAttribute === "function") audio.removeAttribute("src");
          else audio.src = "";
          audio.load?.();
        } catch { /* A stopped or failed audio object may reject load(). */ }
        try { audio.dispose?.(); } catch { /* Optional Blob URL cleanup. */ }
        if (error) reject(error);
        else resolve();
      };
      request.releaseAudio = release;
      const playing = () => {
        if (!settled && isCurrent(request) && request.mode === "kokoro") {
          request.played = true;
          if (range) progress(request, range);
        }
      };
      audio.onplaying = playing;
      audio.onended = () => {
        if (!isCurrent(request)) { release(canceled); return; }
        // An ended event is also proof of playback if play() resolved late.
        request.played = true;
        release();
      };
      audio.onerror = () => release(new Error("Unable to play the generated local speech."));
      try {
        const started = audio.play();
        Promise.resolve(started).then(() => {
          // A resolved HTMLMediaElement.play() promise proves playback started.
          // Legacy void returns rely on the real playing event instead.
          if (started && typeof started.then === "function") playing();
        }, error => release(error instanceof Error ? error : new Error(String(error))));
      } catch (error) {
        release(error);
      }
    });
  }

  function startFallback(request, originalError) {
    cancelBackend(request);
    request.abort(canceled);
    request.releaseAudio?.(canceled);
    progress(request, null);
    if (!fallback || typeof fallback.toggle !== "function" || typeof fallback.subscribe !== "function"
        || typeof fallback.stop !== "function") {
      finish(request);
      onError("Unable to read this response aloud: " + (originalError?.message ?? String(originalError)));
      return;
    }
    request.mode = "fallback";
    let starting = true;
    let lastActive = null;
    try {
      request.unsubscribeFallback = fallback.subscribe(request.id, active => {
        lastActive = active;
        if (!isCurrent(request) || request.mode !== "fallback" || starting) return;
        if (!active) finish(request);
      });
      // The existing speech controller emits false while canceling its previous
      // response, then true for this one. Ignore that synchronous transition.
      fallback.toggle(request.id, request.text);
      starting = false;
      if (lastActive === false) finish(request);
    } catch (error) {
      starting = false;
      finish(request);
      onError("Unable to read this response aloud: " + (error?.message ?? String(error)));
    }
  }

  async function speak(request) {
    try {
      if (request.hasSentenceRanges) {
        request.sentenceRanges = sentenceRanges(request.text, request.rangesInput);
        request.rangesInput = null;
        request.sentenceIndexes = new Map(request.sentenceRanges.map((range, index) => [`${range.start}:${range.end}`, index]));
      }
      if (request.native) { startFallback(request, new Error("Native speech is unavailable.")); return; }
      if (!backend || typeof backend.start !== "function" || typeof backend.next !== "function"
          || typeof createAudio !== "function") {
        throw new Error("The local speech helper is unavailable.");
      }
      let chunk = await backendCall(request, () => {
        const options = {};
        if (request.voice !== undefined) options.voice = request.voice;
        if (request.sentenceRanges) options.sentenceRanges = request.sentenceRanges.map(range => ({ ...range }));
        return Object.keys(options).length
          ? backend.start(request.id, request.text, options)
          : backend.start(request.id, request.text);
      });
      while (isCurrent(request) && request.mode === "kokoro") {
        if (chunk?.done === true) {
          if (chunk.skipped !== undefined || chunk.audioBase64 !== undefined || chunk.mimeType !== undefined ||
              chunk.sentenceStart !== undefined || chunk.sentenceEnd !== undefined ||
              (request.sentenceRanges && request.lastSentenceIndex !== request.sentenceRanges.length - 1)) {
            throw new Error("The local speech helper returned incomplete sentence progress.");
          }
          finish(request); return;
        }
        if (chunk?.skipped === true) {
          if (chunk.done !== false || chunk.audioBase64 !== undefined || chunk.mimeType !== undefined) {
            throw new Error("The local speech helper returned invalid silent sentence progress.");
          }
          // Every skip consumes exactly the next approved range. This bounds
          // no-audio traversal by the validated range count (at most 4096).
          chunkSentence(request, chunk, true);
          chunk = await backendCall(request, () => backend.next(request.id));
          continue;
        }
        const finished = playChunk(request, chunk);
        chunk = null;
        // Keep exactly one chunk ahead. Promise.all attaches a rejection handler
        // immediately, including when synthesis fails before playback ends.
        const prefetched = backendCall(request, () => backend.next(request.id));
        const results = await Promise.all([finished, prefetched]);
        if (!isCurrent(request) || request.mode !== "kokoro") return;
        chunk = results[1];
      }
    } catch (error) {
      if (error === canceled || !isCurrent(request) || request.mode !== "kokoro") return;
      if (!request.played && request.allowFallback) startFallback(request, error);
      else {
        finish(request);
        const message = request.played ? "Unable to continue reading this response aloud: " : "Unable to read this response aloud: ";
        onError(message + (error?.message ?? String(error)));
      }
    }
  }

  return {
    stop,
    interrupt(requestId) {
      // Another window may replace this helper request. Its notification can
      // arrive after this window has already started a different response.
      if (current && current.id === requestId) stop();
    },
    toggle(key, text, options = {}) {
      if (current?.key === key) { stop(); return; }
      stop();
      const hasSentenceRanges = options?.sentenceRanges !== undefined;
      const input = String(text ?? "");
      const readable = hasSentenceRanges ? input : input.trim();
      if (!readable.trim()) return;
      let abort;
      const aborted = new Promise(resolve => { abort = resolve; });
      const request = {
        id: `${prefix}-${++sequence}`, key, text: readable, voice: options?.voice, active: true,
        allowFallback: options?.fallback !== false,
        mode: "kokoro", native: options?.mode === "native", played: false, cancelRequested: false,
        aborted, abort, releaseAudio: null, unsubscribeFallback: null,
        hasSentenceRanges, rangesInput: options?.sentenceRanges, sentenceRanges: null,
        sentenceIndexes: null, lastSentenceIndex: -1, lastSentenceSkipped: false,
        onProgress: typeof options?.onProgress === "function" ? options.onProgress : null,
        progress: undefined,
      };
      current = request;
      notify();
      void speak(request);
    },
    subscribe(key, callback) {
      listeners.set(key, callback);
      callback(current?.key === key);
      return () => {
        listeners.delete(key);
        if (current?.key === key) stop();
      };
    },
  };
}
