# Hover and selection follow-up — October 1, 2026

**Current status — October 2:** adapter 6 from source commit `3d0336c` is
installed. The user reports this version is very stable and approved publishing
it to `main`. The changes cover native hover behavior, larger same-answer
selections, and the compact Stop control.

## User-visible problems and causes

### 1. Speech controls remained visible after pointer leave

Confirmed regression in the UI trial at `1d7197e`. The custom pair was appended
beside the native action wrapper. The host applies hover/focus opacity to that
inner wrapper, not the whole footer. The previous layout test explicitly expected
speech controls to remain visible while Copy/rating/fork were hidden, so its
passing result did not validate the requested interaction.

The pair now sits inside the native visibility wrapper after Copy. Compiler memo
dependencies include the custom pair so Read/Stop and selected-text labels update
when native props remain identical. Playback and an open voice picker keep their
controls reachable. Grouped voice footers use direct-child scoped hover/focus CSS;
adding a generic hover group would incorrectly reveal controls in nested cards.

### 2. Expanding a selected paragraph into research headings removed Read aloud

Reproduced with the actual pinned transcript/research renderers, controller,
native selection resolver/menu, and browser selection geometry. The group
controller previously mounted only for a fully completed answer. Partially loaded
or unresolved voice answers retained individual paragraph controllers but lacked
a shared registered owner for the expanded selection. The native selection menu
then rejected the range spanning two text targets.

The group controller now remains registered for its completed, explicitly owned
parts. Whole-answer footer eligibility remains separate. A paragraph-to-heading
selection can be read even when other work, unresolved artifacts, or unfinished
text exists outside the selection. Selected unfinished/foreign prose, missing
roots, and ranges across unrelated answers are still rejected. No arbitrary
conversation container is read.

The screenshot-shaped regression fails against the deployed group renderer:
small paragraph selection has Read aloud, the expanded range has no popup. It
passes against the corrected source. Tests also cover real clipping/scrolling
geometry, 320px windows, and fully offscreen selection suppression.

The exact live historical group metadata was unavailable through the native
accessibility interface. The live tree confirms separate assistant blocks and
no shared footer around the supplied research example; the partial/unresolved
classification is supported by the reproduction, rather than claimed as a direct
inspection of that live metadata. Legacy content with no explicit shared owner
remains limited to its individual registered response.

### 3. The temporary Stop control was too prominent

The large outlined pill now uses the pinned host's native compact ghost button:
a muted square icon and the short label **Stop**. It has a transparent idle
background and border, no shadow, and native hover and keyboard-focus feedback.
The hit area is 24px high and about 60px wide. Its accessible name remains
“Stop reading aloud,” with an Escape hint in the tooltip.

Position and cancellation behavior are unchanged. The control remains visible
during selection playback even when the pointer leaves the response. An offline
browser fixture renders the actual native button and bundled CSS; its preview
is saved locally at `output/playwright/selection-stop-native-dark.png`.

## Platform references

A DOM Range can span multiple nodes under a common ancestor; selection length
is not the restriction here. The integration must resolve the relevant owner
and preserve its endpoints. See [MDN Range.commonAncestorContainer](https://developer.mozilla.org/en-US/docs/Web/API/Range/commonAncestorContainer).
Hover and keyboard focus are distinct states; the control must support both.
See [MDN CSS pseudo-classes](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/Pseudo-classes).

## Final source validation

- UI acceptance gate: 3 passed, no failures or skips.
- Unit suite: 114 passed, no failures or skips.
- Native selection suite: 30 passed, including actual viewport geometry.
- Host adapter suite: 11 passed, including ordinary and grouped hover/focus CSS
  and actual native Stop-button styling, click, and keyboard activation.
- Existing reading-controller integration checks cover Stop and Escape.
- The three composed host modules pass JavaScript syntax checks and adapter
  restoration checks against the pinned official source.
- Independent review checked cancellation, pending/foreign content rejection,
  native memo-cache reuse, and nested hover behavior.
- `git diff --check` passed. At the source-validation stage, the installed app
  remained unchanged.

## Deployment and evidence limits

Adapter 6 was installed on October 1. The installed archive header is
`dcb9f32a777fb66d83370ee21364629040d4178df715c1628c6b85cedd372577`.
Full verification checked 20,353 packed assets, code signatures, embedded archive
integrity, exact UI payloads, profile binding, and preserved Aoede settings.

Low disk space and the retained-backup limit initially blocked preparation.
The user approved removing three unused older backups, while preserving the
running app and GitHub baseline. The existing installer naturally omitted those
missing aliases in the next transaction; its limit and code were unchanged.

The first activation entered recovery one second before the current app process
started. Startup timing is a possible cause; the installer did not record the
original exception. A subsequent full startup check passed twice. A reviewed
manual recovery preserved the failed journal and previous build, cancelled only
the matching recovery waiter, acquired the activation lock, and repeated bundle,
process, resource, profile, and startup checks before recording completion.
This is not a new installer feature or a general recovery command.

On October 2, the user reported stable desktop use. This confirms their
experience on this installation; it does not establish compatibility with a
new official release or another Mac. The initial activation failure remains a
known diagnostic limitation. Installer, updater, signing, and speech-runtime
source are unchanged by this UI release. Private deployment and cleanup records
remain local and are excluded from Git.
