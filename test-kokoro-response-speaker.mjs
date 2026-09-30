import assert from "node:assert/strict";
import test from "node:test";
import { createKokoroResponseSpeaker } from "./kokoro-response-speaker.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const chunk = name => ({ done: false, audioBase64: Buffer.from(name).toString("base64"), mimeType: "audio/wav" });

function fixture({ playback = "success", withFallback = true, cancelError = false, audioFactoryError = false } = {}) {
  const starts = [], nexts = [], cancellations = [], audios = [], errors = [];
  const statesA = [], statesB = [];
  const fallbackCalls = [], fallbackSubscriptions = new Map();
  let fallbackKey = null;
  let fallbackStops = 0;
  const backend = {
    start(id, text, options) {
      const job = { id, text, options, argumentCount: arguments.length, ...deferred() };
      starts.push(job);
      return job.promise;
    },
    next(id) {
      const job = { id, ...deferred() };
      nexts.push(job);
      return job.promise;
    },
    cancel(id) {
      cancellations.push(id);
      return cancelError ? Promise.reject(new Error("helper exited")) : Promise.resolve();
    },
  };
  function notifyFallback() {
    for (const [key, callback] of fallbackSubscriptions) callback(fallbackKey === key);
  }
  const fallback = {
    subscribe(key, callback) {
      fallbackSubscriptions.set(key, callback);
      callback(fallbackKey === key);
      return () => fallbackSubscriptions.delete(key);
    },
    toggle(key, text) {
      fallbackCalls.push({ key, text });
      fallbackKey = null;
      notifyFallback();
      fallbackKey = key;
      notifyFallback();
    },
    stop() {
      fallbackStops++;
      fallbackKey = null;
      notifyFallback();
    },
  };
  const speaker = createKokoroResponseSpeaker({
    backend, fallback: withFallback ? fallback : null,
    createAudio(src) {
      if (audioFactoryError) throw new Error("audio constructor failed");
      const started = deferred();
      const audio = {
        src, source: src, playCalls: 0, pauseCalls: 0, loadCalls: 0, disposeCalls: 0,
        started,
        play() {
          this.playCalls++;
          if (playback === "pending") return started.promise;
          if (playback === "void") return;
          if (playback === "reject") return Promise.reject(new Error("playback denied"));
          if (playback === "throw") throw new Error("playback threw");
          this.onplaying?.();
          return Promise.resolve();
        },
        pause() { this.pauseCalls++; },
        removeAttribute(name) { if (name === "src") this.src = ""; },
        load() { this.loadCalls++; },
        dispose() { this.disposeCalls++; },
      };
      audios.push(audio);
      return audio;
    },
    onError: message => errors.push(message),
  });
  const keyA = Symbol("response A"), keyB = Symbol("response B");
  const unsubscribeA = speaker.subscribe(keyA, active => statesA.push(active));
  const unsubscribeB = speaker.subscribe(keyB, active => statesB.push(active));
  return {
    speaker, backend, fallback, keyA, keyB, starts, nexts, cancellations, audios,
    errors, statesA, statesB, unsubscribeA, unsubscribeB, fallbackCalls, fallbackSubscriptions,
    endFallback() { fallbackKey = null; notifyFallback(); },
    get fallbackStops() { return fallbackStops; },
  };
}

test("loading becomes active immediately; stopping before dispatch makes no backend request", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  assert.equal(f.statesA.at(-1), true);
  f.speaker.toggle(f.keyA, "Response A.");
  assert.equal(f.statesA.at(-1), false);
  await settle();
  assert.equal(f.starts.length, 0);
  assert.equal(f.audios.length, 0);
  assert.equal(f.cancellations.length, 1);
});

test("a stopped pending generation cannot create or play audio when it finishes", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  assert.equal(f.starts.length, 1);
  f.speaker.stop();
  f.starts[0].resolve(chunk("late A"));
  await settle();
  assert.equal(f.audios.length, 0);
  assert.equal(f.nexts.length, 0);
  assert.equal(f.statesA.at(-1), false);
  assert.deepEqual(f.errors, []);
  assert.equal(f.fallbackCalls.length, 0);
});

