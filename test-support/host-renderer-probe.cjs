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
  const refs = new Map();
  let renderer;
  let refIndex;
  const compiler = { c(size) { const key = renderer + ':' + size; if (!caches.has(key)) caches.set(key, Array(size).fill(Symbol.for('react.memo_cache_sentinel'))); return caches.get(key); } };
  const react = { useRef(initial) { const key = renderer + ':ref:' + refIndex++; if (!refs.has(key)) refs.set(key, { current: initial }); return refs.get(key); }, useEffect() {}, useEffectEvent: identity };
  const atoms = { realtime: undefined, item: undefined, turn: undefined, compact: false };
  // Y is the JSX binding in the response module and the atom reader in the
  // voice-history module. A callable stub with JSX properties serves both
  // isolated functions without evaluating either module's imports.
  const Y = Object.assign(atom => ({ wn: atoms.realtime, D: atoms.item, C: atoms.turn })[atom],
    { jsx, jsxs: jsx, Fragment: 'fragment' });
  const ctx = {
    ix: compiler, px: compiler, Mk: compiler, Lk: compiler, sO: compiler, ax: react, mx: { Fragment: 'fragment' },
    Y, hx: { jsx, jsxs: jsx }, Nk: { jsx, jsxs: jsx }, Rk: { jsx, jsxs: jsx, Fragment: 'fragment' }, uO: { jsx, jsxs: jsx },
    ci: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
    d: () => ({ value: { routeKind: 'local-thread', routeTemplate: '/local' } }),
    ot: atom => atom === 'Nf' ? atoms.compact : false,
    le: atom => atom === 'Wd' ? true : atom === '$t' ? { submitCodexAnalyticsEvent() {} } : false, yi: () => null,
    J: (...values) => values.filter(Boolean).join(' '),
    yl: identity, yb: identity, Rh: identity, Mt: identity, Xa: identity,
    cc: identity, xd: identity, sr: identity, Gp: identity, Xs: identity, l: identity,
    Ay: () => [], Fb: () => ({}), vb: () => ({}), Dl: identity, Sr: identity,
    Hl: root => ({ htmlText: root.html }), tm: (key, id) => key + ':' + id,
    kn: text => [{ type: 'inline-markdown', content: text.replace('::codex-realtime-inline{}\n', '') }],
    tu: () => ({ data: [] }), dO: [], ND: 'WorkItem', Di: () => null,
    cx: [], sx: [], Ll: {}, zb: {},
    CodexLocalReadAloudButton: function Speech() {},
  };
  for (const name of ['uo', 'na', 'ux', 'Nf', 'fc', 'As', 'Ju', 'fu', 'lu', 'Kb',
    'ph', 'Rv', 'Dm', 'rh', 'kb', 'D', '_h', 'fg', 'gg', 'hl', 'Jl', 'C', 'ui', 'ox',
    'yy', 'gy', 'Yr', 'xl', '$t', 'Wd', 'Tg', 'ft', 'qi', 'Dr', 'G', 'Iu', 'xy', 'lg',
    'Zb', 'Qb', '_g', 'wn', 'Uy', 'Vy']) ctx[name] ??= name;
  vm.createContext(ctx);
  vm.runInContext(Object.values(functions).join('\n'), ctx, { timeout: 1000 });
  ctx.Kv = ctx.Vb; // Exact import alias used by both canonical voice renderers.
  function render(name, props, key = name) {
    renderer = key;
    refIndex = 0;
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
    const controller = render('Vb', { conversationId: 'fixture', assistantCopyText: 'A completed sentence.',
      item: { type: 'assistant-message', content: 'A completed sentence.', completed: true, phase: null }, ...props }, key);
    assert.equal(controller.type, ctx.CodexLocalReadAloudButton, 'The controller stays mounted even while registration is disabled');
    assert.equal(typeof controller.props.renderContent, 'function');
    const tree = controller.props.renderContent(controller.props.enabled ? jsx('SpeechPair', controller.props) : null);
    const actions = nodes(tree, ctx.Xb);
    assert.ok(actions.length <= 1, 'A response must not mount duplicate native action rows');
    const action = actions[0], row = action ? render('Xb', action.props, key + '-row') : null;
    // Materialize the actual shared row, as React does, so speech traversal and
    // layout export include children passed through the new Xb prop.
    if (action) {
      assert.equal(tree.props.children.at(-1), action, 'Native actions must follow the content/cards once');
      tree.props.children[tree.props.children.length - 1] = row;
    }
    return { tree, action, row, controller };
  }
  const speech = tree => nodes(tree, 'SpeechPair');
  const ordinary = response({ after: jsx('edit-card', { children: 'Edited file' }) }, 'ordinary');
  assert.equal(speech(ordinary.tree).length, 1);
  assert.equal(speech(ordinary.row).length, 1);
  assert.equal(ordinary.row.props.children[1].type, 'SpeechPair');
  assert.equal(ordinary.controller.props.enabled, true);
  assert.equal(ordinary.controller.props.selectionOnly, false);
  assert.match(ordinary.row.props.children[0].props.className, /opacity-0/);
  const controls = ordinary.tree.props.children.at(-1);
  assert.equal(controls.props['data-codex-local-read-aloud'], 'response-controls');
  assert.doesNotMatch(controls.props.className, /opacity-0/);
  assert.equal(speech(ordinary.tree)[0].props.getText(), 'A completed sentence.');
  assert.equal(ordinary.tree.props.className, 'group flex min-w-0 flex-col');
  const scopedRoot = { id: 'this-response-only', html: '<p>Only this response</p>' };
  ordinary.tree.props.ref.current = { querySelector(selector) {
    assert.equal(selector, '[data-selected-text-overlay-target]'); return scopedRoot;
  } };
  assert.equal(speech(ordinary.tree)[0].props.getRoot(), scopedRoot);
  assert.equal(speech(ordinary.tree)[0].props.getHtml(), scopedRoot.html);
  const finalFragment = ordinary.tree.props.children[3];
  const order = finalFragment.props.children;
  assert.ok(order.some(node => nodes(node, 'edit-card').length));
  assert.equal(nodes(finalFragment, ctx.Xb).length, 0);
  assert.equal(nodes(finalFragment, ctx.CodexLocalReadAloudButton).length, 0);
  const streaming = { type: 'assistant-message', content: 'A completed sentence.', completed: false, phase: null };
  assert.equal(speech(response({ item: streaming }, 'streaming').tree).length, 0);
  const copyWhileStreaming = response({ item: streaming, allowCopyWhileStreaming: true }, 'copy-stream');
  assert.equal(speech(copyWhileStreaming.tree).length, 0);
  assert.ok(nodes(copyWhileStreaming.row, 'ft').length > 0);
  const placeholder = response({ item: { ...streaming, renderPlaceholderWhileStreaming: true },
    allowCopyWhileStreaming: true, turnId: 'hidden-streaming-turn' }, 'placeholder');
  assert.equal(placeholder.action, undefined, 'The host placeholder must still suppress its native action row');
  assert.equal(nodes(placeholder.tree, 'ft').length, 0);
  assert.equal(nodes(placeholder.tree, 'Tg').length, 0);
  assert.equal(speech(placeholder.tree).length, 0);
  // Reuse the compiler cache with identical copy text across completion.
  assert.equal(speech(response({ allowCopyWhileStreaming: true }, 'copy-stream').tree).length, 1);
  // Native action suppression is not speech suppression. Run the actual host
  // work-item gate and supply its resulting prop to the response route. Work
  // commentary does not supply assistantCopyText at all.
  const progressItem = { type: 'assistant-message', content: 'Completed work commentary.', completed: true, phase: 'commentary' };
  const work = render('iO', { activityItem: { item: progressItem }, conversationId: 'fixture', hostId: 'host' }, 'work-progress');
  assert.equal(work.type, 'WorkItem');
  assert.equal(work.props.showAssistantMessageActionRow, false);
  assert.equal(work.props.assistantCopyText, undefined);
  const progress = response({ item: progressItem, assistantCopyText: undefined,
    showActionRow: work.props.showAssistantMessageActionRow }, 'progress');
  assert.equal(progress.action, undefined);
  assert.equal(speech(progress.tree).length, 0, 'Progress must not acquire another permanent toolbar');
  assert.equal(progress.controller.props.enabled, true);
  assert.equal(progress.controller.props.selectionOnly, true);
  assert.equal(progress.controller.props.getText(), progressItem.content);
  for (const item of [
    { ...progressItem, isSkippedCompletion: true },
    { ...progressItem, structuredOutput: { type: 'heartbeat', decision: 'DONT_NOTIFY' } },
    { ...progressItem, completed: false },
    { ...progressItem, content: '' },
    { ...progressItem, type: 'user-message' },
  ]) {
    const excluded = response({ item, assistantCopyText: undefined, showActionRow: false }, 'excluded');
    assert.equal(excluded.controller.props.enabled, false);
    assert.equal(speech(excluded.tree).length, 0);
  }
  const notify = response({ item: { ...progressItem, structuredOutput: { type: 'heartbeat', decision: 'NOTIFY' } },
    assistantCopyText: undefined, showActionRow: false }, 'notify');
  assert.equal(notify.controller.props.enabled, true, 'A real user-facing automation response remains readable');
  assert.equal(response({ assistantCopyText: '', item: { ...streaming, content: '', completed: true } }, 'empty').controller.props.enabled, false);
  const transcript = render('fx', { conversationId: 'fixture', entries: [
    { role: 'user', text: 'User words' }, { role: 'assistant', text: 'Transcript response.' },
    { role: 'assistant', text: '## Research\n\n| Name | Value |\n| --- | --- |\n| One | Two |' },
  ] });
  assert.equal(nodes(transcript, '_g')[0].props.hideActions, true);
  const assistants = nodes(transcript, ctx.Vb);
  assert.equal(assistants.length, 2);
  for (const [index, node] of assistants.entries()) {
    assert.equal(node.props.showActionRow, false);
    assert.equal(node.props.item.completed, true);
    const rendered = response(node.props, 'transcript-' + index);
    assert.equal(rendered.action, undefined);
    assert.equal(rendered.controller.props.enabled, true);
    assert.equal(rendered.controller.props.selectionOnly, true);
    assert.equal(speech(rendered.tree).length, 0, 'Legacy transcript selection must not introduce per-fragment pairs');
  }
  // Xb is shared with host views beyond Vb. A copyable row without the explicit
  // completed-response routing must not acquire speech controls accidentally.
  assert.equal(speech(render('Xb', { copyText: 'Unrelated copyable content' }, 'unrelated')).length, 0);
  // Historical events in the user's report are canonical transcriptSegment and
  // bemItemPromoted/inlineMarkdown entries, not the legacy fx transcript path.
  // Neutral content below reproduces their structure without private history.
  function voice(name, props, key) {
    const route = render(name, { canonical: true, conversationId: 'fixture', cwd: '/fixture',
      hostId: 'fixture-host', turnSearchKey: 'turn-fixture', ...props }, key);
    const assistant = nodes(route, ctx.Vb)[0];
    if (!assistant) return { route };
    assert.equal(assistant.props.showActionRow, false);
    return { route, assistant, ...response(assistant.props, key + '-response') };
  }
  const savedEntry = { id: 'voice-fixture', role: 'assistant', text: 'Saved transcript text.', completed: true };
  for (const compact of [false, true]) {
    atoms.compact = compact;
    atoms.realtime = undefined;
    const saved = voice('Ik', { entry: savedEntry }, 'canonical-' + compact);
    assert.equal(saved.action, undefined);
    assert.equal(speech(saved.tree).length, 0);
    assert.equal(saved.controller.props.enabled, true);
    assert.equal(saved.controller.props.selectionOnly, true);
    assert.equal(saved.controller.props.getText(), 'Saved transcript text.');
    atoms.realtime = { item: { type: 'transcriptSegment', text: 'Canonical transcript text.' }, completed: false };
    const live = voice('Ik', { entry: savedEntry }, 'canonical-' + compact);
    assert.equal(live.assistant.props.item.completed, false);
    assert.equal(speech(live.tree).length, 0);
    assert.equal(live.controller.props.enabled, false);
    atoms.realtime = { ...atoms.realtime, completed: true };
    const finished = voice('Ik', { entry: savedEntry }, 'canonical-' + compact);
    assert.equal(speech(finished.tree).length, 0);
    assert.equal(finished.controller.props.enabled, true);
    assert.equal(finished.controller.props.getText(), 'Canonical transcript text.');
    const voiceRoot = { id: 'canonical-root', html: '<p>Canonical transcript text.</p>' };
    finished.tree.props.ref.current = { querySelector: selector => selector === '[data-selected-text-overlay-target]' ? voiceRoot : null };
    assert.equal(finished.controller.props.getRoot(), voiceRoot);
    assert.equal(finished.controller.props.getHtml(), voiceRoot.html);
    const user = voice('Ik', { entry: { ...savedEntry, role: 'user' } }, 'canonical-user-' + compact);
    assert.equal(user.assistant, undefined);
    assert.equal(nodes(user.route, 'Uy')[0].props.hideActions, true);
    const presentation = { type: 'inline-markdown', itemId: 'research-item', presentationId: 'research-presentation',
      turnId: 'research-turn', content: '## Saved research\n\n| Name | Result |\n| --- | --- |\n| One | Ready |', completed: true };
    atoms.item = undefined; atoms.turn = undefined;
    const research = voice('Ek', { presentation }, 'research-' + compact);
    assert.equal(research.action, undefined);
    assert.equal(speech(research.tree).length, 0);
    assert.equal(research.controller.props.enabled, true);
    assert.equal(research.controller.props.getText(), presentation.content);
    atoms.item = { type: 'agentMessage', text: '::codex-realtime-inline{}\n## Current research\n\nA revised table.' };
    atoms.turn = 'inProgress';
    const pending = voice('Ek', { presentation, historyEntityKey: 'canonical-turn' }, 'research-' + compact);
    assert.equal(pending.assistant.props.item.completed, false);
    assert.equal(speech(pending.tree).length, 0);
    assert.equal(pending.controller.props.enabled, false);
    atoms.turn = 'completed';
    const completed = voice('Ek', { presentation, historyEntityKey: 'canonical-turn' }, 'research-' + compact);
    assert.equal(speech(completed.tree).length, 0);
    assert.equal(completed.controller.props.enabled, true);
    assert.equal(completed.controller.props.getText(), '## Current research\n\nA revised table.');
    // Missing completion remains conservative without depending on action rows.
    atoms.realtime = undefined;
    const unknown = voice('Ik', { entry: { ...savedEntry, completed: undefined } }, 'unknown-' + compact);
    assert.equal(unknown.controller.props.enabled, false);
    // A grouped fragment keeps its own selection controller. The group being
    // incomplete or lacking a footer must not make this completed part unreadable.
    for (const owner of ['group-a', 'group-b', undefined]) {
      const grouped = voice('Ik', { entry: { ...savedEntry, codexReadAloudGrouped: owner } }, 'grouped-fragment-' + compact);
      assert.equal(grouped.controller.props.enabled, true);
      assert.equal(grouped.controller.props.selectionOnly, true);
      assert.equal(speech(grouped.tree).length, 0);
      assert.equal(grouped.route.props['data-codex-read-aloud-owner'], owner);
    }
  }
  atoms.compact = false;
  // Reuse a Vb instance with changing eligibility but identical text. The new
  // outer slot must not be held by the host's original compiler memo cache.
  for (const enabled of [false, true, false]) {
    const rendered = response({ showActionRow: false, item: { ...progressItem, completed: enabled }, assistantCopyText: undefined }, 'reuse-eligibility');
    assert.equal(rendered.controller.props.enabled, enabled);
    assert.equal(speech(rendered.tree).length, 0);
  }
  if (process.argv.includes('--layout-fixture')) {
    // Export the actual pinned row structure, replacing complex host widgets
    // with inert boxes. The offline browser checks row layout/visibility only;
    // this is not a claim of full desktop rendering or audible playback.
    function element(tag, attrs, children = []) { return { tag, attrs, children }; }
    function button(name) { return element('button', { 'data-probe-control': name, 'aria-label': name }, [name]); }
    function dom(tree) {
      if (tree == null || typeof tree === 'boolean') return null;
      if (typeof tree !== 'object') return String(tree);
      if (tree.type === 'SpeechPair') return element('fragment', {}, [button('read'), button('voice')]);
      if (tree.type === 'ft') return button('copy');
      if (tree.type === 'Tg') return button('rating');
      if (tree.type === 'Dr') return button('fork');
      if (tree.type === 'gg') return element('span', { 'data-probe-control': 'time' }, ['16:00']);
      if (['Kb', 'ph', 'Iu'].includes(tree.type)) return null;
      let tag = ['Jl', 'fragment', 'qi'].includes(tree.type) ? 'fragment' : tree.type;
      if (tag === 'hl' || tag === 'edit-card') tag = 'div';
      assert.ok(['div', 'span', 'fragment'].includes(tag), 'Unexpected layout fixture node: ' + String(tag));
      const attrs = {};
      for (const [name, value] of Object.entries(tree.props ?? {})) {
        if (name === 'className') attrs.class = value;
        else if (name.startsWith('data-') && value != null) attrs[name] = value;
      }
      const children = tree.props?.children;
      return element(tag, attrs, (Array.isArray(children) ? children : [children]).map(dom).filter(value => value != null));
    }
    const ordinaryLayout = response({ turnId: 'layout-turn', onFork() {},
      item: { type: 'assistant-message', content: 'A completed sentence.', completed: true, phase: null, sentAtMs: 1 },
      after: jsx('edit-card', { children: 'Edited fixture document' }) }, 'layout-ordinary');
    const progressLayout = response({ showActionRow: false, item: progressItem, assistantCopyText: undefined }, 'layout-progress');
    const makeLayout = (result, id) => { const node = dom(result.tree); node.attrs['data-probe-response'] = id; return node; };
    process.stdout.write(JSON.stringify({ ordinary: makeLayout(ordinaryLayout, 'ordinary'), progress: makeLayout(progressLayout, 'progress') }));
    return;
  }
  process.stdout.write('Host renderer boundaries verified\n');
});
