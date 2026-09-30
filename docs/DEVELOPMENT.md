# Development notes

ChatGPT Read Aloud is a local add-on implemented through a version-specific
patch to a separate copy of ChatGPT for Mac. It targets completed Codex responses
inside that app. See [installation and updating](INSTALLATION.md) for the full
requirements and guarded setup procedure.

## Model and voices

The [Kokoro-82M model](https://huggingface.co/hexgrad/Kokoro-82M) runs locally
through MLX and Metal with float32 inference. Setup downloads a pinned
[MLX conversion](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c)
and voice bank. Download metadata and hashes are in `runtime/assets.json`.

Aoede (`af_aoede`, American English) was chosen for the original personal
installation and demos. It is a supplied Kokoro voice, not a custom recording.
The picker offers 28 English voices. A fresh installation has no voice selected:
preview and choose one. The saved choice survives a normal Quit and reopen.

After setup, local speech runs in a network-denied worker. Native macOS speech
can be a fallback and clears the synchronized local highlight. First playback
may take several seconds while the model loads. ChatGPT/Codex's normal response
generation still uses OpenAI. See [third-party notices](../THIRD_PARTY.md) for
component licenses.

## Code-reading limitations

Code blocks and selected code are included in speech input, but pronunciation
is handled as prose. Some operators are simplified or omitted.

A confirmed bug occurs when a symbol-only line, such as `{` or `}`, produces
no phonemes. The worker skips it, but the playback/progress controller rejects the
forward jump to the next spoken range. Reading can stop before following text;
if the first range is silent, it can invoke Apple speech fallback instead.
A silent trailing line can finish normally. This remains unfixed.

The investigation exercised 37 local backend cases, including six exact
browser-mapped code/selection fixtures. Emitted WAVs were valid; controller
replays used mocked media. These checks establish the progress mismatch, not a
live app click test or faithful pronunciation of every code symbol.

## Development and verification

```sh
npm ci
npx playwright install chromium
npm test
python3 -m unittest discover -p 'test_*.py'
python3 test-kokoro-worker-sentences.py
```

The default tests cover response ownership, cancellation, voice preview/save,
selection routing, real DOM ranges/highlights in a fresh offline browser, and
install/update behavior using temporary fixtures. They do not control the
installed desktop app. Runtime audio checks additionally require the completed
local speech setup:

```sh
python3 test-kokoro-worker.py
node --test test-kokoro-runtime.cjs
```

Those checks preserve the live voice settings. Valid generated audio and source
tests do not replace the [manual audible UI checks](INSTALLATION.md#check-the-feature-in-the-actual-app).
The original personal installation has been manually checked for playback,
stopping, switching responses, reopening, selection reading, and highlighting.
Fresh bootstrap/install helpers are separately tested with isolated fixtures;
installation on a second Mac has not yet been confirmed.

The source layout is deliberately small:

| Files | Purpose |
| --- | --- |
| `response-button.js`, `voice-picker.js` | Response controls and voice chooser |
| `response-highlight.mjs` | Visible text mapping, selected ranges, sentence highlight |
| `kokoro-response-speaker.mjs`, `speech-controller.mjs` | Audio ownership, playback progress, fallback |
| `kokoro-main.cjs`, `kokoro_worker.py` | Validated local IPC and offline speech worker |
| `setup_runtime.py`, `runtime/` | Pinned dependency and model setup |
| `build_copy.py`, `asar_integrity.py` | Version-specific patch and integrity-preserving local build |
| `configure_launcher.py`, `profile-launcher.c` | Native permanent-profile entry point |
| `install_fresh.py`, `apply_voice_upgrade.py` | Fresh installation and guarded staged updates |

See [screenshot provenance and reproduction](SCREENSHOTS.md) and
[third-party dependencies](../THIRD_PARTY.md). Contributions that support a newer
app version should include reviewed anchors, integrity verification, and the
relevant selection/playback tests.