test("switching while A loads ignores A's late rejection and reads only B", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.speaker.toggle(f.keyB, "Response B.");
  await settle();
  assert.notEqual(f.starts[0].id, f.starts[1].id);
  f.starts[0].reject(new Error("old helper error"));
  f.starts[1].resolve(chunk("B"));
  await settle();
  assert.equal(f.audios.length, 1);
  assert.equal(f.audios[0].source, "data:audio/wav;base64," + chunk("B").audioBase64);
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.statesB.at(-1), true);
  assert.equal(f.fallbackCalls.length, 0);
  assert.deepEqual(f.errors, []);
  f.speaker.stop();
});

test("one chunk is prefetched while playing and each chunk plays in original order", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "A longer response.");
  await settle();
  f.starts[0].resolve(chunk("first"));
  await settle();
  assert.equal(f.audios.length, 1);
  assert.equal(f.nexts.length, 1, "prefetch starts before audio ends");
  f.nexts[0].resolve(chunk("second"));
  await settle();
  assert.equal(f.audios.length, 1, "prefetch must not interrupt the current chunk");
  assert.equal(f.nexts.length, 1, "there must not be a second queued prefetch");
  f.audios[0].onended();
  await settle();
  assert.equal(f.audios.length, 2);
  assert.equal(f.nexts.length, 2);
  assert.equal(f.audios[1].source, "data:audio/wav;base64," + chunk("second").audioBase64);
  f.nexts[1].resolve({ done: true });
  await settle();
  assert.equal(f.statesA.at(-1), true, "done from helper does not cut off the final audio");
  f.audios[1].onended();
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.audios.length, 2);
  for (const audio of f.audios) {
    assert.equal(audio.src, "");
    assert.equal(audio.disposeCalls, 1);
    assert.equal(audio.loadCalls, 1);
  }
  assert.deepEqual(f.errors, []);
});

test("switching active audio stops it immediately and ignores callbacks and prefetch from A", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  const oldAudio = f.audios[0];
  const lateEnd = oldAudio.onended, lateError = oldAudio.onerror;
  const oldNext = f.nexts[0];
  f.speaker.toggle(f.keyB, "Response B.");
  assert.equal(oldAudio.pauseCalls, 1);
  assert.equal(oldAudio.src, "");
  assert.equal(oldAudio.disposeCalls, 1);
  await settle();
  f.starts[1].resolve(chunk("B"));
  oldNext.resolve(chunk("old next A"));
  lateEnd();
  lateError();
  await settle();
  assert.equal(f.audios.length, 2);
  assert.equal(f.statesB.at(-1), true);
  assert.equal(f.audios[1].pauseCalls, 0);
  assert.equal(f.cancellations.filter(id => id === f.starts[1].id).length, 0);
  assert.deepEqual(f.errors, []);
  assert.equal(f.fallbackCalls.length, 0);
  f.speaker.stop();
});

test("stopping while a prefetch is pending ignores its late rejection", async () => {
  const f = fixture({ cancelError: true });
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  const oldEnd = f.audios[0].onended;
  f.speaker.stop();
  f.nexts[0].reject(new Error("late prefetch error"));
  oldEnd();
  await settle();
  assert.equal(f.audios.length, 1);
  assert.equal(f.statesA.at(-1), false);
  assert.deepEqual(f.errors, []);
});

test("unmounting the active response cancels pending generation and removes its listener", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  const priorStates = f.statesA.length;
  f.unsubscribeA();
  f.starts[0].resolve(chunk("late A"));
  await settle();
  assert.equal(f.statesA.length, priorStates);
  assert.equal(f.audios.length, 0);
  assert.equal(f.cancellations.length, 1);
  f.speaker.toggle(f.keyB, "Response B.");
  assert.equal(f.statesB.at(-1), true);
  assert.equal(f.statesA.length, priorStates);
  f.speaker.stop();
});

test("unmounting an inactive response leaves the current response playing", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyB, "Response B.");
  await settle();
  f.starts[0].resolve(chunk("B"));
  await settle();
  f.unsubscribeA();
  assert.equal(f.audios[0].pauseCalls, 0);
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.statesB.at(-1), true);
  f.speaker.stop();
});

test("helper failure before audio uses Apple fallback once and tracks its completion", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "The exact response text.");
  await settle();
  f.starts[0].reject(new Error("helper unavailable"));
  await settle();
  assert.equal(f.fallbackCalls.length, 1);
  assert.equal(f.fallbackCalls[0].text, "The exact response text.");
  assert.equal(f.statesA.at(-1), true, "fallback's initial false callback must not clear active state");
  assert.equal(f.audios.length, 0);
  f.endFallback();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.fallbackSubscriptions.size, 0);
  assert.deepEqual(f.errors, []);
});

