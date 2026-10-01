// Canonical voice history groups assistant content between user/session
// boundaries. This operates on projected data, before virtualized rendering;
// it never discovers ownership by walking arbitrary DOM ancestors.
export function codexCanonicalVoiceGroups(timeline) {
  const byPart = new Map();
  let session = timeline?.activeRealtimeSessionAtPageStart ?? null;
  let partialHead = session != null;
  let current = null;
  const close = () => { if (current) current.closed = true; current = null; };
  const start = item => {
    const nextSession = item.realtimeSessionId ?? session;
    if (nextSession !== session) { close(); session = nextSession; partialHead = false; }
    current ??= { id: `${String(session ?? 'unknown')}:${item.id}`, closed: false, partial: partialHead };
    return current;
  };
  for (const entry of timeline?.entries ?? []) {
    if (entry.type !== 'realtime') continue;
    const item = entry.item;
    if (item.type === 'realtimeSessionStarted') {
      close(); session = item.realtimeSessionId; partialHead = false;
    } else if (item.type === 'realtimeSessionClosed') {
      if (item.realtimeSessionId === session) { close(); session = null; partialHead = false; }
    } else if (item.type === 'transcriptSegment') {
      if (item.role === 'user') { close(); session = item.realtimeSessionId ?? session; partialHead = false; }
      else if (item.role === 'assistant') byPart.set(`transcript:${item.id}`, start(item));
    } else if (item.type === 'bemItemPromoted' && item.presentation?.type === 'inlineMarkdown') {
      byPart.set(`presentation:${item.id}`, start(item));
    }
  }
  return byPart;
}

export function codexVoiceGroupEntries(entries) {
  return entries.flatMap(entry => entry.block?.codexReadAloudGroup
    ? codexVoiceGroupEntries(entry.block.codexReadAloudGroup.children) : [entry]);
}

export function codexVoiceNavigationEntries(entries, parentKey = null) {
  return entries.flatMap(entry => {
    const children = entry.block?.codexReadAloudGroup?.children;
    const key = parentKey ?? entry.turnKey;
    return [[entry, key], ...(children ? codexVoiceNavigationEntries(children, key) : [])];
  });
}

export function codexGroupVoiceResponses(entries, timeline) {
  if (timeline == null) return entries; // Legacy records keep their native route.
  const ownership = codexCanonicalVoiceGroups(timeline);
  const output = [];
  let pending = null;
  function flush(closedByUser = false) {
    if (!pending) return;
    const { owner, children, parts, base } = pending;
    const text = parts.map(part => part.text).filter(value => value.trim()).join('\n\n');
    const closed = owner.closed || closedByUser;
    // The host emits pending-artifact when a promoted item is missing. Its
    // eventual presentation may contain research text, so it cannot count as
    // a complete answer merely because the voice session has ended.
    const unresolved = children.some(child => child.presentation?.type === 'pending-artifact');
    const active = children.some(child => child.voiceWorkActivity === 'active' ||
      child.type === 'voice-presentation' && child.isInProgress === true);
    const completed = closed && !owner.partial && !unresolved && !active &&
      parts.every(part => part.completed === true);
    const turnKey = `codex-read-aloud:voice:${owner.id}:${children[0].turnKey}`;
    const ownedChildren = children.map(child => child.type === 'voice-transcript'
      ? { ...child, block: { ...child.block, entries: child.block.entries.map(item =>
        ({ ...item, codexReadAloudGrouped: turnKey })) } }
      : child.presentation?.type === 'inline-markdown'
        ? { ...child, presentation: { ...child.presentation, codexReadAloudGrouped: turnKey } } : child);
    output.push({ type: 'voice-transcript', conversationId: base.conversationId,
      cwd: base.cwd, hostId: base.hostId,
      turnKey,
      estimatedHeightPx: children.reduce((height, child) => height + (child.estimatedHeightPx ?? 180), 0),
      isInProgress: !closed || active,
      block: { type: 'tail', id: owner.id, canonical: true, entries: [],
        codexReadAloudGroup: { children: ownedChildren, completed, text,
          partIds: parts.filter(part => part.text.trim()).map(part => part.id) } } });
    pending = null;
  }
  function add(entry, owner, part) {
    if (!owner) { flush(); output.push(entry); return; }
    if (pending?.owner !== owner) { flush(); pending = { owner, children: [], parts: [], base: entry }; }
    pending.children.push(entry); pending.parts.push(part);
  }
  for (const entry of entries) {
    if (entry.type === 'voice-transcript' && entry.block?.canonical) {
      for (const item of entry.block.entries) {
        const piece = { ...entry, turnKey: `realtime-voice:transcript:${item.id}`,
          estimatedHeightPx: item.role === 'user' ? 128 : 144,
          block: { ...entry.block, id: item.id, entries: [item] } };
        if (item.role !== 'assistant') { flush(item.role === 'user'); output.push(piece); continue; }
        const owner = ownership.get(`transcript:${item.id}`);
        if (owner) piece.block.entries = [{ ...item, codexReadAloudGrouped: true }];
        add(piece, owner, { id: `transcript:${item.id}`, text: item.text ?? '', completed: item.completed });
      }
    } else if (entry.type === 'voice-presentation' && entry.presentation.type === 'inline-markdown') {
      const owner = ownership.get(`presentation:${entry.presentation.presentationId}`);
      add(owner ? { ...entry, presentation: { ...entry.presentation, codexReadAloudGrouped: true } } : entry,
        owner, { id: `presentation:${entry.presentation.presentationId}`, text: entry.presentation.content ?? '', completed: entry.presentation.completed });
    } else if (pending && (entry.type === 'voice-presentation' || entry.voiceWorkActivity != null)) {
      // Preserve work, artifacts and status in place, but never add them to
      // the speech parts. Only Ik/Ek content receives a readable-root marker.
      pending.children.push(entry);
    } else {
      const userBoundary = entry.transcriptBlock?.type === 'user-message' ||
        entry.turnState?.items?.some(item => item.type === 'user-message') === true;
      flush(userBoundary); output.push(entry);
    }
  }
  flush();
  return output;
}
