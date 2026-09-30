# Install ChatGPT Read Aloud

This local read-aloud add-on adds a speaker button to completed Codex responses
through a separate patched copy of ChatGPT for Mac. It can read a whole response
or a selected passage, skipping code blocks and continuing with the surrounding
explanation. A soft yellow highlight follows the sentence whose audio is
playing. The goal is reading support and focus. The project makes no medical
claims.

The GitHub repository contains source and tests. App bundles, OpenAI's generated
app assets, profiles, account data, model weights, generated audio, and local
verification reports stay on your Mac.

For an agent-assisted installation, use the copy/paste prompt in
[INSTALL_WITH_CODEX.md](INSTALL_WITH_CODEX.md).

See [development notes](DEVELOPMENT.md) for model details, tests, and reading behavior.

## Requirements

- **macOS 26 or later on Apple Silicon, running natively as `arm64`.** The pinned
  MLX wheels require macOS 26+. The native launcher targets `arm64`, and the
  default Kokoro engine uses MLX and Metal. Intel, Rosetta, and older macOS
  versions are outside this setup's supported requirements.
- An official `/Applications/ChatGPT.app` at **26.928.20755**. This patch matches
  specific asset names and source anchors in that version. A newer version needs
  a reviewed compatibility change before this builder can be used.
- Python **3.13** available as `python3.13` for the local speech runtime. The
  maintenance scripts also need Python 3.9 or later; using 3.13 for them is fine.
- Node.js **20 or later** for JavaScript syntax checks and tests.
- Apple's Command Line Tools, including `xcrun clang`, and macOS's `codesign`,
  `sandbox-exec`, `ps`, and `lsof` tools.
- Internet access for the initial source/dependency/model downloads. Speech
  generation subsequently runs with network access denied.

Check the tools and the installed version before building:

```sh
uname -m
sw_vers -productVersion
python3.13 --version
python3 --version
node --version
xcrun --find clang
codesign --verify --deep --strict /Applications/ChatGPT.app
python3 - <<'PY'
from pathlib import Path
import plistlib
info = plistlib.loads(Path('/Applications/ChatGPT.app/Contents/Info.plist').read_bytes())
print(info['CFBundleShortVersionString'])
PY
```

The architecture must be native `arm64`, macOS must be 26 or later, and the app
version must be `26.928.20755`.
Resolve missing tools or normal macOS permission prompts before continuing.
Keep the builder's version, anchor, integrity, and signature checks enabled.
Do not change macOS security settings to get past a failure.

## Get the source

```sh
git clone https://github.com/EdoiseO/chatgpt-read-aloud.git
cd chatgpt-read-aloud
```

Use the same checkout for subsequent upgrades so its private activation journal
can preserve verified backup aliases used by unchanged shared helpers. Review
the README and the scripts before running them. Run commands from the checkout
root. Keep generated files ignored by Git.

An installation maintained from a different checkout needs a reviewed local
state migration before this checkout can update it. The activation journal binds
exact stage and backup paths. Copying or editing a report to make those checks
pass is not a supported migration.

## First installation

Use this path when the custom app, its private profile, and its launcher do not
already exist. Existing installations use the update procedure below. A first
installation creates a blank dedicated profile; it does not copy an account,
chat database, or browser profile from the official app.

### Prepare the local speech runtime

```sh
python3.13 setup_runtime.py
```

The bootstrap downloads pinned assets and checks their sizes and SHA-256 hashes,
installs the pinned Python dependencies in a private virtual environment, and
copies the worker into:

```text
~/Library/Application Support/ChatGPT Read Aloud/kokoro/
```

The default engine is **Kokoro 82M, MLX, float32**. The runtime includes an English
voice bank shared by the voice choices. New settings start with
`selectedVoice: null`; the bootstrap does not choose a voice for you.

If you already have a verified asset cache, inspect `setup_runtime.py --help`
for `--asset-cache` and `--python`. An asset cache needs the exact expected
`kokoro-v1_0.safetensors`, `config.json`, and `voices-v1.0.bin` files. An incomplete
or mismatched cache must fail verification. It is not a reason to disable hashes.