test("a play rejection or throw before playback falls back without double reading", async () => {
  for (const playback of ["reject", "throw"]) {
    const f = fixture({ playback });
    f.speaker.toggle(f.keyA, "Response A.");
    await settle();
    f.starts[0].resolve(chunk("A"));
    await settle();
    assert.equal(f.fallbackCalls.length, 1);
    assert.equal(f.audios[0].src, "");
    assert.equal(f.audios[0].pauseCalls, 1);
    assert.equal(f.statesA.at(-1), true);
    f.speaker.stop();
    assert.equal(f.statesA.at(-1), false);
    assert.equal(f.fallbackStops, 1);
  }
});

test("prefetch failure after playback starts stops and reports instead of rereading through fallback", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  f.nexts[0].reject(new Error("next batch failed"));
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.audios[0].pauseCalls, 1);
  assert.equal(f.fallbackCalls.length, 0);
  assert.deepEqual(f.errors, ["Unable to continue reading this response aloud: next batch failed"]);
});

test("prefetch failure before play starts can fall back and a late play promise cannot restart it", async () => {
  const f = fixture({ playback: "pending" });
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  f.nexts[0].reject(new Error("next batch failed before playback"));
  await settle();
  assert.equal(f.fallbackCalls.length, 1);
  assert.equal(f.audios[0].pauseCalls, 1);
  f.audios[0].started.resolve();
  await settle();
  assert.equal(f.audios[0].playCalls, 1);
  assert.equal(f.statesA.at(-1), true);
  f.speaker.stop();
});

test("a media error after playback starts clears state without automatic fallback", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  f.audios[0].onerror();
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.fallbackCalls.length, 0);
  assert.deepEqual(f.errors, ["Unable to continue reading this response aloud: Unable to play the generated local speech."]);
});

test("switching from fallback removes its subscription and its stale callback cannot stop B", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].reject(new Error("helper unavailable"));
  await settle();
  const oldCallback = [...f.fallbackSubscriptions.values()][0];
  f.speaker.toggle(f.keyB, "Response B.");
  assert.equal(f.fallbackStops, 1);
  assert.equal(f.fallbackSubscriptions.size, 0);
  await settle();
  f.starts[1].resolve(chunk("B"));
  await settle();
  oldCallback(false);
  oldCallback(true);
  assert.equal(f.statesB.at(-1), true);
  assert.equal(f.audios[0].pauseCalls, 0);
  f.speaker.stop();
});

test("unmounting active fallback stops it and removes subscriptions", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].reject(new Error("helper unavailable"));
  await settle();
  const count = f.statesA.length;
  f.unsubscribeA();
  assert.equal(f.fallbackStops, 1);
  assert.equal(f.fallbackSubscriptions.size, 0);
  assert.equal(f.statesA.length, count);
});

test("empty text stays idle and stops an existing response", async () => {
  const f = fixture();
  for (const empty of ["", " \n\t ", null, undefined]) f.speaker.toggle(f.keyA, empty);
  await settle();
  assert.equal(f.starts.length, 0);
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.speaker.toggle(f.keyB, "   ");
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.statesB.at(-1), false);
  assert.equal(f.cancellations.length, 1);
});

test("no fallback reports a helper error once and remains reusable", async () => {
  const f = fixture({ withFallback: false });
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].reject(new Error("helper unavailable"));
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.deepEqual(f.errors, ["Unable to read this response aloud: helper unavailable"]);
  f.speaker.toggle(f.keyB, "Response B.");
  assert.equal(f.statesB.at(-1), true);
  f.speaker.stop();
});

test("an invalid helper chunk or audio constructor failure uses fallback before playback", async () => {
  for (const badChunk of [{ done: false }, { done: false, audioBase64: "YWJj", mimeType: "text/html" }]) {
    const f = fixture();
    f.speaker.toggle(f.keyA, "Response A.");
    await settle();
    f.starts[0].resolve(badChunk);
    await settle();
    assert.equal(f.fallbackCalls.length, 1);
    assert.equal(f.audios.length, 0);
    f.speaker.stop();
  }
  const f = fixture({ audioFactoryError: true });
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve(chunk("A"));
  await settle();
  assert.equal(f.fallbackCalls.length, 1);
  f.speaker.stop();
});

