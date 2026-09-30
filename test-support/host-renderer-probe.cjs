// Executes only the reviewed response render functions, with inert dependency
// stubs. It cannot load the host app, Electron, files, or network modules.
const assert = require('node:assert/strict');
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  const functions = JSON.parse(input);
  const identity = value => value;
  const jsx = (type, props) => ({ type, props });
  const caches = new Map();
  let renderer;
  const compiler = { c(size) { const key = renderer + ':' + size; if (!caches.has(key)) caches.set(key, Array(size).fill(Symbol.for('react.memo_cache_sentinel'))); return caches.get(key); } };
  const react = { useRef: () => ({ current: null }), useEffect() {}, useEffectEvent: identity };
  const ctx = {
    ix: compiler, px: compiler, ax: react, mx: { Fragment: 'fragment' },
    Y: { jsx, jsxs: jsx, Fragment: 'fragment' }, hx: { jsx, jsxs: jsx },
    ci: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
    d: () => ({ value: { routeKind: 'local-thread', routeTemplate: '/local' } }),
    ot: () => false, le: () => false, yi: () => null,
    J: (...values) => values.filter(Boolean).join(' '),
    yl: identity, yb: identity, Rh: identity, Mt: identity, Xa: identity,
    cc: identity, xd: identity, sr: identity, Gp: identity, Xs: identity, l: identity,
    Ay: () => [], Fb: () => ({}), vb: () => ({}), Dl: identity, Sr: identity,
    cx: [], sx: [], Ll: {}, zb: {},
    CodexLocalReadAloudButton: function Speech() {},
  };
  for (const name of ['uo', 'na', 'ux', 'Nf', 'fc', 'As', 'Ju', 'fu', 'lu', 'Kb',
    'ph', 'Rv', 'Dm', 'rh', 'kb', 'D', '_h', 'fg', 'gg', 'hl', 'Jl', 'C', 'ui', 'ox',
    'yy', 'gy', 'Yr', 'xl', '$t', 'Wd', 'Tg', 'ft', 'qi', 'Dr', 'G', 'Iu', 'xy', 'lg',
    'Zb', 'Qb', '_g']) ctx[name] ??= name;
  vm.createContext(ctx);
  vm.runInContext(Object.values(functions).join('\n'), ctx, { timeout: 1000 });
  function render(name, props, key = name) {
    renderer = key;
    ctx.__props = props;
    return vm.runInContext(`${name}(__props)`, ctx, { timeout: 1000 });
  }
  function nodes(tree, type, result = []) {
    if (!tree || typeof tree !== 'object') return result;
    if (tree.type === type) result.push(tree);
    const children = tree.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) nodes(child, type, result);
    return result;
  }
  function response(props, key) {
    const tree = render('Vb', { conversationId: 'fixture', assistantCopyText: 'A completed sentence.',
      item: { type: 'assistant-message', content: 'A completed sentence.', completed: true, phase: null }, ...props }, key);
    const action = nodes(tree, ctx.Xb)[0];
    return { tree, action, row: action ? render('Xb', action.props, key + '-row') : null };
  }
  const speech = row => nodes(row, ctx.CodexLocalReadAloudButton);
  const ordinary = response({ after: jsx('edit-card', { children: 'Edited file' }) }, 'ordinary');
  assert.equal(speech(ordinary.row).length, 1);
  assert.equal(ordinary.row.props.children[0].type, ctx.CodexLocalReadAloudButton);
  assert.match(ordinary.row.props.children[1].props.className, /opacity-0/);
  assert.equal(ordinary.row.props.children[0].props.getText(), 'A completed sentence.');
  assert.equal(ordinary.tree.props.className, 'group flex min-w-0 flex-col');
  const scopedRoot = { id: 'this-response-only' };
  ordinary.tree.props.ref.current = { querySelector(selector) {
    assert.equal(selector, '[data-selected-text-overlay-target]'); return scopedRoot;
  } };
  assert.equal(ordinary.row.props.children[0].props.getRoot(), scopedRoot);
  const finalFragment = ordinary.tree.props.children.at(-1);
  const order = finalFragment.props.children;
  assert.ok(order.findIndex(node => nodes(node, 'edit-card').length) < order.findIndex(node => node?.type === ctx.Xb));
  const streaming = { type: 'assistant-message', content: 'A completed sentence.', completed: false, phase: null };
  assert.equal(speech(response({ item: streaming }, 'streaming').row).length, 0);
  const copyWhileStreaming = response({ item: streaming, allowCopyWhileStreaming: true }, 'copy-stream');
  assert.equal(speech(copyWhileStreaming.row).length, 0);
  assert.ok(nodes(copyWhileStreaming.row, 'ft').length > 0);
  // Reuse the compiler cache with identical copy text across completion.
  assert.equal(speech(response({ allowCopyWhileStreaming: true }, 'copy-stream').row).length, 1);
  assert.equal(response({ showActionRow: false }, 'silent').action, undefined);
  assert.equal(speech(response({ assistantCopyText: '', item: { ...streaming, content: '', completed: true } }, 'empty').row).length, 0);
  const transcript = render('fx', { conversationId: 'fixture', entries: [
    { role: 'user', text: 'User words' }, { role: 'assistant', text: 'Transcript response.' },
    { role: 'assistant', text: '## Research\n\n| Name | Value |\n| --- | --- |\n| One | Two |' },
  ] });
  assert.equal(nodes(transcript, '_g')[0].props.hideActions, true);
  const assistants = nodes(transcript, ctx.Vb);
  assert.equal(assistants.length, 2);
  for (const [index, node] of assistants.entries()) {
    assert.equal(node.props.showActionRow, true);
    assert.equal(node.props.item.completed, true);
    assert.equal(speech(response(node.props, 'transcript-' + index).row).length, 1);
  }
  // Xb is shared with host views beyond Vb. A copyable row without the explicit
  // completed-response routing must not acquire speech controls accidentally.
  assert.equal(speech(render('Xb', { copyText: 'Unrelated copyable content' }, 'unrelated')).length, 0);
  process.stdout.write('Host renderer boundaries verified\n');
});
