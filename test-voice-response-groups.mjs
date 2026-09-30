import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexGroupVoiceResponses, codexVoiceGroupEntries, codexVoiceNavigationEntries } from './voice-response-groups.mjs';

const realtime = item => ({ type: 'realtime', item: { realtimeSessionId: 'session-a', ...item } });
const start = session => realtime({ type: 'realtimeSessionStarted', realtimeSessionId: session ?? 'session-a' });
const end = session => realtime({ type: 'realtimeSessionClosed', realtimeSessionId: session ?? 'session-a' });
const transcript = (id, role, text = id, completed = true) => ({ id, role, text, completed });
const event = item => realtime({ type: 'transcriptSegment', ...item });
const block = entries => ({ type: 'voice-transcript', conversationId: 'thread', hostId: 'host',
  turnKey: `realtime-voice:transcript:${entries[0].id}`, block: { type: 'tail', canonical: true, entries } });
const presentation = (id, content, completed = true) => ({ type: 'voice-presentation', conversationId: 'thread', hostId: 'host',
  turnKey: `presentation:${id}`, sourceTurnId: 'research-turn',
  presentation: { type: 'inline-markdown', presentationId: id, itemId: 'research', turnId: 'research-turn', content, completed } });
const promote = id => realtime({ type: 'bemItemPromoted', id, turnId: 'research-turn', itemId: 'research', presentation: { type: 'inlineMarkdown' } });
const group = entry => entry.block?.codexReadAloudGroup;

test('one closed assistant group retains short speech, research, and final text around work', () => {
  const user = transcript('u1', 'user', 'Question'), a = transcript('a1', 'assistant', 'Check.'),
    b = transcript('a2', 'assistant', 'Research introduction.'), c = transcript('a3', 'assistant', 'Conclusion.');
  const work = { turnKey: 'work', voiceWorkActivity: 'terminal', badge: 'Worked for 3 minutes' };
  const table = presentation('p1', '| Name | Result |\n| One | Ready |');
  const input = [block([user, a]), work, block([b]), table, block([c])];
  const before = structuredClone(input);
  const output = codexGroupVoiceResponses(input, { entries: [start(), event(user), event(a), event(b), promote('p1'), event(c), end()] });
  assert.equal(output.length, 2);
  assert.equal(output[0].block.entries[0].role, 'user');
  assert.equal(group(output[1]).completed, true);
  assert.equal(group(output[1]).children.length, 5);
  assert.equal(group(output[1]).text, 'Check.\n\nResearch introduction.\n\n| Name | Result |\n| One | Ready |\n\nConclusion.');
  assert.ok(!group(output[1]).text.includes('Worked'));
  assert.deepEqual(input, before, 'Projection must not mutate native entries');
});

test('user and session boundaries never combine separate answers', () => {
  const parts = [transcript('u1', 'user'), transcript('a1', 'assistant'), transcript('u2', 'user'), transcript('a2', 'assistant')];
  const last = transcript('a3', 'assistant');
  const timeline = { entries: [start(), ...parts.map(event), end(), start('session-b'),
    realtime({ type: 'transcriptSegment', ...last, realtimeSessionId: 'session-b' }), end('session-b')] };
  const output = codexGroupVoiceResponses([block(parts), block([last])], timeline);
  assert.equal(output.filter(group).length, 3);
  assert.deepEqual(output.filter(group).map(entry => group(entry).text), ['a1', 'a2', 'a3']);
  assert.equal(new Set(output.map(entry => entry.turnKey)).size, output.length);
});

test('active trailing, partial page, and pending research groups do not claim completion', () => {
  const a = transcript('a1', 'assistant');
  assert.equal(group(codexGroupVoiceResponses([block([a])], { entries: [start(), event(a)] })[0]).completed, false);
  assert.equal(group(codexGroupVoiceResponses([block([a])], {
    activeRealtimeSessionAtPageStart: 'session-a', entries: [event(a), end()],
  })[0]).completed, false);
  const output = codexGroupVoiceResponses([block([a]), presentation('p', 'Pending', false)],
    { entries: [start(), event(a), promote('p'), end()] });
  assert.equal(group(output[0]).completed, false);
});