test("done before any audio finishes quietly without fallback or prefetch", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.starts[0].resolve({ done: true });
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.audios.length, 0);
  assert.equal(f.nexts.length, 0);
  assert.equal(f.fallbackCalls.length, 0);
  assert.deepEqual(f.errors, []);
});

test("missing helper starts fallback while retaining the response's active state", async () => {
  const f = fixture();
  f.backend.start = null;
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  assert.equal(f.fallbackCalls.length, 1);
  assert.equal(f.statesA.at(-1), true);
  f.speaker.stop();
});

test("cross-window interruption stops only its matching current request", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  const requestA = f.starts[0].id;
  f.starts[0].resolve(chunk("A"));
  await settle();
  f.speaker.interrupt("an unrelated request");
  assert.equal(f.statesA.at(-1), true);
  assert.equal(f.audios[0].pauseCalls, 0);
  assert.equal(f.cancellations.length, 0);

  f.speaker.toggle(f.keyB, "Response B.");
  await settle();
  const requestB = f.starts[1].id;
  f.starts[1].resolve(chunk("B"));
  await settle();
  f.speaker.interrupt(requestA);
  assert.equal(f.statesB.at(-1), true, "a delayed interruption for A must not stop B");
  assert.equal(f.audios[1].pauseCalls, 0);
  assert.equal(f.cancellations.filter(id => id === requestB).length, 0);

  f.speaker.interrupt(requestB);
  assert.equal(f.statesB.at(-1), false);
  assert.equal(f.audios[1].pauseCalls, 1);
  assert.equal(f.cancellations.filter(id => id === requestB).length, 1);
  const idleNotifications = f.statesB.length;
  f.speaker.interrupt(requestB);
  f.speaker.interrupt(undefined);
  assert.equal(f.cancellations.filter(id => id === requestB).length, 1, "repeated or empty events are harmless");
  assert.equal(f.statesB.length, idleNotifications, "unmatched idle events must be no-ops");
  f.nexts[1].resolve(chunk("late B"));
  await settle();
  assert.equal(f.audios.length, 2);
  assert.deepEqual(f.errors, []);
});

test("matching cross-window interruption cancels a request still waiting for first audio", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  await settle();
  f.speaker.interrupt(f.starts[0].id);
  assert.equal(f.statesA.at(-1), false);
  f.starts[0].resolve(chunk("late first chunk"));
  await settle();
  assert.equal(f.audios.length, 0);
  assert.equal(f.fallbackCalls.length, 0);
});

test("preview voice is captured per request and normal responses leave saved voice selection to the helper", async () => {
  const f = fixture();
  const selection = { voice: "af_bella" };
  f.speaker.toggle(f.keyA, "Preview voice A.", selection);
  selection.voice = "bf_emma";
  await settle();
  assert.deepEqual(f.starts[0].options, { voice: "af_bella" }, "changing picker state must not change an already-started preview");
  f.starts[0].resolve(chunk("Bella preview"));
  await settle();
  assert.equal(f.nexts[0].id, f.starts[0].id, "prefetch remains attached to the original voice request");

  f.speaker.toggle(f.keyB, "Preview voice B.", selection);
  selection.voice = "af_heart";
  await settle();
  assert.deepEqual(f.starts[1].options, { voice: "bf_emma" });
  f.starts[1].resolve(chunk("Emma preview"));
  f.nexts[0].resolve(chunk("late Bella preview"));
  await settle();
  assert.equal(f.audios.length, 2, "the old preview must not continue after choosing another voice");
  assert.equal(f.audios[1].source, "data:audio/wav;base64," + chunk("Emma preview").audioBase64);

  f.speaker.toggle(f.keyA, "An ordinary response without a preview override.");
  await settle();
  assert.equal(f.starts[2].options, undefined, "normal responses must use the helper's saved voice, without a hardcoded default");
  assert.equal(f.starts[2].argumentCount, 2, "legacy callers keep the original start arity");
  f.speaker.stop();
});

test("a failed voice preview must not play an Apple fallback that misrepresents the selected voice", async () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Preview the selected voice.", { voice: "bf_emma", fallback: false });
  await settle();
  f.starts[0].reject(new Error("voice preview unavailable"));
  await settle();
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.fallbackCalls.length, 0);
  assert.deepEqual(f.errors, ["Unable to read this response aloud: voice preview unavailable"]);

  f.speaker.toggle(f.keyB, "An ordinary response.");
  await settle();
  f.starts[1].reject(new Error("helper unavailable"));
  await settle();
  assert.equal(f.fallbackCalls.length, 1, "normal response fallback remains available after a failed preview");
  f.speaker.stop();
});

