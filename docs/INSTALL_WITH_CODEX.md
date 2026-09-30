# Ask Codex to install ChatGPT Read Aloud

Copy the prompt below into Codex with access to your Mac and a local source
checkout. It asks Codex to perform preparation and verification, while leaving
normal app interaction and any required Quit to you. The feature is intended as
a reading and focus aid and makes no medical claims.

This prompt does not promise compatibility with every ChatGPT release. The
current patch requires the official desktop app at **26.928.20755**.

```text
Help me install the source-only project at:
https://github.com/EdoiseO/chatgpt-read-aloud

I want the local read-aloud add-on for completed Codex responses in ChatGPT for
Mac, installed through a separate patched copy called ChatGPT Read Aloud.
With no text selected, it should read that one response. With a passage selected
in that response, its speaker or the floating
Read aloud action should read only the passage. Skip code blocks and continue
with the surrounding prose. If I select only a code
block, do not read it or expand to the whole response. Inline code within a
sentence can stay with the sentence. A soft yellow highlight should
follow the sentence whose audio is actually playing, preserving normal blue
selection and response formatting. I want the local Kokoro 82M MLX float32
runtime and a saved voice that I choose in the picker. Aoede (af_aoede) is an
example to audition, not a forced initial choice. The purpose is reading support
and focus; do not make medical claims.

Read the repository README, docs/INSTALLATION.md, docs/DEVELOPMENT.md, and relevant scripts before
running them. Inspect --help and use the actual current CLI contracts. Obtain a
clean source checkout if needed; do not upload or commit local outputs.

First inspect my Mac and choose the correct path:

1. Verify macOS 26 or later on Apple Silicon running natively as arm64, native
   Python 3.13, Node.js 20 or later, and Apple's Command Line Tools. The pinned MLX
   wheels require macOS 26+; reject Intel, Rosetta, or an older macOS rather than
   substituting unsupported wheels. Check that /Applications/ChatGPT.app is the
   official app, its deep strict signature verifies, and its version is exactly
   26.928.20755. Explain any
   missing prerequisite or mismatch before proceeding. Keep all version, exact
   source-anchor, ASAR integrity, embedded-digest, and signature checks enabled.
   Do not edit a guard to make another version pass. Do not bypass macOS security
   or permission prompts. If the installed version is unsupported, report that
   concrete blocker and the compatibility work needed instead of changing it.

2. Determine whether /Applications/ChatGPT Read Aloud.app, its private runtime,
   dedicated user-data profile, or optional launcher already exists. Inspect
   relevant identity/markers and generated reports without revealing account
   data, response text, tokens, or unrelated preferences. Treat partial or
   existing paths as state to preserve and diagnose, not something to delete.

For a first installation:

3. Run python3.13 setup_runtime.py to create the private external runtime under
   ~/Library/Application Support/ChatGPT Read Aloud/kokoro. Use its pinned asset
   sizes/hashes and dependency lock. If I provide an asset cache, verify every
   expected file; never silently substitute different weights or a different
   engine. The new settings must have selectedVoice: null. Do not choose or save
   a voice without my choice. Keep model weights, Python environments, settings,
   and generated audio out of the checkout and GitHub.

4. Run python3 build_copy.py to build build/ChatGPT Read Aloud.app from the
   verified official source. The official bundle must remain untouched. Keep
   the ASAR/header/block hashes and enabled embedded integrity digest consistent.
   Sign and verify only the staged custom copy. Never patch a running app or its
   in-use ASAR. Do not launch a staging app for me.

5. Run python3 install_fresh.py after reviewing its checks. It must refuse
   existing installation/profile/launcher paths, configure and verify its private
   staged native launcher, create a blank dedicated profile with private
   permissions, and install only the verified custom copy. It must not copy an
   account database, browser profile, or personal chats from the official app.
   Verify the installed result with:
   python3 verify_voice_build.py --app "/Applications/ChatGPT Read Aloud.app" --report installed-verification.json
   Do not force a voice to satisfy the verifier. A null saved voice is valid for
   the initial picker flow. Leave normal launch and sign-in to me.

For an existing installation/update:

6. Preserve the existing dedicated profile, private settings and saved voice,
   native launcher, activation journal, and recorded verified resource backup
   aliases. Do not rerun the fresh installer or reset the runtime. Prepare an
   isolated APFS-cloned stage from the verified custom app, preserving its
   launcher/profile binding. Check that the destination is absent; inspect an
   existing stage rather than overwriting, deleting, or nesting another bundle.
   Use build_copy.py --refresh-copy --target "build/ChatGPT Read Aloud.app".
   Confirm the private versioned worker matches the canonical source using a
   supported migration that preserves old workers/settings. If the repository
   lacks a suitable migration, explain that blocker; do not overwrite an in-use
   worker. Verify the stage and run apply_voice_upgrade.py --check.
   Use the existing maintenance checkout and its exact-path journal. If moving
   an installation from another checkout, require a reviewed state migration;
   do not copy/edit reports to make path checks pass or lose prior backup aliases.

7. Finish all preparation and produce a concrete verified stage before telling
   me to Quit. If the stage is ready, schedule the bounded one-shot waiter with
   apply_voice_upgrade.py --schedule. Tell me to quit ChatGPT Read Aloud normally
   with Command-Q and keep it closed until the installer reopens it. Do not kill
   the GUI, embedded CLI, shared Codex daemon, other chats' helpers, or unrelated
   apps. Use the installer's exact unchanged-resource/alias checks for standalone
   CUA and Dock mappings and its narrow detached-native-helper policy. Do not
   weaken blockers or add wildcard backup exemptions. Keep atomic exchange and
   rollback checks; verify startup for 30 seconds and the original app signature.

Verification and handoff:

8. Run the project's relevant unit/integration tests. Browser checks must use a
   fresh isolated offline synthetic browser, not a connection to Codex's actual
   UI. Install normal development dependencies as documented; do not rely on a
   private app-bundled Playwright path if a normal package install is available.
   Report separately what source tests, signatures/integrity, real local worker
   audio generation, installed startup, and actual audible UI use establish.

9. If Computer Use blocks controlling Codex itself, do not work around it with
   CDP, debugging ports, injected automation, or an alternate controller. Give
   me concise manual checks in the actual app instead. Ask me to preview voices,
   save my choice with Use this voice, and check persistence after normal Quit
   and reopen. Confirm both whole-response playback and exact selected-passage
   playback; prevent cross-response selections. Test immediate Stop while
   preparing/playing, switching responses, the last audible chunk, and clearing
   yellow highlights on stop/finish/error/gaps/unmount. The yellow highlight must
   follow onplaying/audio playback, not generation or prefetch completion. Blue
   selection, links, and formatting must remain intact. If native speech fallback
   is used, report it and clear the local synchronized highlight.

10. End with the installed/staged status, supported source version, local paths,
    selected voice status (unselected is okay before I choose), checks that
    passed, anything I still need to do, and exact recovery instructions if
    needed. Do not call a build-only result installed or a worker WAV proof
    audible playback. For updates, waiting_for_quit is not activated; preserve
    the exact recorded backup/journal for rollback. Keep generated official
    assets, bundles, profiles, weights, settings, logs, reports, and audio local.
```

The agent can complete preparation while an existing custom app is open. The
actual replacement waits for a normal Quit. If an incompatibility or permission
problem remains, the correct result is a clear blocker with the existing app and
data preserved. The practical commands and manual success checks are in
[INSTALLATION.md](INSTALLATION.md).