test('interrupted research retains all available completed prose without work badges', () => {
  const a = transcript('a1', 'assistant', 'Available text.');
  const output = codexGroupVoiceResponses([block([a]),
    { turnKey: 'work', voiceWorkActivity: 'terminal', status: 'interrupted' }, presentation('p', 'Partial result.', true)],
  { entries: [start(), event(a), promote('p'), end()] });
  assert.equal(group(output[0]).completed, true);
  assert.equal(group(output[0]).text, 'Available text.\n\nPartial result.');
});

test('empty parts stay rendered but do not produce text or absorb user content', () => {
  const a = transcript('a1', 'assistant', ''), user = transcript('u', 'user', 'Private user words');
  const output = codexGroupVoiceResponses([block([a, user])], { entries: [start(), event(a), event(user), end()] });
  assert.equal(group(output[0]).text, '');
  assert.equal(group(output[0]).children.length, 1);
  assert.equal(output[1].block.entries[0].text, user.text);
});

test('ordinary entries remain boundaries, legacy input unchanged, unknown parts remain readable', () => {
  const a = transcript('a1', 'assistant'), b = transcript('a2', 'assistant');
  const ordinary = { turnKey: 'ordinary', turn: {}, turnSearchKey: 'ordinary' };
  const input = [block([a]), ordinary, block([b])];
  assert.equal(codexGroupVoiceResponses(input, null), input);
  const output = codexGroupVoiceResponses(input, { entries: [start(), event(a), end()] });
  assert.equal(output[1], ordinary);
  assert.equal(output[2].block.entries[0].codexReadAloudGrouped, undefined);
});

test('flattening and alias metadata preserve children and map every mounted unit to its group', () => {
  const a = transcript('a1', 'assistant'), b = transcript('a2', 'assistant');
  const output = codexGroupVoiceResponses([block([a]), presentation('p', 'Table'), block([b])],
    { entries: [start(), event(a), promote('p'), event(b), end()] });
  const children = codexVoiceGroupEntries(output);
  assert.deepEqual(children.map(entry => entry.turnKey), ['realtime-voice:transcript:a1', 'presentation:p', 'realtime-voice:transcript:a2']);
  for (const [_entry, parent] of codexVoiceNavigationEntries(output)) assert.equal(parent, output[0].turnKey);
});

test('typed user boundaries close a preceding voice answer and never reuse its virtual key', () => {
  const a = transcript('a1', 'assistant'), b = transcript('a2', 'assistant');
  const typed = { turnKey: 'typed-user', turnState: { items: [{ type: 'user-message', message: 'A new question' }] } };
  const output = codexGroupVoiceResponses([block([a]), typed, block([b])],
    { entries: [start(), event(a), event(b)] });
  assert.equal(group(output[0]).completed, true);
  assert.equal(group(output[2]).completed, false);
  assert.notEqual(output[0].turnKey, output[2].turnKey);
  assert.equal(output[1], typed);
});

test('unresolved promoted artifacts block complete speech until their content is known', () => {
  const a = transcript('a1', 'assistant', 'Introduction.');
  const timeline = { entries: [start(), event(a), promote('p'), end()] };
  const pending = { type: 'voice-presentation', turnKey: 'pending', isInProgress: false,
    presentation: { type: 'pending-artifact' } };
  const project = artifact => codexGroupVoiceResponses([block([a]), artifact], timeline)[0];
  assert.equal(group(project(pending)).completed, false);
  assert.equal(group(project(presentation('p', 'Research text.', false))).completed, false);
  const resolved = group(project(presentation('p', 'Research text.', true)));
  assert.equal(resolved.completed, true);
  assert.equal(resolved.text, 'Introduction.\n\nResearch text.');
  const nontext = { ...pending, presentation: { type: 'generated-image', image: { src: 'fixture' } } };
  assert.equal(group(project(nontext)).completed, true);
  assert.equal(group(project(nontext)).text, 'Introduction.');
});

test('active child work preserves group progress without treating session-wide transcript flags as active work', () => {
  const a = transcript('a1', 'assistant');
  const timeline = { entries: [start(), event(a), end()] };
  const input = [{ ...block([a]), isInProgress: true }];
  assert.equal(group(codexGroupVoiceResponses(input, timeline)[0]).completed, true);
  const active = codexGroupVoiceResponses([...input, { turnKey: 'active-work', voiceWorkActivity: 'active' }], timeline)[0];
  assert.equal(group(active).completed, false);
  assert.equal(active.isInProgress, true);
});
