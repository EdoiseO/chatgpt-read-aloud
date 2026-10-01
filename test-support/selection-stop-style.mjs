// The shipped stop presentation is evaluated with the actual pinned native
// button renderer and CSS. Playback/cancellation is covered by integration tests.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
let input = '';
for await (const part of process.stdin) input += part;
const native = JSON.parse(input);
const source = readFileSync(new URL('../response-button.js', import.meta.url), 'utf8');
const start = source.indexOf('selectionOnly && busy ? Y.jsx("div", {');
const suffix = '}) : null';
const end = source.indexOf(suffix + ', pickerOpen ?', start);
assert.ok(start > 0 && end > start, 'The real transient Stop presentation must be present');
const presentation = source.slice(start, end + suffix.length);
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 760, height: 460 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent('<html data-theme="dark" data-codex-window-type="electron" data-codex-os="darwin"><body><main><h2>Research update</h2><p>The selected passage is being read aloud.</p><p>Use the quiet Stop control whenever you want to end playback.</p></main><div id="control"></div></body></html>');
  await page.addStyleTag({ content: native.css });
  await page.addStyleTag({ content: 'body{margin:0;padding:48px;background:#191919}main{max-width:550px;font:15px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--color-text)}h2{font-weight:600;font-size:20px;margin-bottom:12px}p{margin-bottom:12px}' });
  await page.evaluate(({ native, presentation }) => {
    const Y = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('fragment') };
    const memo = { c(size) { return Array(size).fill(Symbol.for('react.memo_cache_sentinel')); } };
    const classes = (...values) => values.flat(Infinity).filter(Boolean).join(' ');
    const constants = Object.fromEntries(Object.entries(native.constants).map(([name, text]) => [name, new Function('return (' + text + ')')()]));
    const Dr = new Function('Oci', 'o5', 'q', 'Aci', 'jci', 'Mci', 'lci', 'xci', native.button + ';return Dci;')(
      memo, Y, classes, constants.Aci, constants.jci, constants.Mci, constants.lci, 'spinner');
    const actualPresentation = new Function('Y', 'Dr', 'selectionOnly', 'busy', 'stopReading', 'return (' + presentation + ');');
    const host = document.querySelector('#control');
    let busy = true, stops = 0;
    function dom(tree, inSvg = false) {
      if (tree == null || typeof tree === 'boolean') return null;
      if (Array.isArray(tree)) {
        const fragment = document.createDocumentFragment();
        for (const child of tree) { const rendered = dom(child, inSvg); if (rendered) fragment.append(rendered); }
        return fragment;
      }
      if (typeof tree !== 'object') return document.createTextNode(String(tree));
      if (typeof tree.type === 'function') return dom(tree.type(tree.props), inSvg);
      inSvg ||= tree.type === 'svg';
      const node = typeof tree.type === 'symbol' ? document.createDocumentFragment() : inSvg
        ? document.createElementNS('http://www.w3.org/2000/svg', tree.type) : document.createElement(tree.type);
      for (const [key, value] of Object.entries(tree.props ?? {})) {
        if (key === 'children' || value == null) continue;
        if (key === 'style') Object.assign(node.style, value);
        else if (key === 'onClick') node.addEventListener('click', value);
        else if (key === 'className') node.setAttribute('class', value);
        else if (typeof value === 'boolean') { if (key.startsWith('aria-')) node.setAttribute(key, String(value)); else if (value) node.setAttribute(key, ''); }
        else node.setAttribute(key, String(value));
      }
      const children = tree.props?.children;
      for (const child of Array.isArray(children) ? children : [children]) { const rendered = dom(child, inSvg); if (rendered) node.append(rendered); }
      return node;
    }
    function render() {
      const tree = actualPresentation(Y, Dr, true, busy, () => { stops++; busy = false; render(); });
      const node = dom(tree); host.replaceChildren(...(node ? [node] : []));
    }
    window.stopFixture = { restart() { busy = true; render(); }, count: () => stops };
    render();
  }, { native, presentation });
  const stop = page.locator('[data-codex-local-read-aloud="selection-stop"]');
  const appearance = () => stop.evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const status = element.parentElement, placement = getComputedStyle(status), svg = element.querySelector('svg');
    return { width: rect.width, height: rect.height, fontSize: style.fontSize, background: style.backgroundColor,
      color: style.color, tokenColor: style.getPropertyValue('--color-text-tertiary').trim(), borderColor: style.borderColor,
      shadow: style.boxShadow, radius: style.borderRadius, opacity: style.opacity, label: element.getAttribute('aria-label'),
      title: element.title, text: element.textContent, svgHidden: svg.getAttribute('aria-hidden'),
      position: placement.position, right: placement.right, bottom: placement.bottom };
  });
  await page.mouse.move(5, 5);
  const idle = await appearance();
  assert.equal(idle.text, 'Stop');
  assert.equal(idle.label, 'Stop reading aloud');
  assert.equal(idle.title, 'Stop reading aloud (Esc)');
  assert.equal(idle.svgHidden, 'true');
  assert.ok(idle.width >= 48 && idle.width <= 90, `Compact native width: ${idle.width}`);
  assert.equal(idle.height, 24, 'Native compact provides a 24px high hit area');
  assert.equal(idle.fontSize, '12px');
  assert.equal(idle.background, 'rgba(0, 0, 0, 0)');
  assert.equal(idle.borderColor, 'rgba(0, 0, 0, 0)');
  assert.equal(idle.shadow, 'none');
  assert.equal(idle.opacity, '1', 'Active Stop stays visible without hover');
  assert.equal(idle.position, 'fixed');
  assert.equal(idle.right, '24px');
  assert.equal(idle.bottom, '96px');
  await stop.hover();
  assert.notEqual((await appearance()).background, idle.background, 'Native ghost hover feedback remains');
  await page.mouse.move(5, 5);
  await page.keyboard.press('Tab');
  assert.equal(await stop.evaluate(element => element.matches(':focus-visible')), true);
  assert.notEqual((await appearance()).shadow, 'none', 'Native keyboard focus ring remains visible');
  await page.evaluate(() => document.activeElement.blur());
  const output = new URL('../output/playwright/', import.meta.url);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: new URL('selection-stop-native-dark.png', output).pathname });
  await stop.click();
  assert.equal(await page.evaluate(() => stopFixture.count()), 1);
  assert.equal(await stop.count(), 0, 'Click delegates to the Stop callback and removes the active control');
  await page.evaluate(() => stopFixture.restart());
  await stop.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => stopFixture.count()), 2, 'Native keyboard activation invokes Stop');
  await context.close();
  process.stdout.write('Native selection Stop style verified\n');
} finally { await browser.close(); }