The bootstrap refuses an existing runtime rather than resetting its settings.
If it reports an existing path, determine whether this is an existing
installation or a partial setup. Preserve it while diagnosing the cause.

### Build and install the separate app

```sh
python3 build_copy.py
python3 install_fresh.py
```

The builder reads the official app and writes the patched copy to
`build/ChatGPT Read Aloud.app`. It updates the ASAR asset hashes and Electron's
embedded integrity digest, then signs and verifies the local copy. The official
bundle remains the build input.

The fresh installer checks the completed runtime, configures and verifies a
native launcher in private staging, creates the blank profile with private
permissions, and installs the custom app at:

```text
/Applications/ChatGPT Read Aloud.app
```

Its dedicated profile is
`~/Library/Application Support/ChatGPT Read Aloud/user-data`. The optional
launcher is `~/Applications/Launch ChatGPT Read Aloud.command`. The installer
refuses existing target/profile/launcher paths and does not launch the app.

If a first install fails before publication, it cleans up only its own unchanged
launcher and still-empty profile. If publication succeeded before a later check
failed, it preserves the new app and profile for review. Inspect that state and
run the verifier; do not delete user data or rerun a forced fresh install.

Verify the installed result with a separate local report:

```sh
python3 verify_voice_build.py \
  --app "/Applications/ChatGPT Read Aloud.app" \
  --report installed-verification.json
```

A successful source build alone does not prove that the app was installed or
that speech is audible. Complete the manual checks below after a normal launch.

### Open the app and choose a voice

Open **ChatGPT Read Aloud** from Applications or the Dock. Sign in using the
normal app flow if needed. The dedicated profile starts blank. Account-backed
content follows the app's normal sign-in and sync behavior.

Use the voice picker beside the response speaker. Preview a few voices, then
choose **Use this voice** to save your choice. **Aoede (`af_aoede`)** is an
example voice used to demonstrate this project; you can choose another voice.
Previewing or closing the picker preserves the previously saved choice. A first
attempt to read with no saved choice should open the picker.

## Updating an existing custom installation

Keep the current private profile, runtime, saved voice, launcher, activation
journal, and recorded verified backup aliases. Do not run the fresh installer or
delete those paths to make an update fit. Do not overwrite a running app bundle
or its in-use archive.

1. Review the source changes and recheck the official version and signatures.
   Confirm the current custom app has its expected identity, launcher, profile,
   and integrity markers. If the source app's version differs, stop at the guard
   and report the incompatibility.
2. Prepare a separate stage from the verified existing custom app. Its native
   launcher and dedicated profile binding must survive the clone. The default
   stage is `build/ChatGPT Read Aloud.app`. Use an APFS clone of the custom bundle
   only after checking that this destination is absent and no build/update is
   modifying the source. If a stage already exists, inspect it rather than
   deleting or nesting another app inside it.
3. Confirm that the private versioned worker matches the new canonical worker
   source. `setup_runtime.py` is a first-setup tool and refuses an existing
   runtime. If a worker migration is needed, use a reviewed migration that
   preserves settings and the previous worker needed by an earlier app. Do not
   overwrite a worker used by a running app to satisfy readiness checks.
4. Refresh and verify the separate stage:

   ```sh
   python3 build_copy.py --refresh-copy \
     --target "build/ChatGPT Read Aloud.app"
   python3 verify_voice_build.py
   python3 apply_voice_upgrade.py --check
   ```

5. Once the stage is ready, schedule the one-shot upgrade:

   ```sh
   python3 apply_voice_upgrade.py --schedule
   ```

6. Quit **ChatGPT Read Aloud** normally with **Command-Q**. Leave it closed until
   the installer reopens it. A restart while it is waiting can keep the upgrade
   blocked. The bounded waiter expires after 30 minutes without changing a
   running bundle.

