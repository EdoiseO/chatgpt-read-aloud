'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FEED_URL, REVIEWED_HOST, MENU_ID, MAX_FEED_BYTES, FETCH_TIMEOUT_MS,
  compareVersions, fetchOfficialFeed, parseAppcast, parseInstalledPlist,
  readInstalledHost, describeUpdate, installUpdateChecker,
} = require('./update-checker.cjs');

const SIGNATURE = Buffer.alloc(64, 7).toString('base64');
const SPARKLE_NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle';
const HOST = { version: '26.928.20755', build: '12246' };
const NEXT = { version: '26.928.21956', build: '12404' };
const MAC = { systemVersion: '26.6.2', arch: 'arm64' };
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function item({ version = NEXT.version, build = NEXT.build, minimum = '13.0', maximum,
  hardware = 'arm64', channel, critical = false, url, extra = '', enclosureAttributes = '', oldStyle = false } = {}) {
  const archive = url ?? `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${version}.zip`;
  const versionTags = `<sparkle:version>${escape(build)}</sparkle:version><sparkle:shortVersionString>${escape(version)}</sparkle:shortVersionString>`;
  const oldAttributes = oldStyle ? `sparkle:version="${escape(build)}" sparkle:shortVersionString="${escape(version)}"` : '';
  return `<item><title>Untrusted title ignored</title>${oldStyle ? '' : versionTags}
    ${channel === undefined ? '' : `<sparkle:channel>${escape(channel)}</sparkle:channel>`}
    ${hardware === undefined ? '' : `<sparkle:hardwareRequirements>${escape(hardware)}</sparkle:hardwareRequirements>`}
    ${minimum === undefined ? '' : `<sparkle:minimumSystemVersion>${escape(minimum)}</sparkle:minimumSystemVersion>`}
    ${maximum === undefined ? '' : `<sparkle:maximumSystemVersion>${escape(maximum)}</sparkle:maximumSystemVersion>`}
    ${critical ? '<sparkle:tags><sparkle:criticalUpdate /></sparkle:tags>' : ''}
    <enclosure url="${escape(archive)}" length="682593617" sparkle:edSignature="${SIGNATURE}" ${oldAttributes} ${enclosureAttributes}/>
    ${extra}</item>`;
}

function feed(items = [item()]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:sparkle="${SPARKLE_NS}" version="2.0"><channel><title>Codex</title>${items.join('')}</channel></rss>`;
}

function plist({ version = HOST.version, build = HOST.build, identity = 'local.edoise.codex.readaloud', extra = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${escape(identity)}</string>
    <key>CFBundleShortVersionString</key><string>${escape(version)}</string>
    <key>CFBundleVersion</key><string>${escape(build)}</string>${extra}</dict></plist>`;
}

function transport(replies) {
  const calls = [], requests = [], responses = [];
  const request = (url, options, callback) => {
    calls.push({ url: url.href, options });
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    requests.push(req);
    const reply = replies.shift() ?? { requestError: true };
    queueMicrotask(() => {
      if (req.destroyed) return;
      if (reply.requestError) { req.emit('error', new Error('private network details')); return; }
      if (reply.holdRequest) return;
      const response = new EventEmitter();
      response.statusCode = reply.status ?? 200;
      response.headers = { 'content-type': 'application/xml', ...reply.headers };
      response.destroyed = false;
      response.destroy = () => { response.destroyed = true; };
      responses.push(response);
      callback(response);
      if (response.destroyed) return;
      if (reply.error) { response.emit('error', new Error('private response details')); return; }
      if (reply.aborted) { response.emit('aborted'); return; }
      if (reply.holdResponse) return;
      for (const chunk of reply.chunks ?? [Buffer.from(feed())]) {
        if (!response.destroyed) response.emit('data', chunk);
      }
      if (!response.destroyed) response.emit('end');
    });
    return req;
  };
  return { request, calls, requests, responses };
}

function uiFixture(t, overrides = {}) {
  const app = new EventEmitter(), dialogs = [], fetches = [];
  const electron = { app, dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 }; } } };
  Object.defineProperty(electron, 'autoUpdater', { get() { throw Error('Native updater accessed'); } });
  const options = {
    platform: 'darwin', arch: 'arm64', systemVersion: MAC.systemVersion,
    readInstalled: () => HOST,
    fetchFeed: async options => { fetches.push(options); return feed(); },
    ...overrides,
  };
  const checker = installUpdateChecker(electron, options);
  t.after(() => checker.dispose());
  return { app, electron, dialogs, fetches, checker, options };
}

