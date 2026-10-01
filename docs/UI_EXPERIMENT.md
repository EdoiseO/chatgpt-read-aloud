# Reading UI experiment

This is an isolated, **uninstalled UI experiment** based on published commit
`e63c9824105662301604bc5eed36f2783069beb5`. It addresses the three selection and
toolbar examples reported on October 1, 2026. The current installed app and the
main checkout remain unchanged.

## Scope

The experiment changes assistant-text registration, response/group controls,
selection routing, and the renderer patches that connect them. It keeps the
published installer, launcher, updater suppression, signing commands, speech
engine, runtime, and saved-voice behavior. It adds no update checker,
LaunchServices repair, certificate migration, or installation workflow.

Do not build, install, sign, register, or launch a desktop candidate as part of
these checks. Reading the official app's pinned assets for offline tests does
not launch that app. A later desktop trial needs its own explicit release plan.

## Acceptance contract for the three examples

| Example | Required behavior |
| --- | --- |
| Ordinary completed progress commentary, with no native footer | Selecting its prose offers **Read aloud**, alongside whichever native actions the host already supports. No idle speaker/voice-picker row is added. The text remains registered when native actions are hidden. |
| Ordinary completed final answer | Speech and voice choice use the existing native action row. There is no second toolbar. Selecting a passage reads exactly that passage. Copy, rating, fork, annotation, and side-chat behavior retain their native eligibility. |
| Saved voice research answer containing prose, lists, tables, and multiple parts | One completed logical answer has one footer. Whole-answer reading visits its readable parts in order. A selection within those parts offers **Read aloud**. Completed parts of an incomplete or partially loaded answer remain readable through selection, without repeated idle control pairs. |

The number of native popup actions can differ across surfaces. For example,
annotation requires host metadata and a callback. This experiment must not
invent an annotation target to make every popup look identical.

## Design boundaries

- A mounted reading controller registers completed assistant text independently
  of whether a visible toolbar exists. Registration follows the current DOM
  root and is removed when the controller unmounts or becomes ineligible.
- Visible controls are placed by the host renderer. Ordinary answers reuse the
  native row; a complete grouped voice answer has one footer.
- A selection-only controller can open voice selection or an explicit fallback
  dialog. While preparing or playing speech, it provides one temporary Stop
  control and supports Escape. It does not create a permanent extra row.
- Ownership comes from the host's logical answer and registered readable parts.
  Text equality, DOM proximity, and a shared conversation container do not make
  two answers the same owner.
- The native selection resolver is part of acceptance. A custom button mounted
  manually beside test prose does not establish that the native popup can reach
  it.
- Native actions keep the host's original range and metadata. A selection
  spanning several native text targets within one registered answer may get a
  speech-only popup. It must not acquire annotation or side-chat callbacks for
  an artificial combined target.
- Speech uses the original selected range. A host-clipped range must not cause
  speech to read a different passage. A rejected selection must not fall back
  silently to the entire answer.
- User text, activity labels, unfinished assistant text, unrelated answers, and
  stale or detached roots do not become readable through a broad container.
  Existing exclusions for fenced code and non-content UI remain in force.

## What the automated evidence must establish

### Actual host routing

Run reviewed renderer functions extracted from the original official ASAR and
patched only in memory. Check ordinary commentary before and after tool or
subagent entries, an ordinary final answer, canonical voice transcript entries,
and promoted research/list/table entries. Reuse renderer memo caches while
completion, eligibility, and text change; otherwise a one-render fixture can
miss stale behavior.

Check one native action row for an ordinary answer, no extra idle row for
commentary, one footer per complete voice answer, and selection-only access to
completed parts of an incomplete answer. Check that user and activity routes do
not gain controllers. Group projection, rendering, and navigation must agree
about the original host entry keys.

### Native selection popup and exact speech

Exercise the real resolver, popover, and menu functions on an offline DOM, then
invoke the real reading controller with a fake speech bridge. Cover:

1. A sentence in completed commentary without visible controls.
2. A passage in an ordinary final answer, including keyboard activation.
3. List items and table cells in saved research.
4. A selection crossing readable parts of one complete logical answer.
5. The same text in two separate answers; each selection must retain its owner.
6. A range crossing separate answers or ending in user/activity/unowned text.
7. The native one-endpoint clipping case; custom speech must retain the original
   range or be unavailable.
8. Fenced-code-only selections, detached roots, unmount, and eligibility changes.

Assert exact text passed to speech, native callback availability, and highlight
ownership. Counted menu labels alone do not demonstrate correct selection.
Native blue selection and response markup must survive custom highlighting.

### Lifecycle and available controls

Check saved voice, no saved voice, pending voice lookup, an explicit supported
fallback offer, synthesis delay, playback, Stop, Escape, interruption, completion,
and unmount. A selection-only controller must expose its picker/dialog and
temporary Stop control. Late promises or audio events must not resurrect a
finished session, old highlight, or controller from another answer.

### Layout

Use the reviewed host CSS and row structure at ordinary and narrow widths, with
hover, keyboard focus, and idle states. Check row count, overflow, ordering, and
layout stability. Fixtures that replace native widgets with inert boxes are
useful geometry evidence but must be labeled as such. They do not prove the
actual desktop widgets or dialogs fit and behave correctly.

## Run the local acceptance gate

From this experiment checkout:

```sh
node --test test-ui-reading-experiment.mjs
```

This standalone gate checks:

- Baseline equality of installation, updater, launcher, audio, and runtime files.
- Unchanged builder bootstrap/preload constants, path/archive safeguards,
  updater-host validation calls, and signing calls through source parsing.
- Unchanged verifier archive-integrity logic, identity/signature/profile/updater
  checks, runtime checks, and the meaning of existing report fields.
