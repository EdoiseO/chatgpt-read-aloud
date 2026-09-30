# ChatGPT Read Aloud

A local reading aid for people who find it hard to stay focused on long responses.
Listen to a response, read just a selected passage, and follow the sentence being
spoken with a soft yellow highlight.

This project adds these controls to **completed Codex responses in a separate
copy of the ChatGPT desktop app on an Apple Silicon Mac running macOS 26+**. It grew from a personal
preference for listening while reading. It is an experimental community project,
with no affiliation with OpenAI and no claim to treat a medical condition.

![Selected passage with the Read aloud action](docs/images/read-selection.png)

*Standalone feature demonstration with sample text. The screenshots do not
contain personal conversations; they are not captures of the installed app.*

## What it does

- **Read one response:** click the speaker beside its Copy button.
- **Read a passage:** select text within that response, then use **Read aloud**
  in the floating menu or click its speaker.
- **Follow the audio:** a soft yellow highlight moves with the sentence currently
  playing. It clears when playback stops, finishes, or switches responses.
- **Stop or switch:** click the active speaker again to stop; click another
  response's speaker to switch to that response.
- **Choose your voice:** preview a voice, then use **Use this voice** to save it.
  Your choice survives a normal Quit and reopen.
- **Keep a dedicated profile:** open **ChatGPT Read Aloud** from Applications,
  the Dock, or its optional launcher.

![Sentence highlight during playback](docs/images/sentence-highlight.png)

*The demo uses the project's actual DOM text mapping and CSS highlight helper.
Playback is illustrated; the screenshot does not generate or play audio.*

## Model and voice

The speech model is **[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)**,
with 82 million parameters. This setup runs it locally through MLX and Metal,
using **float32** inference on Apple Silicon. It downloads a pinned
[MLX model conversion](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c)
and a pinned voice bank during setup.

**Aoede (`af_aoede`, American English)** is the voice chosen for the original
personal installation and shown in these demonstrations. It is a supplied Kokoro
voice, not a custom recording. The picker exposes **28 English voices** from the
pinned bank. A fresh installation has no voice selected: preview the options and
choose the one you prefer. Aoede is not forced.

![Voice picker showing Aoede](docs/images/voice-picker.png)

*The actual custom voice-picker component, rendered with sample voice metadata
in a standalone page. Preview and save are functional in the installed feature.*

After the initial downloads, Kokoro speech generation runs in a local worker
with network access denied. It needs no OpenAI API key or speech API payment.
ChatGPT/Codex's normal response generation still uses the app's OpenAI service.
Native macOS speech can be a fallback; that path clears the synchronized local
highlight. First playback may take several seconds while the model loads.

## Install with Codex

**[Copy the detailed installation prompt](docs/INSTALL_WITH_CODEX.md)** and give
it to Codex on your Mac. It includes prerequisite checks, fresh installation,
voice choice, verification, and a separate path for updating an existing setup.

For manual setup, read **[the installation guide](docs/INSTALLATION.md)** first.
The core fresh-install sequence from a clean checkout is:

```sh
python3.13 setup_runtime.py
python3 build_copy.py
python3 install_fresh.py
python3 verify_voice_build.py --app "/Applications/ChatGPT Read Aloud.app" --report installed-verification.json
```

Then open **ChatGPT Read Aloud** normally and choose your voice. The installer
creates a blank private profile; it does not copy your existing account/profile.
Existing installations use the guide's staged update procedure instead.

### Compatibility

The current patch targets **ChatGPT desktop 26.928.20755** exactly. It checks that
version and specific source anchors. Other versions require a compatibility
update; changing the version check alone is not enough. Requirements are macOS
26 or later on Apple Silicon, Python 3.13 for the speech runtime, Node.js 20 or later, and
Apple's Command Line Tools. This is not a Windows/Linux or standalone Codex-app
installer.

The official app remains the local build input. This repository contains our
source, tests, and instructions; it does not distribute OpenAI's app, generated
app assets, account profiles, model weights, or personal data. The modified copy
uses a local signature and turns off the updater defaults. Existing preferences
can still produce update prompts. Official updates do not reapply the feature;
use a reviewed compatible rebuild and the staged installer.

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
tests do not replace the [manual audible UI checks](docs/INSTALLATION.md#check-the-feature-in-the-actual-app).
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

See [screenshot provenance and reproduction](docs/SCREENSHOTS.md) and
[third-party dependencies](THIRD_PARTY.md). Contributions that support a newer
app version should include reviewed anchors, integrity verification, and the
relevant selection/playback tests.

## License

Our custom source is available under the [MIT license](LICENSE). That license
covers this repository's original code and documentation. The official app,
Kokoro model/voices, and installed dependencies retain their own licenses and
notices; they are obtained separately.