test('numeric ordering handles component boundaries and rejects ambiguous versions', () => {
  assert.equal(compareVersions('26.928.21956', '26.928.20755'), 1);
  assert.equal(compareVersions('12404', '99999'), -1);
  assert.equal(compareVersions('13', '13.0.0'), 0);
  assert.equal(compareVersions('999999999999.2', '999999999999.10'), -1);
  for (const invalid of ['1beta', '01', '1..2', '1.2 ', '-1', '1e3', '', '1'.repeat(97), null, 42]) {
    assert.throws(() => compareVersions(invalid, '1'), { code: 'INVALID_FEED' });
  }
});

test('selects highest stable build without treating nested delta enclosures as full archives', () => {
  const xml = feed([
    item(HOST),
    item({ ...NEXT, extra: '<sparkle:deltas><enclosure url="https://untrusted.invalid/ignored.delta" sparkle:deltaFrom="12246" /></sparkle:deltas>' }),
    item({ version: '30.1.1', build: '30000', channel: 'beta' }),
    item({ version: '30.1.2', build: '30001', hardware: 'x64' }),
  ]);
  const result = parseAppcast(xml, MAC);
  assert.equal(result.latest.build, NEXT.build);
  assert.equal(result.latest.url, `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-${NEXT.version}.zip`);
  assert.equal(result.latest.length, 682593617);
  assert.equal(result.newerSystemRequirement, null);
});

test('filters minimum and maximum macOS versions and reports a blocked newer build', () => {
  const result = parseAppcast(feed([
    item(HOST), item({ ...NEXT, minimum: '27.0' }),
    item({ version: '26.929.1', build: '12405', maximum: '26.5' }),
  ]), MAC);
  assert.equal(result.latest.build, HOST.build);
  assert.equal(result.newerSystemRequirement.build, '12405');
  assert.throws(() => parseAppcast(feed([item({ minimum: '27.0' })]), MAC), { code: 'NO_COMPATIBLE_RELEASE' });
  assert.throws(() => parseAppcast(feed(), { ...MAC, arch: 'x64' }), { code: 'UNSUPPORTED_PLATFORM' });
});

test('supports documented enclosure version attributes and namespace aliases', () => {
  const xml = feed([item({ oldStyle: true, critical: true })]).replaceAll('sparkle:', 's:').replace('xmlns:sparkle=', 'xmlns:s=');
  const result = parseAppcast(xml, MAC);
  assert.equal(result.latest.build, NEXT.build);
  assert.equal(result.latest.critical, true);
});

test('rejects entity declarations, malformed XML, namespace spoofing, duplicates, and bounds', () => {
  const invalid = [
    feed().replace('<rss ', '<!DOCTYPE rss SYSTEM "file:///private/data"><rss '),
    feed().replace('<rss ', '<!DOCTYPE rss [<!ENTITY x "expanded">]><rss '),
    feed().replace('<channel>', '<?execute something?><channel>'),
    feed().replace('26.928.21956</sparkle:shortVersionString>', '&unknown;</sparkle:shortVersionString>'),
    feed().replace(SPARKLE_NS, 'https://wrong.invalid/sparkle'),
    feed().replace('<sparkle:version>', '<unbound:version>'),
    feed().replace('</sparkle:version>', '</different>'),
    feed().replace('<channel>', '<channel broken="1" broken="2">'),
    feed().replace('<channel>', '<channel xmlns:b="' + SPARKLE_NS + '" sparkle:value="1" b:value="2">'),
    feed().replace('<channel>', '<channel>' + '<nested>'.repeat(25)),
    feed().replace('</rss>', '</rss><rss/>'),
    feed().replace('</rss>', '</rss>junk'),
    feed().replace('</channel>', '<item>' + '</channel>'),
    feed().replace('<title>Codex</title>', '<title>&#0;</title>'),
    feed().replace('<title>Codex</title>', '<title>&#xD800;</title>'),
    feed().replace('<title>Codex</title>', '<title>&#x110000;</title>'),
    feed().replace('<title>Codex</title>', '<title>bad&entity</title>'),
    feed().replace('<title>Codex</title>', '<title>' + '&'.repeat(500000) + '</title>'),
    feed().replace('</sparkle:version>', '</sparkle:version><sparkle:version>9</sparkle:version>'),
    ' '.repeat(MAX_FEED_BYTES + 1),
  ];
  for (const xml of invalid) assert.throws(() => parseAppcast(xml, MAC), { code: 'INVALID_FEED' });
});

