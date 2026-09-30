// Actual pinned projection, renderer, search/bookmark, and scroll-adapter
// functions execute with inert dependencies and neutral canonical event data.
const assert = require('node:assert/strict');
const vm = require('node:vm');
let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', async () => {
  const functions = JSON.parse(input), cache = new Map(), refs = new Map();
  let key, refIndex;
  const jsx = (type, props) => ({ type, props });
  const compiler = { c(size) { const id = key + ':' + size; if (!cache.has(id)) cache.set(id, Array(size).fill(Symbol.for('react.memo_cache_sentinel'))); return cache.get(id); } };
  const react = { useRef(value) { const id = key + ':ref:' + refIndex++; if (!refs.has(id)) refs.set(id, { current: value }); return refs.get(id); } };
  const ctx = {
    Lk: compiler, Mk: compiler, uA: compiler, Rk: { jsx, jsxs: jsx, Fragment: 'fragment' },
    Nk: { jsx, jsxs: jsx }, fA: { jsx, jsxs: jsx }, dA: react,
    Y: () => undefined, wn: 'wn', D: 'D', C: 'C', Kv: 'Assistant', Uy: 'User', Vy: 'Speaker',
    CodexLocalReadAloudButton: 'Speech', kd: () => false, Lf: 'Boundary', aA() {},
    tm: (turn, unit) => `${turn}:${unit}`,
    kn: text => [{ type: 'inline-markdown', content: text }],
    EO: 480, wO: 128, TO: 144, AO: 48, DO: 180, OO: 360, kO: 180, jO: 120,
    uO: (base, turn, part) => ({ ...base, turn, turnKey: part.key, turnSearchKey: part.key,
      voiceWorkActivity: part.state, turnState: { items: [{ type: 'tool', text: 'Work status' }] } }),
    Ea: text => text, Sg: entry => !!entry.turn,
    pk: items => items.map((item, index) => ({ unitId: `${index}:work`, text: item.text })),
    BA: [], VA: [], Zk: 'Zk', Xk() {}, ug: async () => {},
  };
  vm.createContext(ctx);
  // The ordinary Vb/Xb functions have their own dedicated probe. Their imports
  // are deliberately unavailable here, so this probe cannot launch host code.
  vm.runInContext(Object.entries(functions).filter(([name]) => !['Vb', 'Xb', 'fx'].includes(name)).map(([, text]) => text).join('\n'), ctx, { timeout: 1000 });
  function call(name, args, instance = name) { key = instance; refIndex = 0; return ctx[name](...args); }
  function nodes(tree, type) {
    if (!tree || typeof tree !== 'object') return [];
    const children = tree.props?.children;
    return [...(tree.type === type ? [tree] : []), ...(Array.isArray(children) ? children : [children]).flatMap(child => nodes(child, type))];
  }
  const rt = item => ({ type: 'realtime', item: { realtimeSessionId: 'session', ...item } });
  const user = { id: 'user', role: 'user', text: 'Research question.' };
  const parts = [{ id: 'short', role: 'assistant', text: 'Check.' }, { id: 'intro', role: 'assistant', text: 'Research introduction.' },
    { id: 'final', role: 'assistant', text: 'Research conclusion.' }];
  const timeline = { entries: [rt({ type: 'realtimeSessionStarted' }), rt({ type: 'transcriptSegment', ...user }),
    rt({ type: 'transcriptSegment', ...parts[0] }), { type: 'turnStarted', turnId: 'turn' },
    { type: 'item', turnId: 'turn', item: { id: 'work', completed: true } },
    rt({ type: 'transcriptSegment', ...parts[1] }), { type: 'item', turnId: 'turn', item: { id: 'markdown', completed: true } },
    rt({ type: 'bemItemPromoted', id: 'presentation', turnId: 'turn', itemId: 'markdown', presentation: { type: 'inlineMarkdown' } }),
    rt({ type: 'transcriptSegment', ...parts[2] }), { type: 'turnCompleted', turnId: 'turn' }, rt({ type: 'realtimeSessionClosed' })] };
  const normalized = [{ turnId: 'turn', initialUser: { isDelegation: true }, items: [
    { id: 'work', kind: 'work', presentations: [] }, { id: 'markdown', kind: 'assistant', presentations: [] }] }];
  const blocks = call('BD', [timeline, normalized, new Map()]);
  assert.equal(blocks.filter(block => block.type === 'voice-item').length, 4);
  assert.equal(blocks.filter(block => block.type === 'bem-presentation').length, 1);
  const base = { conversationId: 'thread', hostId: 'host', cwd: '/fixture' };
  const turn = { turnId: 'turn', items: [{ id: 'markdown', type: 'agentMessage', text: '| Name | Result |\n| One | Ready |' }] };
  const projected = call('eO', [{ canonical: true, baseEntriesByTurnId: new Map([['turn', base]]), blocks,
    ...base, historyEntityKeysByTurnId: new Map(), isVoiceSessionActive: false,
    turnPresentationContexts: new Map(), turnsById: new Map([['turn', turn]]) }]);
  const missingBlocks = call('BD', [timeline, [{ ...normalized[0], items: [normalized[0].items[0]] }], new Map()]);
  assert.equal(missingBlocks.filter(block => block.type === 'pending-artifact').length, 1);
  const missingProjection = call('eO', [{ canonical: true, baseEntriesByTurnId: new Map([['turn', base]]), blocks: missingBlocks,
    ...base, historyEntityKeysByTurnId: new Map(), isVoiceSessionActive: false,
    turnPresentationContexts: new Map(), turnsById: new Map([['turn', { ...turn, items: [] }]]) }]);
  const unresolved = call('codexGroupVoiceResponses', [missingProjection, timeline])[1];
  assert.equal(unresolved.block.codexReadAloudGroup.completed, false);
  assert.equal(nodes(call('CodexVoiceReadGroup', [{ entry: unresolved }], 'missing-presentation'), 'Speech').length, 0);
  const grouped = call('codexGroupVoiceResponses', [projected, timeline]);
  assert.equal(grouped.length, 2);
  const response = grouped[1], group = response.block.codexReadAloudGroup;
  assert.equal(group.completed, true);
  assert.equal(group.children.length, 5);
  assert.equal(group.text, 'Check.\n\nResearch introduction.\n\n| Name | Result |\n| One | Ready |\n\nResearch conclusion.');
  assert.equal(grouped[0].block.entries[0].role, 'user');
  const footer = { type: 'unchanged-native-footer' }, followRef = {};
  const dispatch = call('iA', [{ entry: response, latestTurnFooter: footer, latestTurnFollowContentRef: followRef }]);
  assert.equal(dispatch.type, ctx.Fk);
  const routed = call('Fk', [dispatch.props]);
  assert.equal(routed.type, ctx.CodexVoiceReadGroup);
  const rendered = call('CodexVoiceReadGroup', [routed.props]);
  assert.equal(nodes(rendered, 'Speech').length, 1);
  assert.equal(nodes(rendered, ctx.iA).length, 5);
  assert.equal(nodes(rendered, ctx.iA).at(-1).props.latestTurnFooter, footer);
  assert.equal(nodes(rendered, ctx.iA).at(-1).props.latestTurnFollowContentRef, followRef);
  assert.ok(nodes(rendered, ctx.iA).slice(0, -1).every(node => node.props.latestTurnFooter === undefined));
  assert.equal(rendered.props['data-codex-read-aloud-group'], response.turnKey);
  for (const child of group.children) {
    if (child.type === 'voice-transcript') {
      const item = child.block.entries[0];
      const tree = call('Ik', [{ canonical: true, ...base, entry: item, turnSearchKey: child.turnKey }], item.id);
      assert.equal(nodes(tree, 'Assistant')[0].props.readAloudStandalone, false);
      assert.equal(tree.props['data-codex-read-aloud-part'], 'transcript:' + item.id);
      assert.equal(tree.props['data-codex-read-aloud-owner'], response.turnKey);
      assert.equal(tree.props['data-codex-read-aloud-part-state'], 'complete');
    } else if (child.presentation?.type === 'inline-markdown') {
      const tree = call('Ek', [{ ...base, presentation: child.presentation, turnSearchKey: child.turnKey }]);
      assert.equal(nodes(tree, 'Assistant')[0].props.readAloudStandalone, false);
      assert.equal(tree.props['data-codex-read-aloud-part'], 'presentation:presentation');
      assert.equal(tree.props['data-codex-read-aloud-owner'], response.turnKey);
    }
  }
  // Changing grouping eligibility must invalidate the pinned compiler caches.
  for (const grouped of [false, true, false]) {
    const tree = call('Ik', [{ canonical: true, ...base, entry: { ...parts[0], completed: true, codexReadAloudGrouped: grouped } }], 'toggle-Ik');
    assert.equal(nodes(tree, 'Assistant')[0].props.readAloudStandalone, !grouped);
    const markdown = group.children.find(child => child.presentation)?.presentation;
    const research = call('Ek', [{ ...base, presentation: { ...markdown, codexReadAloudGrouped: grouped } }], 'toggle-Ek');
    assert.equal(nodes(research, 'Assistant')[0].props.readAloudStandalone, !grouped);
  }
  const leafRoots = [{ id: 'short' }, { id: 'intro' }, { id: 'table' }, { id: 'final' }];
  let pendingPart = false, omitPart = false, duplicatePart = false;
  const container = { querySelectorAll(selector) {
    assert.equal(selector, '[data-codex-read-aloud-part]');
    const owned = leafRoots.slice(0, omitPart ? -1 : undefined).map((root, index) => ({ getAttribute: name => name === 'data-codex-read-aloud-owner'
      ? response.turnKey : name === 'data-codex-read-aloud-part' ? group.partIds[duplicatePart ? 0 : index] : pendingPart ? 'pending' : 'complete', querySelector(selector) {
      assert.equal(selector, '[data-selected-text-overlay-target]'); return root;
    } }));
    return [...owned, { getAttribute: () => 'another-group', querySelector: () => { throw new Error('Foreign group content must not be read'); } }];
  } };
  rendered.props.ref.current = container;
  const control = nodes(rendered, 'Speech')[0];
  assert.equal(control.props.getRoot(), container);
  assert.deepEqual(Array.from(control.props.getTextRoots()), leafRoots);
  pendingPart = true;
  assert.equal(control.props.getTextRoots().length, 0);
  pendingPart = false; omitPart = true;
  assert.equal(control.props.getTextRoots().length, 0);
  omitPart = false; duplicatePart = true;
  assert.equal(control.props.getTextRoots().length, 0);
  const search = call('fk', [grouped]);
  assert.equal(search.length, 6); // User, four readable pieces, and preserved work.
  assert.ok(search.some(row => row.units.some(unit => unit.text === 'Work status')));
  const bookmarks = call('LA', [{ entries: grouped, isConversationHistoryComplete: true }]);
  assert.equal(bookmarks.length, 1);
  assert.equal(bookmarks[0].getLabel(), 'Research question.');
  assert.equal(bookmarks[0].getPreview().response, 'Research conclusion.');
  const aliases = call('actualNavigationAliases', [grouped]), scrolled = [];
  const scroll = call('ij', [{ get: () => false }, 'thread', { current: { scrollToKey: async key => scrolled.push(key) } },
    { current: aliases }, { current: null }]);
  for (const row of search) await scroll.scrollToTurn(row.turnKey);
  assert.equal(scrolled[0], grouped[0].turnKey);
  assert.ok(scrolled.slice(1).every(key => key === response.turnKey));
  assert.equal(call('actualLatestPhase', [response, null]).phase, 'idle');
  const live = { ...response, isInProgress: true, block: { ...response.block, codexReadAloudGroup: { ...group, completed: false } } };
  assert.equal(call('actualLatestPhase', [live, null]).phase, 'prework');
  assert.equal(nodes(call('CodexVoiceReadGroup', [{ entry: live }]), 'Speech').length, 0);
  process.stdout.write('Canonical grouped host routes verified\n');
});