const rangedChunk = (name, range) => ({ ...chunk(name), sentenceStart: range.start, sentenceEnd: range.end });

test("ranged requests preserve exact UTF-16 text and snapshot ranges without overriding the saved voice", async () => {
  const f = fixture({ playback: "pending" });
  const text = "  😀 First. \nSecond.  ";
  const ranges = [
    { start: 2, end: text.indexOf(" \n") },
    { start: text.indexOf("Second"), end: text.indexOf("Second") + "Second.".length },
  ];
  const expected = ranges.map(range => ({ ...range }));
  const progress = [];
  f.speaker.toggle(f.keyA, text, { sentenceRanges: ranges, onProgress: value => progress.push(value) });
  ranges[0].start = 0;
  ranges.push({ start: 0, end: 1 });
  await settle();
  assert.equal(f.starts[0].text, text, "trimming would shift sentence offsets");
  assert.deepEqual(f.starts[0].options, { sentenceRanges: expected });
  assert.equal(f.starts[0].argumentCount, 3);
  assert.deepEqual(progress, [], "synthesis does not highlight text");
  // Mutating an adapter's received options must not corrupt internal validation.
  f.starts[0].options.sentenceRanges[0].start = 99;
  f.starts[0].resolve(rangedChunk("first", expected[0]));
  await settle();
  f.audios[0].onplaying();
  assert.deepEqual(progress, [expected[0]]);
  f.speaker.stop();
  assert.deepEqual(progress, [expected[0], null]);
});

test("progress follows actual playback, not synthesis or prefetch, and clears between chunks and at completion", async () => {
  const f = fixture({ playback: "pending" });
  const text = "First. Second.";
  const ranges = [{ start: 0, end: 6 }, { start: 7, end: text.length }];
  const progress = [];
  f.speaker.toggle(f.keyA, text, { sentenceRanges: ranges, onProgress: value => progress.push(value) });
  await settle();
  f.starts[0].resolve(rangedChunk("first", ranges[0]));
  await settle();
  f.nexts[0].resolve(rangedChunk("second", ranges[1]));
  await settle();
  assert.deepEqual(progress, [], "ready and prefetched audio has not played yet");
  f.audios[0].onplaying();
  f.audios[0].started.resolve();
  await settle();
  assert.deepEqual(progress, [ranges[0]], "playing and play fulfillment must not duplicate the same highlight");
  f.audios[0].onended();
  await settle();
  assert.deepEqual(progress, [ranges[0], null]);
  assert.equal(f.audios.length, 2);
  f.audios[1].onplaying();
  f.nexts[1].resolve({ done: true });
  await settle();
  assert.deepEqual(progress, [ranges[0], null, ranges[1]], "helper completion must not cut off final audio");
  f.audios[1].onended();
  await settle();
  assert.deepEqual(progress, [ranges[0], null, ranges[1], null]);
  assert.equal(f.statesA.at(-1), false);
});

test("a resolved play promise highlights even without an event; a legacy void play return does not", async () => {
  const range = { start: 0, end: 6 };
  for (const playback of ["pending", "void"]) {
    const f = fixture({ playback });
    const progress = [];
    f.speaker.toggle(f.keyA, "First.", { sentenceRanges: [range], onProgress: value => progress.push(value) });
    await settle();
    f.starts[0].resolve(rangedChunk("first", range));
    await settle();
    assert.deepEqual(progress, []);
    if (playback === "pending") f.audios[0].started.resolve();
    await settle();
    assert.deepEqual(progress, playback === "pending" ? [range] : []);
    if (playback === "void") f.audios[0].onplaying();
    assert.deepEqual(progress, [range]);
    f.speaker.stop();
    assert.deepEqual(progress, [range, null]);
  }
});

