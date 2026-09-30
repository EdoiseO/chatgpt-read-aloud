'use strict';

const nodeSpawn = require('node:child_process').spawn;
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const CHANNEL = 'codex-local-read-aloud';
const INTERRUPT_CHANNEL = `${CHANNEL}:interrupt`;
const SANDBOX_PROFILE = '(version 1)(allow default)(deny network*)';
const MAX_TEXT_LENGTH = 200000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RPC = 16;
const MAX_SENTENCE_RANGES = 4096;

function validSentenceRanges(text, ranges) {
  if (typeof text !== 'string' || !Array.isArray(ranges) ||
    ranges.length < 1 || ranges.length > MAX_SENTENCE_RANGES) return false;
  // Python and JS must agree on code points. Reject lone surrogates and ranges
  // ending halfway through an astral character rather than rounding offsets.
  const boundaries = new Set([0]);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index++;
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false;
    boundaries.add(index + 1);
  }
  let previousEnd = 0;
  for (const range of ranges) {
    if (!range || typeof range !== 'object' || Array.isArray(range) ||
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < previousEnd || range.start < 0 || range.start >= range.end || range.end > text.length ||
      !boundaries.has(range.start) || !boundaries.has(range.end) ||
      /\S/u.test(text.slice(previousEnd, range.start)) || !/\S/u.test(text.slice(range.start, range.end))) return false;
    previousEnd = range.end;
  }
  return !/\S/u.test(text.slice(previousEnd));
}

function normalizedVoice(voice) {
  if (typeof voice !== 'string' || voice.length > 128) return null;
  const trimmed = voice.trim();
  return trimmed.length <= 64 && /^(?:af|am|bf|bm)_[a-z0-9]+$/.test(trimmed) ? trimmed : null;
}

function isTrustedFrame(event) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  if (!sender || !frame) return false;
  try {
    if (sender.isDestroyed?.() || sender.mainFrame !== frame) return false;
    const url = new URL(frame.url);
    return url.protocol === 'app:' && url.host === '-' && !url.username && !url.password &&
      (url.pathname === '/index.html' || url.pathname === '/detached-window.html');
  } catch {
    return false;
  }
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    !['start', 'next', 'cancel', 'voices', 'set_voice'].includes(payload.action)) return false;
  if (payload.voice !== undefined && !normalizedVoice(payload.voice)) return false;
  if (payload.text !== undefined && (typeof payload.text !== 'string' || payload.text.length > MAX_TEXT_LENGTH)) return false;
  if (payload.sentenceRanges !== undefined &&
    (payload.action !== 'start' || !validSentenceRanges(payload.text, payload.sentenceRanges))) return false;
  if (payload.action === 'voices') return true;
  if (payload.action === 'set_voice') return normalizedVoice(payload.voice) !== null;
  return (
    typeof payload.requestId === 'string' && payload.requestId.length > 0 &&
    payload.requestId.length <= MAX_REQUEST_ID_LENGTH &&
    (payload.action !== 'start' || typeof payload.text === 'string')
  );
}

function voiceMetadata(result, action) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.selectedVoice !== null && normalizedVoice(result.selectedVoice) !== result.selectedVoice) return null;
  if (action === 'set_voice' && typeof result.selectedVoice !== 'string') return null;
  const sanitized = { selectedVoice: result.selectedVoice };
  if (action === 'voices' || result.voices !== undefined) {
    if (!Array.isArray(result.voices) || result.voices.length > 64) return null;
    const ids = new Set();
    const voices = [];
    for (const item of result.voices) {
      if (!item || typeof item !== 'object' || normalizedVoice(item.id) !== item.id || ids.has(item.id)) return null;
      ids.add(item.id);
      const voice = { id: item.id };
      for (const field of ['name', 'label', 'lang', 'language', 'locale', 'gender']) {
        if (item[field] === undefined) continue;
        if (typeof item[field] !== 'string' || item[field].length > 128) return null;
        voice[field] = item[field];
      }
      voices.push(voice);
    }
    if (sanitized.selectedVoice !== null && !ids.has(sanitized.selectedVoice)) return null;
    sanitized.voices = voices;
  }
  if (action === 'voices') {
    if (result.speed !== 1 || !['mlx', 'onnx'].includes(result.engine)) return null;
    sanitized.speed = result.speed;
    sanitized.engine = result.engine;
  }
  return sanitized;
}

