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

After setup, local speech runs in a network-denied worker. If initial voice
lookup fails, **Use Mac voice** offers deliberate native speech for the captured
passage. It preserves the local voice choice and has no synchronized highlight.
First playback may take several seconds while the model loads. ChatGPT/Codex's normal response
generation still uses OpenAI. See [third-party notices](../THIRD_PARTY.md) for
component licenses.

## Reading behavior

Ordinary completed replies place speech and voice choice inside the native
action row, using its hover/focus policy. Playback or an open picker keeps the
controls reachable. Completed progress prose remains available through selection
without an extra idle toolbar. A supported saved voice/research answer has one
footer, rather than controls after every fragment.

Selections can cross completed paragraphs, headings, lists, and table prose
owned by the same logical answer, including completed parts of a partially
loaded answer. The original selected range is preserved. Unfinished or unrelated
text, missing roots, and cross-answer ranges are rejected. Legacy history with
no explicit shared owner remains bounded to its individual registered response.
Reading text without a response action row provides a compact native-style Stop
control; Escape also cancels reading. See the [UI fix report](UI_HOVER_SELECTION_FIXES.md).

Read aloud skips code blocks and continues with the surrounding explanation.
This applies to whole responses and selected passages. A selection containing
only a code block produces no speech and never expands to the whole response.
Inline code within prose remains part of its sentence.

The connected text mapper omits preformatted code and the desktop app's
`data-markdown-copy="code-block"` wrappers, including their headers. Speech
offsets and highlights are built from the remaining prose, so excluded code
does not contribute a sentence or receive a highlight. The HTML fallback also
filters blocks, and its Markdown fallback removes fenced blocks.
Unstructured copied text without HTML or Markdown fences cannot reliably
distinguish code from prose; the connected desktop view is the primary path.

Protocol v2 explicitly reports sentences that produce no phonemes, so silent
symbol-only prose no longer interrupts following sentences. Worker, bridge, and
renderer validate exact contiguous sentence coverage; silent ranges receive no
audio or highlight. The versioned v2 worker preserves compatibility with older
copies still using v1. Inline operator pronunciation may still be simplified.
Table cells have unmapped spaces between values, with row breaks and exact DOM
highlight offsets preserved.

## Update and recovery controls

The native launcher forces `CODEX_SPARKLE_ENABLED=false` before starting the host.
This host gate disables Sparkle initialization, including manual in-app updates.
The builder and verifier pin the two host modules that implement and apply the
gate; a changed host requires another compatibility review. Bundle defaults,
startup preference arguments, and migration of the custom domain after quit
remain additional controls. Sparkle's native startup setter overrides ordinary
preferences, so those preferences alone cannot enforce the policy.

Activation checks the running process's gate, absence of the loaded Sparkle
addon, and both cached and on-disk preferences after the 30-second startup check. Failed checks
enter the existing safe rollback flow. Upgrade through the staged rebuild
procedure. The official app's updater is independent.

Build and launcher utilities accept scratch stages. Verification uses explicit
exceptions, including under optimized Python, and reports staged/installed scope.
Unresolved or invalid recovery journals block a new activation; missing journals
are distinct from malformed ones. New transactions bind recovery to bundle
metadata, both launch executables, and the archive header so launcher-only
upgrades remain distinguishable. Legacy journals retain their original archive
identity checks. A valid voice change while waiting is retained
and validated against the pinned voice bank, rather than a stale report snapshot.

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
installed desktop app. The default Node tests do not require the proprietary
desktop bundle; optional Python host probes skip when it is absent.

On a Mac with the pinned official app, also run:

```sh
npm run test:ui-experiment
```

This local acceptance gate requires the actual host assets and rejects skipped
checks. It covers native menu routing, compiler cache reuse, grouped selections,
hover/focus geometry, and compact Stop styling. It also checks that installer,
updater, signing, and speech-runtime code still matches the reviewed baseline.
The command retains its original experiment name; it verifies the released UI.

Runtime audio checks additionally require the completed
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
| `speech_host_adapter.py`, `selection_host_adapter.py` | Pinned host renderers, action rows, and native selection-menu integration |
| `voice-response-groups.mjs`, `voice-response-group-host.js` | Logical answer ownership and shared controls for saved voice/research text |
| `kokoro-response-speaker.mjs`, `speech-controller.mjs` | Audio ownership, playback progress, fallback |
| `kokoro-main.cjs`, `kokoro_worker.py` | Validated local IPC and offline speech worker |
| `setup_runtime.py`, `runtime/` | Pinned dependency and model setup |
| `build_copy.py`, `asar_integrity.py` | Version-specific patch and integrity-preserving local build |
| `configure_launcher.py`, `profile-launcher.c` | Native permanent-profile entry point |
| `updater_policy.py`, `updater_host_gate.py` | Custom updater policy and pinned host support |
| `install_fresh.py`, `apply_voice_upgrade.py` | Fresh installation and guarded staged updates |

See [screenshot provenance and reproduction](SCREENSHOTS.md) and
[third-party dependencies](../THIRD_PARTY.md). Contributions that support a newer
app version should include reviewed anchors, integrity verification, and the
relevant selection/playback tests.

## Documentation demos

The screenshot gallery uses real app captures supplied by the project user.
The original synthetic feature demos remain available separately. To regenerate
them with the existing development dependencies:

```sh
npm run demo:capture
```

The script runs a fresh offline browser and writes synthetic images to
`docs/images/demos/`, with intermediate pages in ignored `output/playwright/`.
It does not overwrite the real app screenshots or connect to the installed app.
The voice-picker demo uses sample metadata with Aoede selected; it generates no
speech and does not save a voice setting.
