import assert from "node:assert/strict";
import test from "node:test";
import { createResponseSpeaker } from "./speech-controller.mjs";

// Speech callbacks may arrive after cancel(), so keep old utterances available
// to exercise those races without playing audio or controlling the desktop.
function fixture({ cancelSynchronously = false, speakError = null } = {}) {
  const utterances = [];
  const errors = [];
  const stateA = [];
  const stateB = [];
  let cancellations = 0;
  const synthesis = {
    cancel() {
      cancellations++;
      if (cancelSynchronously) {
        utterances.at(-1)?.onerror?.({ error: "canceled" });
      }
    },
    getVoices: () => [],
    speak(utterance) {
      if (speakError) throw speakError;
      utterances.push(utterance);
    },
  };
  const speaker = createResponseSpeaker({
    synthesis,
    createUtterance: text => ({ text }),
    onError: message => errors.push(message),
  });
  const keyA = Symbol("response A");
  const keyB = Symbol("response B");
  const unsubscribeA = speaker.subscribe(keyA, value => stateA.push(value));
  const unsubscribeB = speaker.subscribe(keyB, value => stateB.push(value));
  return {
    speaker, synthesis, keyA, keyB, utterances, errors, stateA, stateB,
    unsubscribeA, unsubscribeB,
    get cancellations() { return cancellations; },
  };
}

test("clicking the active response again stops playback without restarting it", () => {
  const f = fixture({ cancelSynchronously: true });
  f.speaker.toggle(f.keyA, "The first response is being read.");
  const original = f.utterances[0];
  const beforeStop = f.cancellations;
  assert.equal(f.stateA.at(-1), true);

  f.speaker.toggle(f.keyA, "The first response is being read.");
  assert.equal(f.cancellations, beforeStop + 1);
  assert.equal(f.stateA.at(-1), false);
  assert.equal(f.stateB.at(-1), false);
  assert.equal(f.utterances.length, 1);

  // A canceled utterance can still finish after the stop action.
  original.onend();
  original.onerror({ error: "interrupted" });
  assert.equal(f.utterances.length, 1);
  assert.equal(f.stateA.at(-1), false);
  assert.deepEqual(f.errors, []);
});

test("switching responses cancels A and ignores its late callbacks while B plays", () => {
  const f = fixture({ cancelSynchronously: true });
  const longA = Array.from({ length: 40 }, (_, index) => `Response A sentence ${index}.`).join(" ");
  f.speaker.toggle(f.keyA, longA);
  const oldA = f.utterances[0];
  f.speaker.toggle(f.keyB, "Only response B should now be spoken.");
  const currentB = f.utterances[1];
  const cancellationsAfterSwitch = f.cancellations;

  assert.equal(f.stateA.at(-1), false);
  assert.equal(f.stateB.at(-1), true);
  assert.equal(currentB.text, "Only response B should now be spoken.");
  oldA.onend();
  oldA.onerror({ error: "canceled" });
  oldA.onerror({ error: "audio-busy" });
  assert.equal(f.utterances.length, 2, "A must not enqueue another chunk");
  assert.equal(f.cancellations, cancellationsAfterSwitch, "A must not cancel B");
  assert.equal(f.stateB.at(-1), true);
  assert.deepEqual(f.errors, []);

  currentB.onend();
  assert.equal(f.stateB.at(-1), false);
});

test("long responses are spoken in order with one chunk queued at a time", () => {
  const f = fixture();
  const response = Array.from({ length: 80 }, (_, index) =>
    `Sentence ${index} belongs to this response and keeps its original order.`
  ).join(" ");
  f.speaker.toggle(f.keyA, response);
  assert.equal(f.utterances.length, 1);
  let completed = 0;
  while (f.stateA.at(-1)) {
    assert.equal(f.utterances.length, completed + 1);
    const utterance = f.utterances[completed++];
    assert.ok(utterance.text.length > 0 && utterance.text.length <= 601);
    utterance.onend();
    assert.ok(completed <= 100, "playback should terminate");
  }
  assert.ok(completed > 1, "the long response must be split for synthesis");
  assert.equal(f.utterances.map(item => item.text).join(" "), response);
  assert.deepEqual(f.errors, []);
});

