// A fresh offline browser renders actual pinned row structure and host CSS.
// Complex host widgets are inert 20px controls: only geometry and visibility
// are checked here, not the desktop app or speech playback.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
let input = '';
for await (const part of process.stdin) input += part;
const { layouts, css } = JSON.parse(input);
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 600 } });
  const page = await context.newPage();
  await page.setContent('<html data-codex-window-type="electron"><body></body></html>');
  await page.addStyleTag({ content: css });
  await page.addStyleTag({ content: 'body{margin:0;padding:40px;--spacing:4px;--thread-content-max-width:680px} [data-probe-response]{width:680px;margin-bottom:32px} [data-probe-control]{height:20px;line-height:20px;box-sizing:border-box} button[data-probe-control]{display:inline-flex;align-items:center;justify-content:center;width:20px;padding:0;border:0;font-size:0} [data-probe-control="time"]{font-size:12px}' });
  await page.evaluate(layouts => {
    function node(value) {
      if (typeof value === 'string') return document.createTextNode(value);
      const element = value.tag === 'fragment' ? document.createDocumentFragment() : document.createElement(value.tag);
      for (const [key, content] of Object.entries(value.attrs)) element.setAttribute(key, String(content));
      for (const child of value.children) element.append(node(child));
      return element;
    }
    window.installLayout = (layout, id) => {
      const replacement = node(layout), previous = document.querySelector(`[data-probe-response="${id}"]`);
      if (previous) previous.replaceWith(replacement); else document.body.append(replacement);
    };
    document.body.append(node(layouts.ordinary), node(layouts.progress), node(layouts.persistent));
  }, layouts);
  await page.mouse.move(890, 590);
  async function state(id) {
    return page.evaluate(id => {
      const root = document.querySelector(`[data-probe-response="${id}"]`);
      const controls = {};
      for (const button of root.querySelectorAll('[data-probe-control]')) {
        let opacity = 1;
        for (let parent = button; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
        const box = button.getBoundingClientRect();
        controls[button.dataset.probeControl] = { x: box.x, y: box.y, centerY: box.y + box.height / 2, width: box.width, height: box.height, opacity, label: button.getAttribute('aria-label') };
      }
      return { controls, rows: root.querySelectorAll('[data-codex-local-read-aloud="response-controls"]').length };
    }, id);
  }
  const hidden = await state('ordinary');
  assert.equal(hidden.rows, 1);
  assert.deepEqual(Object.keys(hidden.controls).sort(), ['copy', 'fork', 'rating', 'read', 'time', 'voice']);
  for (const [name, control] of Object.entries(hidden.controls)) assert.equal(control.opacity, 0, `${name} must hide together when idle and not hovered`);
  const centers = Object.values(hidden.controls).map(control => control.centerY);
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'All controls must share one row center');
  assert.equal(hidden.controls.read.x > hidden.controls.copy.x, true);
  assert.equal(hidden.controls.voice.x < hidden.controls.rating.x, true);
  await page.hover('[data-probe-response="ordinary"]');
  const hovered = await state('ordinary');
  for (const control of Object.values(hovered.controls)) assert.equal(control.opacity, 1);
  assert.deepEqual(Object.values(hovered.controls).map(control => [control.x, control.y]),
    Object.values(hidden.controls).map(control => [control.x, control.y]), 'Hover must not shift controls');
  await page.mouse.move(890, 590);
  for (const control of Object.values((await state('ordinary')).controls)) assert.equal(control.opacity, 0, 'Pointer leave must hide speech with native actions');
  await page.locator('[data-probe-response="ordinary"] [data-probe-control="read"]').focus();
  for (const control of Object.values((await state('ordinary')).controls)) assert.equal(control.opacity, 1);
  await page.evaluate(() => document.activeElement.blur());
  for (const control of Object.values((await state('ordinary')).controls)) assert.equal(control.opacity, 0, 'Keyboard focus leaving the row must restore the idle policy');
  // These are rerenders of the same actual Xb instance, including its compiler
  // cache, exported by the host probe. The browser uses original pinned CSS.
  for (const layout of ['active', 'picker']) {
    await page.evaluate(value => window.installLayout(value, 'ordinary'), layouts[layout]);
    const showing = await state('ordinary');
    for (const name of ['copy', 'read', 'voice', 'rating', 'fork']) assert.equal(showing.controls[name].opacity, 1,
      `${name} stays reachable during ${layout} even after pointer and focus leave`);
    if (layout === 'active') assert.equal(showing.controls.read.label, 'Stop reading aloud');
  }
  await page.evaluate(value => window.installLayout(value, 'ordinary'), layouts.stopped);
  for (const control of Object.values((await state('ordinary')).controls)) assert.equal(control.opacity, 0, 'Stopping restores native idle hiding');
  const persistent = await state('persistent');
  for (const name of ['copy', 'read', 'voice', 'rating', 'fork']) assert.equal(persistent.controls[name].opacity, 1,
    'Speech must preserve native always-show/persistent action policy');
  const progress = await state('progress');
  assert.equal(progress.rows, 0, 'Selection-readable commentary must not add a permanent row');
  assert.deepEqual(progress.controls, {});
  await page.locator('[data-probe-response="ordinary"] [data-probe-control="voice"]').focus();
  // Constrained panes may wrap, but controls must stay inside their action row.
  // These use the same inert widgets, not the full native rating/action menus.
  for (const width of [320, 240]) {
    await page.setViewportSize({ width: width + 80, height: 600 });
    await page.evaluate(width => {
      for (const root of document.querySelectorAll('[data-probe-response]')) root.style.width = `${width}px`;
    }, width);
    const panes = await page.evaluate(() => [...document.querySelectorAll('[data-probe-response]')].map(root => {
      // Preserve the native row's small negative left margin for icon alignment.
      const outer = root.querySelector('[data-codex-local-read-aloud="response-controls"]')?.getBoundingClientRect();
      return { width: root.clientWidth, scrollWidth: root.scrollWidth,
        inside: [...root.querySelectorAll('[data-probe-control]')].every(button => {
          const box = button.getBoundingClientRect();
          return box.left >= outer.left && box.right <= outer.right;
        }) };
    }));
    for (const pane of panes) {
      assert.ok(pane.scrollWidth <= pane.width, `No control overflow at width ${width}`);
      assert.equal(pane.inside, true, `Controls stay inside the host action row at width ${width}`);
    }
    for (const id of ['ordinary']) {
      const narrow = await state(id);
      assert.equal(narrow.controls.read.opacity, 1);
      assert.equal(narrow.controls.voice.opacity, 1);
    }
  }
  await context.close();
  process.stdout.write('Host action layout verified in an offline browser\n');
} finally {
  await browser.close();
}