- Actual pinned host renderer/group/layout tests.
- Static verifier rejection of altered host hooks, stale grouping source, and
  missing UI markers, including optimized Python execution.
- Native selection-menu tests, actual reading-controller integration, text-map
  and highlighting tests, and voice-group boundary tests.

The gate requires the reviewed official host locally. It fails if host tests are
skipped, so missing proprietary fixtures cannot be mistaken for acceptance.
Node, Python, Playwright, and a supported browser must already be available.
`PLAYWRIGHT_MODULE_PATH` can point to an existing Playwright installation. The
gate neither installs dependencies nor runs the app builder or installer.

The scope check protects named baseline surfaces; it complements review of the
UI diff. It is not a general sandbox or a claim that arbitrary future scripts
cannot mutate an app. Use the existing unit suites as well for a full source
review. Do not add this aggregator to suites it already runs.

## Validation result — October 1, 2026

The final local acceptance gate passed: **3 checks passed, 0 failed, 0 skipped**.
It completed in 7.6 seconds using the existing Playwright installation:

```sh
PLAYWRIGHT_MODULE_PATH=/Users/edoise/Documents/Playground/chatgpt-read-aloud/node_modules/playwright \
  node --test test-ui-reading-experiment.mjs
```

All three checks passed: the baseline scope comparison; the Python host,
selection-adapter, and verifier suites; and the Node native-menu, controller,
highlighting, and grouping suites. The child test results are required to have
no failures or skips. The native-menu suite includes real controller registration
and exact speech text, not only a synthetic ownership callback. The verifier
checks include correctly rehashed archives whose host hooks have been altered,
and run with ordinary and optimized Python.

The baseline unit suite also passed: **113 tests, 0 failed, 0 skipped**.
Independent probes confirmed cancellation when eligibility changes, rejection
of selections crossing answers even after focus loss, and invalidation when
foreign prose is inserted into a pending selection. Selection-menu refresh
settled without repeated updates in the reviewed host/controller probes.

All three fully composed patched JavaScript modules passed Node syntax checks.
Each host patch reversed to its pinned original source. The installed ASAR
header still matches the restored baseline:
`277c84ea7008f9fb849ee45fef3eac7b6ca02c340dd4b177122454eab00ec092`.
The main checkout remains clean on `main` at `e63c982`.

The tested source is on `codex/ui-reading-experiment`, based on `e63c982`.
These SHA-256 values identify the production UI files used for the final run:

```text
build_copy.py                e2e23897cd11ebbc912580e4b1ee191d2beed04f9508df0dc71322115ac14743
response-button.js           7fc2287088fbeeffd21ab2c3b9a88be8ab2d79f3100994665d93d33fabd58522
response-highlight.mjs       82c20cb23312d95f7f9d5971cb6990f2046b71563468c77f8cfc2b6142eebfa8
selection_host_adapter.py    e2893c7021e4558f8f13445babbc391d0465ff5be99d2351a0c27825592cdc24
speech_host_adapter.py       1cb8ac3f778ece3d8f98f17407506e78351bda764ea48c322a1f14070bb4420a
verify_voice_build.py        b354a629cdf2d698869cc6a6330da8a3b324d4d85e6574ffa407d428fa2a375b
voice-response-group-host.js 214db9955310b1c9b78836906d7c64b48175b929db1141e6b166f199a58ec06f
voice-response-groups.mjs    e0ff854a965619285a4e17921b167d74748c15ef91c5c4cbc4f2cc3df9a8aadc
```

## Evidence limits and completion status

Offline fixtures can establish the code paths, selection text, lifecycle, and
the layout they actually render. They cannot establish audible quality, macOS
permissions, real desktop scrolling/virtualization, or a successful installed
upgrade. This experiment stays uninstalled after its automated tests pass.

Before any future desktop release, reproduce all three examples on that exact
candidate; verify the real native widgets at narrow widths, voice/fallback
dialogs, one temporary Stop control, chat switching and scrolling, exact spoken
selection, highlighting, and audible playback. Preserve commit and ASAR identity
with that evidence. Keep signing and updater work in separate changes.

## Desktop trial preparation — October 1, 2026

The user subsequently authorized trying the UI experiment. Preparation uses the
existing maintenance directory and activation journal in `codex-read-aloud`;
the published `main` checkout remains unchanged. The installed baseline was
fully verified and APFS-cloned to that maintenance directory's usual stage.

The first real packaging review found that the builder wrote
`CodexReadAloudSpeechAdapterVersion`, while verification expected
`CodexReadAloudSpeechHostAdapterVersion`. The builder now writes the expected
key. A regression test executes the actual builder assignment against the
verifier fixture, so a duplicated fixture value cannot hide this mismatch.
The full UI acceptance gate passed again, including this additional test.

The candidate was built and passed optimized verification of all 20,353 packed
assets, code signatures, embedded archive integrity, adapter 5, source payloads,
profile binding, and existing Aoede settings. Candidate ASAR header:
`5f3a5e454c8245a15705714817694a305115915bc8204f8eacea2d9cca153079`.

The existing launcher was retained; no recompilation, runtime migration,
certificate change, or updater implementation change was needed. The unchanged
maintenance installer passed its preflight. It will retain the previous app and
wait for a normal Quit before replacement. A successful source/stage check is
not evidence that this candidate has launched or that its speech is audible.

Local evidence is in `output/desktop-trial/`. The original activation journal
and readiness report are preserved there before scheduling. macOS access
prompts can still recur with the existing ad-hoc signing method. After the trial
starts, check installed verification and canonical launch registration, then
test the three UI examples and Stop/Escape in the actual app.