test('accepts harmless XML comments, CDATA and numeric entities without using feed titles', () => {
  const xml = feed().replace('<title>Codex</title>', '<!-- harmless --><title><![CDATA[<script>ignored</script>]]>&#x1F600;&amp;</title>')
    .replace('<sparkle:version>12404', '<sparkle:version>&#49;2404');
  assert.equal(parseAppcast(xml, MAC).latest.build, NEXT.build);
});

test('rejects unreviewed archive hosts, credentials, schemes, paths and version formats', () => {
  const urls = [
    'http://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.928.21956.zip',
    'https://persistent.oaistatic.com.evil.invalid/codex-app-prod/ChatGPT-darwin-arm64-26.928.21956.zip',
    'https://user:secret@persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.928.21956.zip',
    'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-x64-26.928.21956.zip',
    'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.928.21956.zip?download=1',
    'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-arm64-26.928.21956.zip#fragment',
  ];
  for (const url of urls) assert.throws(() => parseAppcast(feed([item({ url })]), MAC), { code: 'INVALID_FEED' });
  assert.throws(() => parseAppcast(feed([item({ version: '26.928.21956-beta' })]), MAC), { code: 'INVALID_FEED' });
  assert.throws(() => parseAppcast(feed().replace(SIGNATURE, 'invalid'), MAC), { code: 'INVALID_FEED' });
});

test('conflicting numeric-equivalent builds or requirements stop the check', () => {
  assert.throws(() => parseAppcast(feed([item(), item({ build: '12404.0', version: '26.928.29999' })]), MAC), { code: 'INVALID_FEED' });
  assert.throws(() => parseAppcast(feed([item(), item({ minimum: '27.0' })]), MAC), { code: 'INVALID_FEED' });
  assert.throws(() => parseAppcast(feed([item({ enclosureAttributes: 'sparkle:version="55555"' })]), MAC), { code: 'INVALID_FEED' });
});

test('compares installed build and exact reviewed target separately from short version', () => {
  const update = describeUpdate(HOST, parseAppcast(feed(), MAC));
  assert.equal(update.status, 'available');
  assert.equal(update.reviewed, false);
  assert.match(update.detail, /compatibility has not been verified/);
  assert.match(update.detail, /does not install updates/);
  assert.match(update.detail, /rollout offered to your account/);
  const sameVersion = describeUpdate(HOST, parseAppcast(feed([item({ version: HOST.version })]), MAC));
  assert.equal(sameVersion.status, 'available');
  assert.equal(sameVersion.reviewed, false);
  const current = describeUpdate(HOST, parseAppcast(feed([item(HOST)]), MAC));
  assert.equal(current.status, 'current');
  assert.equal(current.reviewed, true);
  assert.match(current.detail, /version match alone does not verify/);
  assert.equal(describeUpdate(NEXT, parseAppcast(feed([item(HOST)]), MAC)).status, 'ahead-of-feed');
  assert.throws(() => describeUpdate({ ...HOST, version: '26.928.00000' }, parseAppcast(feed([item(HOST)]), MAC)));
  assert.throws(() => describeUpdate({ ...HOST, version: '26.928.1' }, parseAppcast(feed([item(HOST)]), MAC)), { code: 'INVALID_FEED' });
  assert.deepEqual(REVIEWED_HOST, HOST);
});

test('installed plist parsing validates app identity, exact runtime version and duplicate keys', () => {
  assert.deepEqual(parseInstalledPlist(plist(), HOST.version), HOST);
  assert.throws(() => parseInstalledPlist(plist({ identity: 'com.openai.codex' }), HOST.version), { code: 'INSTALLED_VERSION' });
  assert.throws(() => parseInstalledPlist(plist(), NEXT.version), { code: 'INSTALLED_VERSION' });
  assert.throws(() => parseInstalledPlist(plist({ extra: '<key>CFBundleVersion</key><string>1</string>' }), HOST.version), { code: 'INSTALLED_VERSION' });
  assert.throws(() => parseInstalledPlist(plist().replace('http://www.apple.com/DTDs/PropertyList-1.0.dtd', 'file:///private/entity'), HOST.version), { code: 'INVALID_FEED' });
});

