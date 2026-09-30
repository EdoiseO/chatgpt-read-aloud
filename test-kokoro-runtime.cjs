'use strict';

// Exercise the actual IPC adapter and packaged, network-denied Python runtime.
// No production voice is saved and no audio is played by this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKokoroMainBridge, INTERRUPT_CHANNEL } = require('./kokoro-main.cjs');

function windowEvent(page) {
  const sender = new EventEmitter();
  sender.mainFrame = { url: `app://-/${page}` };
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (channel, payload) => sender.sent.push({ channel, payload });
  return { sender, senderFrame: sender.mainFrame };
}

function verifyWav(chunk) {
  assert.equal(chunk.done, false);
  assert.equal(chunk.mimeType, 'audio/wav');
  const wav = Buffer.from(chunk.audioBase64, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert(wav.length > 4800);
  assert(wav.subarray(44).some(byte => byte !== 0));
  return (wav.length - 44) / 48000;
}

test('packaged main bridge uses one offline worker, all voices, and final-chunk ownership',
  { timeout: 120000 }, async () => {
    let handle;
    const children = [];
    const exits = [];
    const app = new EventEmitter();
    const settingsFile = path.join(os.homedir(), 'Library/Application Support/ChatGPT Read Aloud/kokoro/settings.json');
    const beforeSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
    const expectedSelection = beforeSettings ? JSON.parse(beforeSettings).selectedVoice : null;
    const started = Date.now();
    const bridge = createKokoroMainBridge({
      electron: { app, ipcMain: { handle: (_channel, callback) => { handle = callback; }, removeHandler: () => {} } },
      spawn: (command, args, options) => {
        assert.equal(command, '/usr/bin/sandbox-exec');
        assert(args.includes('(version 1)(allow default)(deny network*)'));
        assert.equal(options.shell, false);
        assert.equal(options.env.HF_HUB_OFFLINE, '1');
        const child = spawn(command, args, options);
        children.push(child);
        exits.push(new Promise(resolve => child.once('exit', resolve)));
        return child;
      },
      idleTimeoutMs: 60000,
    });
    try {
      const a = windowEvent('index.html');
      const b = windowEvent('detached-window.html');
      const voices = await handle(a, { action: 'voices' });
      assert.equal(voices.voices.length, 28);
      assert.equal(voices.engine, 'mlx');
      assert.equal(voices.selectedVoice, expectedSelection);
      const firstRequest = { action: 'start', requestId: 'runtime-us',
        text: 'A short preview of this local voice.' };
      if (expectedSelection === null) firstRequest.voice = 'af_bella';
      const us = await handle(a, firstRequest);
      const usSeconds = verifyWav(us);
      assert.deepEqual(await handle(a, { action: 'next', requestId: 'runtime-us' }), { done: true });
      // The renderer could still be playing its final chunk when next returns done.
      const uk = await handle(b, { action: 'start', requestId: 'runtime-uk',
        text: 'A short preview of this local voice.', voice: 'bm_george' });
      const ukSeconds = verifyWav(uk);
      assert(a.sender.sent.some(message => message.channel === INTERRUPT_CHANNEL && message.payload.requestId === 'runtime-us'));
      assert.deepEqual(await handle(b, { action: 'cancel', requestId: 'runtime-uk' }), { done: true });
      const sentenceText = 'Read only this selected passage. Then highlight this sentence.';
      const sentenceRanges = [{ start: 0, end: 32 }, { start: 33, end: sentenceText.length }];
      assert.equal(sentenceText.slice(0, 32), 'Read only this selected passage.');
      const sentenceRequest = { action: 'start', requestId: 'runtime-sentences',
        text: sentenceText, sentenceRanges };
      if (expectedSelection === null) sentenceRequest.voice = 'af_bella';
      const firstSentence = await handle(a, sentenceRequest);
      const firstSentenceSeconds = verifyWav(firstSentence);
      assert.equal(firstSentence.sentenceStart, 0);
      assert.equal(firstSentence.sentenceEnd, 32);
      const secondSentence = await handle(a, { action: 'next', requestId: 'runtime-sentences' });
      const secondSentenceSeconds = verifyWav(secondSentence);
      assert.equal(secondSentence.sentenceStart, 33);
      assert.equal(secondSentence.sentenceEnd, sentenceText.length);
      assert.deepEqual(await handle(a, { action: 'next', requestId: 'runtime-sentences' }), { done: true });
      await handle(a, { action: 'cancel', requestId: 'runtime-sentences' });
      assert.equal((await handle(a, { action: 'voices' })).selectedVoice, expectedSelection);
      assert.equal(children.length, 1);
      const afterSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
      assert.deepEqual(afterSettings, beforeSettings);
      fs.writeFileSync(path.join(__dirname, 'test-kokoro-runtime-results.json'), JSON.stringify({
        realMainToWorkerPassed: true, networkDenied: true, voices: 28,
        selectedVoice: expectedSelection, usedSavedVoiceWithoutOverride: expectedSelection !== null,
        audioCases: 4, usSeconds, ukSeconds,
        sentenceChunksVerified: true, firstSentenceSeconds, secondSentenceSeconds,
        singleWorker: true, finalChunkCrossWindowInterruption: true,
        productionSettingsUnchanged: true, elapsedSeconds: (Date.now() - started) / 1000,
      }, null, 2) + '\n');
    } finally {
      bridge.dispose();
      await Promise.all(exits);
    }
  });