test("unmounting the active response stops it and removes its subscription", () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Read response A.");
  const oldA = f.utterances[0];
  const statesBeforeUnmount = f.stateA.length;
  const beforeUnmount = f.cancellations;
  f.unsubscribeA();
  assert.equal(f.cancellations, beforeUnmount + 1);
  assert.equal(f.stateA.length, statesBeforeUnmount);
  assert.equal(f.stateB.at(-1), false);
  oldA.onend();
  assert.equal(f.utterances.length, 1);

  f.speaker.toggle(f.keyB, "Read response B.");
  assert.equal(f.stateB.at(-1), true);
  assert.equal(f.stateA.length, statesBeforeUnmount);
});

test("unmounting an inactive response leaves the playing response alone", () => {
  const f = fixture();
  f.speaker.toggle(f.keyB, "Read response B.");
  const beforeUnmount = f.cancellations;
  f.unsubscribeA();
  assert.equal(f.cancellations, beforeUnmount);
  assert.equal(f.stateB.at(-1), true);
});

test("empty response text stays idle and stops any prior response", () => {
  const f = fixture();
  for (const empty of ["", " \n\t ", null, undefined]) {
    f.speaker.toggle(f.keyA, empty);
    assert.equal(f.utterances.length, 0);
    assert.equal(f.stateA.at(-1), false);
  }
  f.speaker.toggle(f.keyA, "Response A.");
  f.speaker.toggle(f.keyB, "  ");
  assert.equal(f.utterances.length, 1);
  assert.equal(f.stateA.at(-1), false);
  assert.equal(f.stateB.at(-1), false);
  assert.deepEqual(f.errors, []);
});

test("a synthesis error stops playback and reports an actionable error", () => {
  const f = fixture();
  f.speaker.toggle(f.keyA, "Response A.");
  const utterance = f.utterances[0];
  utterance.onerror({ error: "audio-busy" });
  assert.equal(f.stateA.at(-1), false);
  assert.deepEqual(f.errors, ["Unable to read this response aloud: audio-busy"]);
  utterance.onend();
  assert.equal(f.utterances.length, 1);
  f.speaker.toggle(f.keyB, "Response B can play after the error.");
  assert.equal(f.stateB.at(-1), true);
});

test("cancellation and interruption end playback without presenting an error", () => {
  for (const error of ["canceled", "interrupted"]) {
    const f = fixture();
    f.speaker.toggle(f.keyA, "Response A.");
    f.utterances[0].onerror({ error });
    assert.equal(f.stateA.at(-1), false);
    assert.deepEqual(f.errors, []);
  }
});

test("a thrown synthesis failure clears active state and reports the failure", () => {
  const f = fixture({ speakError: new Error("speaker unavailable") });
  f.speaker.toggle(f.keyA, "Response A.");
  assert.equal(f.stateA.at(-1), false);
  assert.equal(f.utterances.length, 0);
  assert.deepEqual(f.errors, ["Unable to read this response aloud: speaker unavailable"]);
});

test("missing platform speech APIs report unavailable without entering playback", () => {
  for (const options of [
    { synthesis: null, createUtterance: text => ({ text }) },
    { synthesis: { cancel() {} }, createUtterance: null },
  ]) {
    const errors = [];
    const states = [];
    const speaker = createResponseSpeaker({ ...options, onError: error => errors.push(error) });
    const key = Symbol("response");
    speaker.subscribe(key, active => states.push(active));
    speaker.toggle(key, "Response text.");
    assert.equal(states.at(-1), false);
    assert.deepEqual(errors, ["Text-to-speech is unavailable in this app."]);
  }
});