test("a gap awaiting the next chunk stays unhighlighted and long-sentence chunks may repeat their sentence", async () => {
  const f = fixture();
  const ranges = [{ start: 0, end: 6 }, { start: 7, end: 14 }];
  const progress = [];
  f.speaker.toggle(f.keyA, "First. Second.", { sentenceRanges: ranges, onProgress: value => progress.push(value) });
  await settle();
  f.starts[0].resolve(rangedChunk("first part", ranges[0]));
  await settle();
  const oldPlaying = f.audios[0].onplaying;
  f.audios[0].onended();
  await settle();
  assert.deepEqual(progress, [ranges[0], null]);
  oldPlaying();
  assert.deepEqual(progress, [ranges[0], null], "an old chunk event cannot recolor a synthesis gap");
  f.nexts[0].resolve(rangedChunk("second part of first sentence", ranges[0]));
  await settle();
  assert.deepEqual(progress, [ranges[0], null, ranges[0]]);
  f.nexts[1].resolve(rangedChunk("second sentence", ranges[1]));
  f.audios[1].onended();
  await settle();
  assert.deepEqual(progress, [ranges[0], null, ranges[0], null, ranges[1]]);
  f.speaker.stop();
  assert.equal(progress.at(-1), null);
});

test("switching clears A and stale media callbacks, play fulfillment, and prefetch cannot recolor B", async () => {
  const f = fixture({ playback: "pending" });
  const rangeA = { start: 0, end: 6 }, rangeB = { start: 0, end: 7 };
  const progressA = [], progressB = [];
  f.speaker.toggle(f.keyA, "First.", { sentenceRanges: [rangeA], onProgress: value => progressA.push(value) });
  await settle();
  f.starts[0].resolve(rangedChunk("A", rangeA));
  await settle();
  const oldAudio = f.audios[0], oldPlaying = oldAudio.onplaying, oldEnded = oldAudio.onended;
  oldPlaying();
  f.speaker.toggle(f.keyB, "Second.", { sentenceRanges: [rangeB], onProgress: value => progressB.push(value) });
  assert.deepEqual(progressA, [rangeA, null]);
  await settle();
  f.starts[1].resolve(rangedChunk("B", rangeB));
  await settle();
  f.audios[1].onplaying();
  oldPlaying();
  oldEnded();
  oldAudio.started.resolve();
  f.nexts[0].resolve(rangedChunk("stale A", rangeA));
  await settle();
  assert.deepEqual(progressA, [rangeA, null]);
  assert.deepEqual(progressB, [rangeB]);
  assert.equal(f.audios.length, 2);
  f.speaker.stop();
  assert.deepEqual(progressB, [rangeB, null]);
});

test("stop, matching interruption, and active unsubscribe clear progress; inactive unsubscribe and stale interruption do not", async () => {
  for (const action of ["stop", "interrupt", "unsubscribe"]) {
    const f = fixture();
    const range = { start: 0, end: 6 }, progress = [];
    f.speaker.toggle(f.keyA, "First.", { sentenceRanges: [range], onProgress: value => progress.push(value) });
    await settle();
    f.starts[0].resolve(rangedChunk("first", range));
    await settle();
    const oldPlaying = f.audios[0].onplaying;
    f.unsubscribeB();
    f.speaker.interrupt("stale request id");
    assert.deepEqual(progress, [range]);
    if (action === "stop") f.speaker.stop();
    if (action === "interrupt") f.speaker.interrupt(f.starts[0].id);
    if (action === "unsubscribe") f.unsubscribeA();
    oldPlaying();
    assert.deepEqual(progress, [range, null]);
    assert.equal(f.audios[0].pauseCalls, 1);
  }
});

test("errors clear playing progress and native fallback remains unhighlighted after an early failure", async () => {
  const range = { start: 0, end: 6 };
  const played = fixture(), playedProgress = [];
  played.speaker.toggle(played.keyA, "First.", { sentenceRanges: [range], onProgress: value => playedProgress.push(value) });
  await settle();
  played.starts[0].resolve(rangedChunk("first", range));
  await settle();
  played.nexts[0].reject(new Error("synthesis failed"));
  await settle();
  assert.deepEqual(playedProgress, [range, null]);
  assert.equal(played.fallbackCalls.length, 0);

  const early = fixture({ playback: "pending" }), earlyProgress = [];
  early.speaker.toggle(early.keyA, "First.", { sentenceRanges: [range], onProgress: value => earlyProgress.push(value) });
  await settle();
  early.starts[0].resolve(rangedChunk("first", range));
  await settle();
  const oldPlaying = early.audios[0].onplaying;
  early.nexts[0].reject(new Error("failed before play"));
  await settle();
  assert.deepEqual(earlyProgress, [null]);
  assert.equal(early.fallbackCalls.length, 1);
  oldPlaying();
  early.audios[0].started.resolve();
  early.endFallback();
  await settle();
  assert.deepEqual(earlyProgress, [null]);
});