function createKokoroMainBridge({
  electron,
  spawn = nodeSpawn,
  homedir = os.homedir,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  rpcTimeoutMs = 45000,
  idleTimeoutMs = 5 * 60 * 1000,
} = {}) {
  if (!electron?.ipcMain?.handle || !electron?.app?.on) {
    throw new Error('Electron main-process APIs are required.');
  }
  const runtime = path.join(homedir(), 'Library/Application Support/ChatGPT Read Aloud/kokoro');
  const pending = new Map();
  let childSession = null;
  let owner = null;
  let nextRpcId = 1;
  let idleTimer = null;
  let disposed = false;

  function timer(callback, duration) {
    const id = schedule(callback, duration);
    id?.unref?.();
    return id;
  }

  function notifyInterrupted(previous) {
    if (!previous || !isTrustedFrame({ sender: previous.sender, senderFrame: previous.frame })) return;
    try { previous.sender.send(INTERRUPT_CHANNEL, { requestId: previous.requestId }); } catch {}
  }

  function clearOwner() {
    const previous = owner;
    owner = null;
    if (previous?.onDestroyed) previous.sender.removeListener?.('destroyed', previous.onDestroyed);
    return previous;
  }

  function rejectPending(message, predicate = () => true) {
    for (const [rpcId, entry] of pending) {
      if (!predicate(entry)) continue;
      pending.delete(rpcId);
      unschedule(entry.timeout);
      entry.reject(new Error(message));
    }
  }

  function endSession(session, message = 'Local read-aloud worker stopped.', kill = true) {
    if (childSession !== session) return;
    childSession = null;
    if (idleTimer !== null) { unschedule(idleTimer); idleTimer = null; }
    rejectPending(message);
    notifyInterrupted(clearOwner());
    if (kill) {
      // The process only performs local inference; terminate it immediately so
      // an exited app or idle session cannot leave a background worker behind.
      try { session.child.kill('SIGKILL'); } catch {}
    }
  }

  function armIdleTimer() {
    if (idleTimer !== null) unschedule(idleTimer);
    if (!childSession) { idleTimer = null; return; }
    const session = childSession;
    idleTimer = timer(() => endSession(session, 'Local read-aloud worker became idle.'), idleTimeoutMs);
  }

  function parseResponse(session, line) {
    if (childSession !== session) return;
    let response;
    try { response = JSON.parse(line); } catch {
      endSession(session, 'Local read-aloud worker sent an invalid response.');
      return;
    }
    if (response?.event === 'ready' && response.rpcId === undefined) return;
    if (!Number.isSafeInteger(response?.rpcId) || response.rpcId < 1) {
      endSession(session, 'Local read-aloud worker sent an invalid response.');
      return;
    }
    const entry = pending.get(response.rpcId);
    // A canceled request can complete after its pending promise was removed.
    if (!entry) return;
    pending.delete(response.rpcId);
    unschedule(entry.timeout);
    if (entry.owner && (owner !== entry.owner || !isTrustedFrame({ sender: owner.sender, senderFrame: owner.frame }))) {
      entry.reject(new Error('Read-aloud request is no longer active.'));
      if (owner === entry.owner) { clearOwner(); sendCancel(session, entry.requestId); }
      return;
    }
    if (response.error) {
      // This fixed code lets the renderer open its voice picker without
      // forwarding arbitrary worker diagnostics to the desktop UI.
      const message = response.error.code === 'VOICE_NOT_SELECTED'
        ? 'VOICE_NOT_SELECTED' : 'Unable to generate local read-aloud audio.';
      entry.reject(new Error(message));
      if (owner === entry.owner) clearOwner();
      return;
    }
    const result = response.result;
    let sanitized;
    if (entry.action === 'voices' || entry.action === 'set_voice') sanitized = voiceMetadata(result, entry.action);
    else if (result?.done === true) sanitized = { done: true };
    else if (result?.done === false && result.mimeType === 'audio/wav' &&
      typeof result.audioBase64 === 'string' && result.audioBase64.length > 0 &&
      result.audioBase64.length <= MAX_RESPONSE_BYTES && result.audioBase64.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(result.audioBase64)) {
      sanitized = { done: false, audioBase64: result.audioBase64, mimeType: 'audio/wav' };
      if (entry.owner?.sentenceRanges) {
        const start = result.sentenceStart;
        const end = result.sentenceEnd;
        const index = Number.isSafeInteger(start) && Number.isSafeInteger(end)
          ? entry.owner.sentenceRanges.findIndex(range => range.start === start && range.end === end) : -1;
        if (index < 0 || index < entry.owner.lastSentenceIndex) sanitized = null;
        else {
          entry.owner.lastSentenceIndex = index;
          sanitized.sentenceStart = start;
          sanitized.sentenceEnd = end;
        }
      } else if (result.sentenceStart !== undefined || result.sentenceEnd !== undefined) sanitized = null;
    }
    if (!sanitized) {
      entry.reject(new Error('Local read-aloud worker sent an invalid response.'));
      endSession(session, 'Local read-aloud worker sent an invalid response.');
      return;
    }
    // A prefetched `done` can arrive while the renderer is still playing its
    // final decoded audio chunk. Keep ownership until its finish/stop cancel,
    // so another window can interrupt that audible tail immediately.
    entry.resolve(sanitized);
  }

  function ensureChild() {
    if (childSession) return childSession;
    let child;
    try {
      child = spawn('/usr/bin/sandbox-exec', [
        '-p', SANDBOX_PROFILE,
        path.join(runtime, '.venv/bin/python'), '-u', path.join(runtime, 'worker-sentences-v1.py'),
      ], {
        cwd: runtime,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
        shell: false,
      });
    } catch {
      throw new Error('Unable to start local read-aloud worker.');
    }
    const session = { child, buffer: '', decoder: new StringDecoder('utf8') };
    childSession = session;
    child.once('error', () => endSession(session, 'Unable to start local read-aloud worker.'));
    child.once('exit', () => endSession(session, 'Local read-aloud worker stopped.', false));
    child.once('close', () => endSession(session, 'Local read-aloud worker stopped.', false));
    child.stdin.on('error', () => endSession(session, 'Local read-aloud worker stopped.'));
    child.stdout.on('error', () => endSession(session, 'Local read-aloud worker stopped.'));
    // Drain diagnostic output without retaining or printing response text,
    // third-party diagnostics, filesystem paths, or exception details.
    child.stderr.on('data', () => {});
    child.stderr.on('error', () => {});
    child.stdout.on('data', data => {
      if (childSession !== session) return;
      session.buffer += typeof data === 'string' ? data : session.decoder.write(data);
      let boundary;
      while ((boundary = session.buffer.indexOf('\n')) !== -1) {
        const line = session.buffer.slice(0, boundary);
        session.buffer = session.buffer.slice(boundary + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_BYTES) {
          endSession(session, 'Local read-aloud worker sent an invalid response.');
          return;
        }
        if (line.trim()) parseResponse(session, line);
        if (childSession !== session) return;
      }
      if (Buffer.byteLength(session.buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        endSession(session, 'Local read-aloud worker sent an invalid response.');
      }
    });
    return session;
  }

  function rpc(session, payload, requestOwner) {
    if (pending.size >= MAX_PENDING_RPC) return Promise.reject(new Error('Too many local read-aloud requests.'));
    return new Promise((resolve, reject) => {
      const rpcId = nextRpcId++;
      const timeout = timer(() => endSession(session, 'Local read-aloud worker timed out.'), rpcTimeoutMs);
      pending.set(rpcId, { resolve, reject, timeout, requestId: payload.requestId, action: payload.action, owner: requestOwner });
      try {
        session.child.stdin.write(`${JSON.stringify({ rpcId, ...payload })}\n`, error => {
          if (error) endSession(session, 'Local read-aloud worker stopped.');
        });
      } catch {
        endSession(session, 'Local read-aloud worker stopped.');
      }
    });
  }

  function sendCancel(session, requestId) {
    if (childSession !== session) return;
    // Send immediately through the same pipe, even during inference. Do not
    // allocate a pending slot or wait for acknowledgment: rapid replacement
    // must never fill the RPC map and prevent a later cancellation.
    try {
      session.child.stdin.write(`${JSON.stringify({ rpcId: nextRpcId++, action: 'cancel', requestId })}\n`, error => {
        if (error) endSession(session, 'Local read-aloud worker stopped.');
      });
    } catch {
      endSession(session, 'Local read-aloud worker stopped.');
    }
  }

  async function handle(event, payload) {
    if (disposed) throw new Error('Local read-aloud is unavailable.');
    if (!isTrustedFrame(event)) throw new Error('Read-aloud request is not allowed from this frame.');
    if (!validPayload(payload)) throw new Error('Invalid read-aloud request.');
    if (payload.action === 'voices' || payload.action === 'set_voice') {
      const session = ensureChild();
      if (payload.action === 'set_voice') {
        // Selection is saved globally. Stop any window's old-voice playback
        // before acknowledging a new choice, including audio already decoded
        // by a detached renderer while its next inference RPC is pending.
        const previous = clearOwner();
        if (previous) {
          notifyInterrupted(previous);
          rejectPending('Read-aloud voice was changed.', entry => entry.owner === previous);
          sendCancel(session, previous.requestId);
        }
      }
      armIdleTimer();
      const request = { action: payload.action };
      if (payload.action === 'set_voice') request.voice = normalizedVoice(payload.voice);
      return rpc(session, request, null);
    }
    if (payload.action !== 'start') {
      if (!owner || owner.sender !== event.sender || owner.frame !== event.senderFrame || owner.requestId !== payload.requestId) {
        throw new Error('This read-aloud request does not belong to this window.');
      }
      armIdleTimer();
      if (payload.action === 'cancel') {
        const previous = clearOwner();
        rejectPending('Read-aloud request was canceled.', entry => entry.owner === previous);
        if (childSession) sendCancel(childSession, payload.requestId);
        return { done: true };
      }
      if ([...pending.values()].some(entry => entry.owner === owner)) {
        throw new Error('A read-aloud chunk is already being generated.');
      }
      return rpc(ensureChild(), { action: 'next', requestId: payload.requestId }, owner);
    }
    const previous = clearOwner();
    if (previous) {
      if (previous.sender !== event.sender) notifyInterrupted(previous);
      rejectPending('Read-aloud request was replaced.', entry => entry.owner === previous);
      if (childSession) sendCancel(childSession, previous.requestId);
    }
    const session = ensureChild();
    const requestOwner = { sender: event.sender, frame: event.senderFrame, requestId: payload.requestId };
    if (payload.sentenceRanges !== undefined) {
      requestOwner.sentenceRanges = payload.sentenceRanges.map(({ start, end }) => ({ start, end }));
      requestOwner.lastSentenceIndex = -1;
    }
    owner = requestOwner;
    requestOwner.onDestroyed = () => {
      if (owner !== requestOwner) return;
      clearOwner();
      rejectPending('Read-aloud window closed.', entry => entry.owner === requestOwner);
      sendCancel(session, requestOwner.requestId);
      armIdleTimer();
    };
    event.sender.once?.('destroyed', requestOwner.onDestroyed);
    armIdleTimer();
    const request = { action: 'start', requestId: payload.requestId, text: payload.text };
    if (requestOwner.sentenceRanges) request.sentenceRanges = requestOwner.sentenceRanges;
    if (payload.voice !== undefined) request.voice = normalizedVoice(payload.voice);
    return rpc(session, request, requestOwner);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (idleTimer !== null) { unschedule(idleTimer); idleTimer = null; }
    if (childSession) endSession(childSession, 'Local read-aloud was stopped.');
    else { rejectPending('Local read-aloud was stopped.'); clearOwner(); }
    electron.ipcMain.removeHandler?.(CHANNEL);
    electron.app.removeListener?.('before-quit', dispose);
  }

  electron.ipcMain.handle(CHANNEL, handle);
  electron.app.on('before-quit', dispose);
  return { dispose };
}

module.exports = { createKokoroMainBridge, CHANNEL, INTERRUPT_CHANNEL };

// Ordinary Node imports expose the injectable factory without starting a child
// or depending on the Electron npm package's executable-path export.
if (process.versions.electron) {
  const electron = require('electron');
  if (electron.ipcMain?.handle && electron.app?.on) createKokoroMainBridge({ electron });
}
