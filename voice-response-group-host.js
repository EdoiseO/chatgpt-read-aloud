// Reviewed timeline bindings: dA is React, fA is JSX, iA renders an unchanged
// child entry. The speech component is imported explicitly from its host module.
function CodexVoiceReadGroup({ entry, latestTurnFooter, latestTurnFollowContentRef }) {
  const root = dA.useRef(null);
  const group = entry.block.codexReadAloudGroup;
  const getRoot = () => root.current;
  const getTextRoots = () => {
    const candidates = [...(root.current?.querySelectorAll('[data-codex-read-aloud-part]') ?? [])]
      .filter(part => part.getAttribute('data-codex-read-aloud-owner') === entry.turnKey);
    if (candidates.length !== group.partIds.length) return [];
    const parts = group.partIds.map(id => candidates.find(part => part.getAttribute('data-codex-read-aloud-part') === id));
    if (parts.some(part => !part) || new Set(parts).size !== parts.length) return [];
    // Whole-answer completion and selection eligibility are different. A
    // partial history page can still own several completed adjacent parts.
    // Pending parts remain outside the readable set, so a range crossing
    // their prose is rejected by the exact-selection coverage check.
    const readableParts = parts.filter(part => part.getAttribute('data-codex-read-aloud-part-state') === 'complete');
    if (group.completed && readableParts.length !== parts.length) return [];
    const roots = readableParts.map(part => part.querySelector('[data-selected-text-overlay-target]'));
    return roots.some(part => !part) ? [] : roots;
  };
  const renderChild = (child, index) => {
    const content = fA.jsx(iA, { entry: child,
      latestTurnFooter: index === group.children.length - 1 ? latestTurnFooter : undefined,
      latestTurnFollowContentRef: index === group.children.length - 1 ? latestTurnFollowContentRef : undefined,
    }, child.turnKey);
    const readable = child.type === 'voice-transcript' ||
      child.type === 'voice-presentation' && child.presentation?.type === 'inline-markdown';
    // These entries are reviewed work/status/artifact content, not answer
    // prose. Mark that exclusion explicitly for cross-part selection checks.
    // display:contents preserves the native child's layout. A child with its
    // own independently registered prose root still supports reading that root.
    return readable ? content : fA.jsx('div', {
      style: { display: 'contents' },
      'data-codex-local-read-aloud': 'group-auxiliary', children: content,
    }, child.turnKey);
  };
  return fA.jsxs('div', {
    ref: root, 'data-codex-read-aloud-group': entry.turnKey,
    children: [fA.jsx('div', { className: 'flex flex-col gap-6',
      children: group.children.map(renderChild) }),
    fA.jsx(CodexLocalReadAloudButton, { getRoot, getTextRoots, getText: () => group.text,
      selectionOnly: !group.completed,
      renderContent: (controls, state = {}) => group.completed && group.text.trim() ? fA.jsx('div', {
        className: 'mt-1.5 flex min-h-5 items-center gap-0.5',
        'data-codex-read-aloud-active': state.busy || state.pickerOpen ? 'true' : undefined,
        'data-codex-local-read-aloud': 'response-controls', children: controls,
      }) : null,
    })],
  });
}