test("malformed or nonmatching chunk metadata cannot play or highlight another sentence", async () => {
  const ranges = [{ start: 0, end: 6 }, { start: 7, end: 14 }];
  for (const bad of [chunk("missing"), { ...chunk("string"), sentenceStart: "0", sentenceEnd: 6 },
    rangedChunk("wrong bounds", { start: 0, end: 5 }), rangedChunk("skipped first", ranges[1])]) {
    const f = fixture(), progress = [];
    f.speaker.toggle(f.keyA, "First. Second.", { sentenceRanges: ranges, onProgress: value => progress.push(value) });
    await settle();
    f.starts[0].resolve(bad);
    await settle();
    assert.equal(f.audios.length, 0);
    assert.equal(f.fallbackCalls.length, 1);
    assert.deepEqual(progress, [null]);
    f.speaker.stop();
  }
});

test("chunk sentence progress cannot skip a sentence or move back after playback has advanced", async () => {
  const text = "One. Two. Three.";
  const ranges = [{ start: 0, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 16 }];
  for (const reverse of [false, true]) {
    const f = fixture(), progress = [];
    f.speaker.toggle(f.keyA, text, { sentenceRanges: ranges, onProgress: value => progress.push(value) });
    await settle();
    f.starts[0].resolve(rangedChunk("one", ranges[0]));
    await settle();
    if (reverse) {
      f.nexts[0].resolve(rangedChunk("two", ranges[1]));
      f.audios[0].onended();
      await settle();
      f.nexts[1].resolve(rangedChunk("back to one", ranges[0]));
      f.audios[1].onended();
    } else {
      f.nexts[0].resolve(rangedChunk("skipped two", ranges[2]));
      f.audios[0].onended();
    }
    await settle();
    assert.equal(f.audios.length, reverse ? 2 : 1);
    assert.deepEqual(progress, reverse ? [ranges[0], null, ranges[1], null] : [ranges[0], null]);
    assert.equal(f.fallbackCalls.length, 0, "played text must not be reread through fallback");
    assert.match(f.errors[0], /invalid sentence progress/);
  }
});

test("invalid requested ranges reject before bridge dispatch, including gaps, overlap, excessive count, and surrogate cuts", async () => {
  const cases = [
    ["First.", []], ["First.", null], ["First.", [{ start: -1, end: 6 }]],
    ["First.", [{ start: 0, end: 7 }]], ["First.", [{ start: 0, end: 3 }, { start: 2, end: 6 }]],
    ["First. Second.", [{ start: 0, end: 6 }]], ["First. Second.", [{ start: 7, end: 14 }]],
    ["First.", [{ start: 0.5, end: 6 }]], [" 😀.", [{ start: 1, end: 2 }, { start: 2, end: 4 }]],
    ["First.  ", [{ start: 0, end: 6 }, { start: 6, end: 8 }]],
    ["x".repeat(4097), Array.from({ length: 4097 }, (_, index) => ({ start: index, end: index + 1 }))],
  ];
  for (const [text, ranges] of cases) {
    const f = fixture(), progress = [];
    f.speaker.toggle(f.keyA, text, { sentenceRanges: ranges, onProgress: value => progress.push(value), fallback: false });
    await settle();
    assert.equal(f.starts.length, 0);
    assert.equal(f.audios.length, 0);
    assert.equal(f.statesA.at(-1), false);
    assert.deepEqual(progress, [null]);
    assert.match(f.errors[0], /sentence ranges are invalid/);
  }
});

test("progress view callback failures cannot break audio cleanup or final completion", async () => {
  const f = fixture();
  const range = { start: 0, end: 6 }, progress = [];
  f.speaker.toggle(f.keyA, "First.", {
    voice: "af_aoede", sentenceRanges: [range],
    onProgress(value) { progress.push(value); throw new Error("view has unmounted"); },
  });
  await settle();
  assert.deepEqual(f.starts[0].options, { voice: "af_aoede", sentenceRanges: [range] });
  f.starts[0].resolve(rangedChunk("first", range));
  await settle();
  f.nexts[0].resolve({ done: true });
  f.audios[0].onended();
  await settle();
  assert.deepEqual(progress, [range, null]);
  assert.equal(f.statesA.at(-1), false);
  assert.equal(f.audios[0].disposeCalls, 1);
  assert.deepEqual(f.errors, []);
});