test('installed metadata uses this executable bundle with bounded reads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'read-aloud-update-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'Contents', 'MacOS'), { recursive: true });
  const info = path.join(directory, 'Contents', 'Info.plist');
  const app = { getPath: key => { assert.equal(key, 'exe'); return path.join(directory, 'Contents', 'MacOS', 'ChatGPT-native'); }, getVersion: () => HOST.version };
  fs.writeFileSync(info, plist());
  assert.deepEqual(readInstalledHost(app), HOST);
  fs.writeFileSync(info, Buffer.alloc(MAX_FEED_BYTES + 1));
  assert.throws(() => readInstalledHost(app), { code: 'INSTALLED_VERSION' });
  fs.unlinkSync(info);
  assert.throws(() => readInstalledHost(app), { code: 'INSTALLED_VERSION' });
});

test('fetch is HTTPS metadata only and sends no profile, account or installation identifiers', async () => {
  const fake = transport([{}]);
  assert.equal(await fetchOfficialFeed({ request: fake.request }), feed());
  assert.deepEqual(fake.calls.map(call => call.url), [FEED_URL]);
  assert.deepEqual(Object.keys(fake.calls[0].options.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
  assert.equal(fake.calls[0].options.headers['Accept-Encoding'], 'identity');
  assert(fake.requests[0].destroyed);
  assert(fake.responses[0].destroyed);
});

test('redirects are restricted to the same exact official feed and bounded to three hops', async () => {
  for (const location of ['https://evil.invalid/feed.xml', 'http://persistent.oaistatic.com/codex-app-prod/appcast.xml',
    '/codex-app-prod/archive.zip', FEED_URL + '?token=anything', FEED_URL + '#fragment',
    'https://username@persistent.oaistatic.com/codex-app-prod/appcast.xml']) {
    const fake = transport([{ status: 302, headers: { location } }]);
    await assert.rejects(fetchOfficialFeed({ request: fake.request }), { code: 'FEED_LOCATION' });
    assert.equal(fake.calls.length, 1);
  }
  const bounded = transport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: FEED_URL } })));
  await assert.rejects(fetchOfficialFeed({ request: bounded.request }), { code: 'FEED_LOCATION' });
  assert.equal(bounded.calls.length, 4);
  const one = transport([{ status: 307, headers: { location: '/codex-app-prod/appcast.xml' } }, {}]);
  assert.equal(await fetchOfficialFeed({ request: one.request }), feed());
  assert.equal(one.calls.length, 2);
});

test('network status, content type, encoding, incomplete bodies and UTF-8 errors fail clearly', async () => {
  for (const [reply, code] of [
    [{ status: 500 }, 'HTTP_ERROR'], [{ status: 204 }, 'HTTP_ERROR'],
    [{ headers: { 'content-type': 'text/html' } }, 'INVALID_FEED'],
    [{ headers: { 'content-encoding': 'gzip' } }, 'INVALID_FEED'],
    [{ chunks: [Buffer.from([0xC0, 0xAF])] }, 'INVALID_FEED'],
    [{ headers: { 'content-length': '99999' } }, 'NETWORK_ERROR'],
    [{ requestError: true }, 'NETWORK_ERROR'], [{ error: true }, 'NETWORK_ERROR'], [{ aborted: true }, 'NETWORK_ERROR'],
  ]) {
    const fake = transport([reply]);
    await assert.rejects(fetchOfficialFeed({ request: fake.request }), { code });
  }
});

test('both declared and streamed sizes are bounded, including missing Content-Length', async () => {
  for (const reply of [
    { headers: { 'content-length': String(MAX_FEED_BYTES + 1) } },
    { headers: { 'content-length': 'invalid' } },
    { chunks: [Buffer.alloc(MAX_FEED_BYTES), Buffer.from('x')] },
  ]) {
    const fake = transport([reply]);
    await assert.rejects(fetchOfficialFeed({ request: fake.request }), { code: 'FEED_SIZE' });
    assert(fake.responses[0].destroyed);
  }
});

