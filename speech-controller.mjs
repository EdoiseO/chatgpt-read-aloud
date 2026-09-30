export function createResponseSpeaker({ synthesis, createUtterance, onError = () => {} }) {
  const listeners = new Map();
  let current = null;
  let generation = 0;
  let utterance = null;

  function notify() {
    for (const [key, callback] of listeners) callback(current === key);
  }

  function stop() {
    generation++;
    current = null;
    utterance = null;
    synthesis?.cancel();
    notify();
  }

  function chunks(text) {
    const result = [];
    let remaining = text.trim();
    while (remaining.length > 600) {
      const head = remaining.slice(0, 601);
      const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
      const space = head.lastIndexOf(" ");
      const cut = boundary >= 150 ? boundary + 1 : space >= 150 ? space : 600;
      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) result.push(remaining);
    return result;
  }

  function toggle(key, text) {
    if (current === key) { stop(); return; }
    stop();
    if (!synthesis || typeof createUtterance !== "function") {
      onError("Text-to-speech is unavailable in this app.");
      return;
    }
    const parts = chunks(String(text ?? ""));
    if (!parts.length) return;
    current = key;
    const run = generation;
    notify();
    let index = 0;
    function next() {
      if (run !== generation) return;
      if (index === parts.length) { current = null; utterance = null; notify(); return; }
      try {
        utterance = createUtterance(parts[index++]);
        const voices = synthesis.getVoices();
        const voice = voices.find(v => v.default && v.localService) ?? voices.find(v => v.localService && /^en[-_]/i.test(v.lang));
        if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
        utterance.rate = 1;
        utterance.onend = next;
        utterance.onerror = event => {
          if (run !== generation) return;
          stop();
          if (event.error !== "canceled" && event.error !== "interrupted") onError("Unable to read this response aloud: " + event.error);
        };
        synthesis.speak(utterance);
      } catch (error) {
        if (run !== generation) return;
        stop();
        onError("Unable to read this response aloud: " + error.message);
      }
    }
    next();
  }

  return {
    toggle,
    stop,
    subscribe(key, callback) {
      listeners.set(key, callback);
      callback(current === key);
      return () => { listeners.delete(key); if (current === key) stop(); };
    },
  };
}
