// Reproducible screenshots of isolated sample pages. No installed app, audio,
// accounts, existing browser contexts, or network requests are used.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import './prepare_demo.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'output/playwright');
const images = path.join(root, 'docs/images');
mkdirSync(images, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, offline: true });
  for (const [kind, name] of [['selection', 'read-selection'], ['playback', 'sentence-highlight'], ['voice', 'voice-picker']]) {
    const page = await context.newPage();
    await page.setContent(readFileSync(path.join(out, `demo-${kind}.html`), 'utf8'));
    if (kind === 'selection') assert.match(await page.evaluate(() => getSelection().toString()), /Break the work/);
    if (kind === 'playback') assert.equal(await page.evaluate(() => CSS.highlights.has('codex-read-aloud-active-sentence')), true);
    if (kind === 'voice') assert.equal(await page.locator('select').inputValue(), 'af_aoede');
    const output = path.join(out, `${name}.png`);
    await page.screenshot({ path: output, scale: 'css' });
    copyFileSync(output, path.join(images, `${name}.png`));
    console.log(`Captured ${name}.png (standalone feature demonstration)`);
    await page.close();
  }
  await context.close();
} finally {
  await browser.close();
}