test('one deadline bounds a stalled response and destroys request resources', async () => {
  const fake = transport([{ holdResponse: true }]);
  let fire, cleared = false;
  const promise = fetchOfficialFeed({ request: fake.request,
    setTimer: (callback, duration) => { fire = callback; assert.equal(duration, FETCH_TIMEOUT_MS); return 'timer'; },
    clearTimer: token => { assert.equal(token, 'timer'); cleared = true; } });
  await Promise.resolve();
  fire();
  await assert.rejects(promise, { code: 'NETWORK_TIMEOUT' });
  assert(cleared);
  assert(fake.requests[0].destroyed && fake.responses[0].destroyed);
});

test('abort works before request creation and during the request', async () => {
  const already = new AbortController(); already.abort();
  const idle = transport([]);
  await assert.rejects(fetchOfficialFeed({ request: idle.request, signal: already.signal }), { code: 'ABORTED' });
  assert.equal(idle.calls.length, 0);
  const running = new AbortController(), fake = transport([{ holdRequest: true }]);
  const promise = fetchOfficialFeed({ request: fake.request, signal: running.signal });
  running.abort();
  await assert.rejects(promise, { code: 'ABORTED' });
  assert(fake.requests[0].destroyed);
});

test('installation is side effect free until a menu click and stable across host menu rebuilds', async t => {
  const f = uiFixture(t);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.dialogs.length, 0);
  const again = installUpdateChecker(f.electron, f.options);
  assert.equal(again, f.checker);
  assert.equal(f.app.listenerCount('will-quit'), 1);
  const first = f.checker.menuItemOptions('Localized update label');
  const rebuilt = again.menuItemOptions('Localized update label');
  assert.equal(first.id, MENU_ID);
  assert.equal(rebuilt.id, first.id);
  assert.equal(first.label, 'Localized update label');
  const result = await rebuilt.click();
  assert.equal(result.status, 'available');
  assert.equal(f.fetches.length, 1);
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.dialogs[0].buttons, ['OK']);
  assert.match(f.dialogs[0].detail, /compatibility has not been verified/);
});

test('repeated clicks share one check and dialog; a later click fetches fresh metadata', async t => {
  let release, count = 0;
  const f = uiFixture(t, { fetchFeed: () => { count += 1; return new Promise(resolve => { release = resolve; }); } });
  const first = f.checker.checkForUpdates(), second = f.checker.checkForUpdates();
  assert.equal(first, second);
  assert.equal(count, 1);
  release(feed());
  await first;
  assert.equal(f.dialogs.length, 1);
  const third = f.checker.checkForUpdates();
  assert.equal(count, 2);
  release(feed()); await third;
  assert.equal(f.dialogs.length, 2);
});

test('quit cancels in-flight discovery and suppresses a late dialog', async t => {
  const fake = transport([{ holdResponse: true }]);
  const f = uiFixture(t, { fetchFeed: options => fetchOfficialFeed({ ...options, request: fake.request }) });
  const promise = f.checker.checkForUpdates();
  await Promise.resolve();
  f.app.emit('will-quit');
  assert.equal((await promise).status, 'cancelled');
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.app.listenerCount('will-quit'), 0);
  assert(fake.requests[0].destroyed);
  assert.equal((await f.checker.menuItemOptions().click()).status, 'cancelled');
});

test('unsupported platforms or unreadable installed metadata do not send a network request', async t => {
  for (const overrides of [{ platform: 'win32' }, { arch: 'x64' }, { readInstalled: () => { throw new Error('private file data'); } }]) {
    const f = uiFixture(t, overrides);
    const result = await f.checker.checkForUpdates();
    assert.equal(result.status, 'error');
    assert.equal(f.fetches.length, 0);
    assert.equal(f.dialogs.length, 1);
    assert(!f.dialogs[0].detail.includes('private file data'));
  }
});

test('failed metadata fetch reports an error without leaking raw network messages', async t => {
  const f = uiFixture(t, { fetchFeed: async () => { throw new Error('private network state'); } });
  assert.equal((await f.checker.checkForUpdates()).status, 'error');
  assert.equal(f.dialogs.length, 1);
  assert(!f.dialogs[0].detail.includes('private network state'));
  assert(!f.dialogs[0].message.includes('up to date'));
});
