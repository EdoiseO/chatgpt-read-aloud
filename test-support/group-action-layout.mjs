// Render the real group component and installed speech CSS in an offline
// browser. Child host widgets are inert; this tests visibility ownership only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { RESPONSE_HIGHLIGHT_CSS } from '../response-highlight.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
let input = '';
for await (const part of process.stdin) input += part;
const { css } = JSON.parse(input);
const jsx = (type, props) => ({ type, props });
const ctx = vm.createContext({ dA: { useRef: () => ({ current: null }) },
  fA: { jsx, jsxs: jsx }, iA: 'host-child', CodexLocalReadAloudButton: 'speech' });
vm.runInContext(readFileSync(new URL('../voice-response-group-host.js', import.meta.url), 'utf8'), ctx);
const group = { text: 'A research introduction. A research conclusion.', completed: true,
  partIds: ['one', 'two'], children: [
    { type: 'voice-transcript', turnKey: 'one' }, { type: 'voice-transcript', turnKey: 'two' },
  ] };
function layout(state = {}, completed = true) {
  const tree = ctx.CodexVoiceReadGroup({ entry: { turnKey: 'group-owner',
    block: { codexReadAloudGroup: { ...group, completed } } } });
  function dom(node) {
    if (node == null || typeof node === 'boolean') return null;
    if (typeof node !== 'object') return String(node);
    if (node.type === 'speech') return dom(node.props.renderContent(jsx('span', { children: [
      jsx('button', { 'data-control': 'read', 'aria-label': state.busy ? 'Stop reading aloud' : 'Read this response aloud', children: 'Read' }),
      jsx('button', { 'data-control': 'voice', children: 'Voice' }),
    ] }), state));
    if (node.type === 'host-child') return dom(jsx('div', { className: 'group',
      'data-part': node.props.entry.turnKey, children: [
        jsx('p', { children: `Research prose ${node.props.entry.turnKey}` }),
        jsx('div', { className: 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          children: jsx('button', { 'data-native': node.props.entry.turnKey, children: 'Native' }) }),
      ] }));
    const attrs = {};
    for (const [name, value] of Object.entries(node.props ?? {})) {
      if (name === 'className') attrs.class = value;
      else if ((name.startsWith('data-') || name.startsWith('aria-')) && value != null) attrs[name] = value;
    }
    const children = node.props?.children;
    return { tag: node.type, attrs, children: (Array.isArray(children) ? children : [children]).map(dom).filter(value => value != null) };
  }
  return dom(tree);
}
const layouts = { idle: layout(), active: layout({ busy: true }), picker: layout({ pickerOpen: true }), partial: layout({}, false) };
const browser = await chromium.launch(existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 650 } });
  const page = await context.newPage();
  await page.setContent('<html data-codex-window-type="electron"><body><main><aside>Outside the answer</aside></main></body></html>');
  await page.addStyleTag({ content: css + '\n' + RESPONSE_HIGHLIGHT_CSS + '\nbody{padding:40px;--spacing:4px}main{width:640px}aside{height:70px}[data-part]{padding:8px}[data-codex-read-aloud-group]{border:1px solid transparent}' });
  await page.evaluate(() => {
    function node(value) {
      if (typeof value === 'string') return document.createTextNode(value);
      const element = document.createElement(value.tag);
      for (const [name, content] of Object.entries(value.attrs)) element.setAttribute(name, content);
      for (const child of value.children) element.append(node(child));
      return element;
    }
    window.installGroup = value => {
      const previous = document.querySelector('[data-codex-read-aloud-group]');
      if (previous) previous.replaceWith(node(value)); else document.querySelector('main').append(node(value));
    };
  });
  const install = value => page.evaluate(value => window.installGroup(value), value);
  const opacity = selector => page.$eval(selector, element => {
    let value = 1;
    for (; element; element = element.parentElement) value *= Number(getComputedStyle(element).opacity);
    return value;
  });
  const hidden = async () => { for (const name of ['read', 'voice']) assert.equal(await opacity(`[data-control="${name}"]`), 0); };
  const visible = async () => { for (const name of ['read', 'voice']) assert.equal(await opacity(`[data-control="${name}"]`), 1); };
  await install(layouts.idle);
  await page.mouse.move(880, 630);
  await hidden();
  await page.hover('[data-part="one"] p');
  await visible();
  assert.equal(await opacity('[data-native="one"]'), 1);
  assert.equal(await opacity('[data-native="two"]'), 0, 'Hovering one answer part must not reveal native actions in a sibling part');
  await page.mouse.move(880, 630);
  await hidden();
  await page.locator('[data-control="voice"]').focus();
  await visible();
  assert.equal(await opacity('[data-native="one"]'), 0, 'Focusing the shared footer must not reveal native actions in a child card');
  await page.evaluate(() => document.activeElement.blur());
  await hidden();
  // A surrounding native hover group must not control this answer's footer.
  await page.$eval('main', element => element.classList.add('group'));
  await page.hover('aside');
  await hidden();
  await page.$eval('main', element => element.classList.remove('group'));
  await page.mouse.move(880, 630);
  for (const phase of ['active', 'picker']) {
    await install(layouts[phase]);
    await visible();
    if (phase === 'active') assert.equal(await page.locator('[data-control="read"]').getAttribute('aria-label'), 'Stop reading aloud');
    assert.equal(await opacity('[data-native="two"]'), 0, 'Playback must not force child native actions visible');
  }
  await install(layouts.idle);
  await hidden();
  await install(layouts.partial);
  assert.equal(await page.locator('[data-codex-local-read-aloud="response-controls"]').count(), 0, 'Partial selection-readable answers have no idle toolbar');
  await context.close();
  process.stdout.write('Group footer visibility verified in an offline browser\n');
} finally { await browser.close(); }
