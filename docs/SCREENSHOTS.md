# Screenshot provenance

The README images are **standalone feature demonstrations**, captured in a new
browser with generic sample text. They are not screenshots of a signed-in
desktop application. No personal chats, account details, sidebar, desktop,
notifications, profiles, or generated speech are included.

| Image | What is shown |
| --- | --- |
| [Read a selection](images/read-selection.png) | Native blue text selection and an illustrated floating **Read aloud** action |
| [Follow a sentence](images/sentence-highlight.png) | The actual `response-highlight.mjs` text map and CSS Custom Highlight helper applied to one sentence; playback is illustrated |
| [Choose a voice](images/voice-picker.png) | The actual `voice-picker.js` component rendered with sample voice metadata, showing **Aoede (`af_aoede`)** |

The response card and toolbar are a documentation shell. The images explain the
controls without distributing any original app-renderer assets. The demo's
preview/save buttons do not connect to a worker or play audio. The installed
feature's real preview/save behavior is tested separately.

To regenerate all three images:

```sh
npm ci
npx playwright install chromium
node scripts/capture_demo.mjs
```

This writes intermediate HTML and PNGs to ignored `output/playwright/` and copies
the three final PNGs to `docs/images/`. It creates a fresh offline browser
context; it never attaches to Codex, an existing browser, or an account session.
The viewport is 1200×760; font rendering can vary by operating system.

To inspect the standalone pages manually, run `npm run demo:prepare`, then serve
only the generated directory locally:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory output/playwright
```

Open `/demo-selection.html`, `/demo-playback.html`, or `/demo-voice.html` at the
local server. Stop the server when finished. No speech model is required for
these documentation demonstrations.