The installer waits for the custom GUI and embedded CLI to exit; it never kills
them. Only narrowly verified detached native helpers can receive a bounded
shutdown signal after those processes have exited. The Dock and standalone CUA
helpers can remain when their exact relevant resources are proven unchanged.
Exemptions require exact recorded aliases, current resource proofs, and the
required process/open-file checks. GUI/CLI descendants still block activation.

The stopped-app update uses an atomic directory exchange, preserves the previous
custom bundle under a timestamped backup name, reopens the existing profile, and
checks startup for 30 seconds. Its local report is
`voice-upgrade-activation.json`. `waiting_for_quit` is not success;
`activated` with the startup proof is the expected result. A saved voice may be
recorded as an optional readiness binding; absence of a saved choice is valid
for a first-time picker flow and must not force a default voice.

If rollback is pending after a failed upgraded launch, inspect the report and
quit the custom app normally before using the installer's documented recovery:

```sh
python3 apply_voice_upgrade.py --rollback
```

Preserve the exact transaction journal and backup. Do not restore by choosing an
arbitrary similarly named app directory.

## Run the automated checks

The default browser checks use a new offline synthetic document. They do not
connect to the ChatGPT app or an existing browser session.

```sh
npm ci
npx playwright install chromium
npm test
python3 test-kokoro-worker-sentences.py
python3 -m unittest discover -p 'test_*.py'
```

The installer tests operate on temporary fixture bundles. After runtime setup,
the optional real-worker checks can validate generated WAV data without playing
it or saving a production voice choice:

```sh
python3 test-kokoro-worker.py
node --test test-kokoro-runtime.cjs
```

Keep their generated reports local. These checks complement the installed
signature/integrity verifier and the manual audible checks below.

## Check the feature in the actual app

Use a completed response with two short paragraphs and a link or inline
formatting. These checks require a person using the actual desktop app when
automation cannot control Codex.

- **Whole response:** with no selection, its speaker reads that response's
  visible text. Link labels are spoken; raw Markdown link URLs are not added.
- **Selected passage:** select part of that response and use its speaker or the
  floating **Read aloud** action. Only the selected passage is spoken. A
  selection spanning separate responses must not be accepted as one passage.
- **Code blocks:** read a response with prose before and after a code block.
  It skips the code and its header, then continues with the next paragraph.
  Selecting only the code produces no speech and never reads the whole response.
  Selecting prose across a code block reads only the selected prose; highlights
  stay on that prose. Inline code within a sentence remains included.
- **Voice:** preview a draft choice without saving; close the picker and confirm
  the saved choice remains. Save a chosen voice, quit/reopen, and confirm the next
  response uses it automatically. Stop playback before testing another choice.
- **Stop and switch:** click the active speaker again while preparing or playing
  audio. It stops promptly. Starting another response stops the earlier one.
- **Playback highlight:** the soft yellow highlight follows the sentence whose
  audio is actually playing, including the final chunk. It does not jump ahead
  to prefetched audio. It clears on stop, finish, error, preparation gaps, and
  response switching. Native blue selection and response markup remain intact.
- **Profiles and restarts:** a fresh installation uses its blank dedicated
  profile; an update retains the existing profile and voice. Reopen through both
  the normal app icon and the optional launcher.
- **Integrity:** the installed custom app verifies, and the original official
  app still verifies. Keep the local build/activation reports for diagnosis.

The CSS Custom Highlight API can safely no-op where unsupported. Native macOS
speech fallback clears the local audio highlight; it cannot promise synchronized
sentence highlighting. First local playback may take several seconds while the
model loads. A source test or valid WAV alone is not an audible UI check.

## Keep local data local

Keep bundles, generated `patched-*` assets, virtual environments, model/voice
weights, runtime settings, profiles, logs, reports, and generated audio outside
Git. The private runtime starts on demand, uses a network-denied worker, and
exits after idle time. Initial setup downloads are separate from offline speech
generation. Future official-app updates need a fresh compatibility review; they
do not automatically reapply these source patches.
