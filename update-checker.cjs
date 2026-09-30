'use strict';

// Manual discovery only. Never load Sparkle or download/install an app archive.
// The public feed is embedded in the reviewed official macOS app. Its releases
// are not a statement about an account's personalized rollout eligibility.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const FEED_URL = 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml';
const SPARKLE_NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle';
const MENU_ID = 'codex-local-read-aloud-check-for-updates';
const REVIEWED_HOST = Object.freeze({ version: '26.928.20755', build: '12246' });
const MAX_FEED_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;
const installations = new WeakMap();

class UpdateCheckError extends Error {
  constructor(code, message) { super(message); this.name = 'UpdateCheckError'; this.code = code; }
}

function invalidFeed(message = 'The official update feed has an unsupported or invalid format.') {
  return new UpdateCheckError('INVALID_FEED', message);
}

function numericVersion(value) {
  if (typeof value !== 'string' || value.length > 96 ||
      !/^(?:0|[1-9]\d{0,11})(?:\.(?:0|[1-9]\d{0,11})){0,7}$/.test(value)) {
    throw invalidFeed('The update version could not be compared safely.');
  }
  return value.split('.').map(part => BigInt(part));
}

function compareVersions(first, second) {
  const a = numericVersion(first), b = numericVersion(second);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0n, right = b[index] ?? 0n;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function allowedFeedURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new UpdateCheckError('FEED_LOCATION', 'The update feed redirected to an unsupported address.'); }
  const expected = new URL(FEED_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname ||
      url.username || url.password || url.search || url.hash) {
    throw new UpdateCheckError('FEED_LOCATION', 'The update feed redirected to an unsupported address.');
  }
  return url;
}

function fetchOfficialFeed({ request = https.get, signal, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, activeRequest, activeResponse, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      signal?.removeEventListener('abort', abort);
      activeResponse?.destroy();
      activeRequest?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new UpdateCheckError('ABORTED', 'The update check was cancelled.'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimer(() => finish(new UpdateCheckError('NETWORK_TIMEOUT', 'The update server did not respond within 15 seconds. Try again later.')), FETCH_TIMEOUT_MS);
    timer?.unref?.();
    const visit = (input, redirects) => {
      if (done) return;
      let url;
      try { url = allowedFeedURL(input); } catch (error) { finish(error); return; }
      let current = true;
      try {
        activeRequest = request(url, {
          headers: { Accept: 'application/xml, application/rss+xml, text/xml', 'Accept-Encoding': 'identity', 'User-Agent': 'ChatGPT-Read-Aloud-Update-Check/1' },
        }, response => {
          if (done) { response.destroy(); return; }
          activeResponse = response;
          response.on('error', () => { if (current) finish(new UpdateCheckError('NETWORK_ERROR', 'The update check was interrupted. Check your connection and try again.')); });
          const status = response.statusCode;
          if ([301, 302, 303, 307, 308].includes(status)) {
            current = false;
            const location = response.headers.location;
            response.destroy();
            if (redirects >= MAX_REDIRECTS || typeof location !== 'string') {
              finish(new UpdateCheckError('FEED_LOCATION', 'The update feed redirected too many times or omitted its address.'));
              return;
            }
            let destination;
            try { destination = new URL(location, url).href; } catch { finish(new UpdateCheckError('FEED_LOCATION', 'The update feed redirected to an unsupported address.')); return; }
            visit(destination, redirects + 1);
            return;
          }
          if (status !== 200) {
            finish(new UpdateCheckError('HTTP_ERROR', `The update server returned HTTP ${Number.isInteger(status) ? status : 'error'}. Try again later.`));
            return;
          }
          const encoding = response.headers['content-encoding'];
          const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if ((encoding && encoding !== 'identity') || !['application/xml', 'application/rss+xml', 'text/xml'].includes(type)) {
            finish(invalidFeed('The update server returned an unsupported document type.'));
            return;
          }
          const length = response.headers['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > MAX_FEED_BYTES)) {
            finish(new UpdateCheckError('FEED_SIZE', 'The update feed exceeds its size limit.'));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            if (done) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_FEED_BYTES) { finish(new UpdateCheckError('FEED_SIZE', 'The update feed exceeds its size limit.')); return; }
            chunks.push(buffer);
          });
          response.on('end', () => {
            if (done) return;
            if (length !== undefined && bytes !== Number(length)) {
              finish(new UpdateCheckError('NETWORK_ERROR', 'The update feed was incomplete. Try again later.'));
              return;
            }
            try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
            catch { finish(invalidFeed('The update feed is not valid UTF-8 text.')); }
          });
          response.on('aborted', () => { if (current) finish(new UpdateCheckError('NETWORK_ERROR', 'The update check was interrupted. Check your connection and try again.')); });
        });
        activeRequest.on('error', () => { if (current) finish(new UpdateCheckError('NETWORK_ERROR', 'The update server could not be reached. Check your connection and try again.')); });
      } catch { finish(new UpdateCheckError('NETWORK_ERROR', 'The update server could not be reached. Check your connection and try again.')); }
    };
    visit(FEED_URL, 0);
  });
}

function decodeXML(value) {
  // Keep each candidate bounded. A permissive "anything until semicolon"
  // pattern can repeatedly scan the same suffix on malformed ampersands.
  return value.replace(/&(?:[^&;]{0,32};)?/g, match => {
    if (match === '&') throw invalidFeed();
    const entity = match.slice(1, -1);
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    if (!/^#(?:\d{1,7}|x[\da-fA-F]{1,6})$/.test(entity ?? '')) throw invalidFeed();
    const point = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xD7FF) ||
          (point >= 0xE000 && point <= 0xFFFD) || (point >= 0x10000 && point <= 0x10FFFF))) throw invalidFeed();
    return String.fromCodePoint(point);
  });
}

// A deliberately small XML reader: no DTDs, external entities, processing
// instructions, HTML evaluation, or dependency on a renderer DOM. Bounds also
// keep a changed or malformed feed from monopolizing the main process.
function parseXML(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_FEED_BYTES ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(source)) throw invalidFeed();
  source = source.replace(/^\uFEFF/, '').replace(/^<\?xml\s+[^?]*\?>\s*/, '');
  const namePattern = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
  const stack = [], roots = [];
  let cursor = 0, nodes = 0;
  function appendText(value, raw = false) {
    if (!stack.length) { if (value.trim()) throw invalidFeed(); return; }
    stack.at(-1).text += raw ? value : decodeXML(value);
  }
  function expanded(name, namespaces, attribute = false) {
    const parts = name.split(':');
    if (parts.length === 2) {
      if (!namespaces[parts[0]]) throw invalidFeed();
      return [namespaces[parts[0]], parts[1]];
    }
    return [attribute ? '' : namespaces[''] ?? '', name];
  }
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) { appendText(source.slice(cursor)); break; }
    appendText(source.slice(cursor, opening));
    if (source.startsWith('<!--', opening)) {
      const end = source.indexOf('-->', opening + 4);
      if (end < 0 || source.slice(opening + 4, end).includes('--')) throw invalidFeed();
      cursor = end + 3; continue;
    }
    if (source.startsWith('<![CDATA[', opening)) {
      const end = source.indexOf(']]>', opening + 9);
      if (end < 0 || !stack.length) throw invalidFeed();
      appendText(source.slice(opening + 9, end), true); cursor = end + 3; continue;
    }
    if (/^<[!?]/.test(source.slice(opening, opening + 2))) throw invalidFeed();
    const token = source.slice(opening).match(new RegExp(`^<(/?)(${namePattern})((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>`));
    if (!token) throw invalidFeed();
    cursor = opening + token[0].length;
    if (token[1]) {
      if (token[3].trim() || stack.pop()?.name !== token[2]) throw invalidFeed();
      continue;
    }
    const selfClosing = /\/\s*$/.test(token[3]);
    let rest = token[3].replace(selfClosing ? /\/\s*$/ : /$^/, '');
    const rawAttributes = Object.create(null);
    while (rest.length) {
      if (!rest.trim()) break;
      const attribute = rest.match(new RegExp(`^\\s+(${namePattern})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
      if (!attribute || Object.hasOwn(rawAttributes, attribute[1])) throw invalidFeed();
      rawAttributes[attribute[1]] = decodeXML(attribute[2] ?? attribute[3]);
      rest = rest.slice(attribute[0].length);
    }
    const namespaces = Object.assign(Object.create(null), stack.at(-1)?.namespaces, { xml: 'http://www.w3.org/XML/1998/namespace' });
    for (const [key, value] of Object.entries(rawAttributes)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) {
        const prefix = key.slice(6);
        if (prefix === 'xmlns' || (prefix === 'xml' && value !== namespaces.xml)) throw invalidFeed();
        namespaces[prefix] = value;
      }
    }
    const [namespace, local] = expanded(token[2], namespaces);
    const node = { name: token[2], namespace, local, namespaces, attributes: new Map(), children: [], text: '' };
    for (const [key, value] of Object.entries(rawAttributes)) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const [uri, attribute] = expanded(key, namespaces, true), canonical = `${uri}|${attribute}`;
      if (node.attributes.has(canonical)) throw invalidFeed();
      node.attributes.set(canonical, value);
    }
    if (++nodes > 20000 || stack.length >= 24) throw invalidFeed();
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || roots.length !== 1) throw invalidFeed();
  return roots[0];
}

function children(node, local, namespace = '') {
  return node.children.filter(child => child.local === local && child.namespace === namespace);
}

function scalar(node, local, namespace = '') {
  const matches = children(node, local, namespace);
  if (matches.length > 1 || matches[0]?.children.length) throw invalidFeed();
  return matches[0]?.text.trim() ?? null;
}

function attribute(node, local, namespace = '') { return node.attributes.get(`${namespace}|${local}`) ?? null; }

function releaseField(item, enclosure, local) {
  const element = scalar(item, local, SPARKLE_NS), attr = attribute(enclosure, local, SPARKLE_NS);
  if (element !== null && attr !== null && element !== attr) throw invalidFeed();
  return element ?? attr;
}

function parseAppcast(xml, { systemVersion, arch = 'arm64' }) {
  numericVersion(systemVersion);
  if (arch !== 'arm64') throw new UpdateCheckError('UNSUPPORTED_PLATFORM', 'This Read Aloud update checker supports Apple silicon Macs.');
  const root = parseXML(xml);
  if (root.namespace || root.local !== 'rss' || children(root, 'channel').length !== 1) throw invalidFeed();
  const items = children(children(root, 'channel')[0], 'item');
  if (items.length > 2000) throw invalidFeed();
  const releases = [], blockedReleases = [], seenBuilds = new Map();
  for (const item of items) {
    const channel = scalar(item, 'channel', SPARKLE_NS);
    if (channel !== null && channel !== '' && channel !== 'stable') continue;
    const hardware = scalar(item, 'hardwareRequirements', SPARKLE_NS);
    if (hardware !== null && hardware !== '' && hardware !== 'arm64') continue;
    const enclosures = children(item, 'enclosure').filter(enclosure => attribute(enclosure, 'deltaFrom', SPARKLE_NS) === null);
    if (enclosures.length !== 1) throw invalidFeed();
    const enclosure = enclosures[0];
    const operatingSystem = attribute(enclosure, 'os', SPARKLE_NS);
    if (operatingSystem !== null && operatingSystem !== 'macos') continue;
    const build = releaseField(item, enclosure, 'version');
    const version = releaseField(item, enclosure, 'shortVersionString');
    numericVersion(build); numericVersion(version);
    let url;
    try { url = new URL(attribute(enclosure, 'url')); } catch { throw invalidFeed(); }
    const filename = `ChatGPT-darwin-arm64-${version}.zip`;
    if (url.origin !== 'https://persistent.oaistatic.com' || url.pathname !== `/codex-app-prod/${filename}` ||
        url.username || url.password || url.search || url.hash) throw invalidFeed('The update archive has an unsupported address or architecture.');
    const length = attribute(enclosure, 'length'), signature = attribute(enclosure, 'edSignature', SPARKLE_NS);
    if (!/^[1-9]\d{0,10}$/.test(length ?? '') || Number(length) > 5 * 1024 ** 3 ||
        typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature) || Buffer.from(signature, 'base64').length !== 64) throw invalidFeed();
    const minimumSystemVersion = scalar(item, 'minimumSystemVersion', SPARKLE_NS);
    const maximumSystemVersion = scalar(item, 'maximumSystemVersion', SPARKLE_NS);
    if (minimumSystemVersion !== null) numericVersion(minimumSystemVersion);
    if (maximumSystemVersion !== null) numericVersion(maximumSystemVersion);
    const tags = children(item, 'tags', SPARKLE_NS);
    if (tags.length > 1) throw invalidFeed();
    const critical = children(item, 'criticalUpdate', SPARKLE_NS).length > 0 ||
      (tags.length === 1 && children(tags[0], 'criticalUpdate', SPARKLE_NS).length > 0);
    const release = { version, build, url: url.href, length: Number(length), signature, minimumSystemVersion, maximumSystemVersion, critical };
    const buildParts = numericVersion(build);
    while (buildParts.length > 1 && buildParts.at(-1) === 0n) buildParts.pop();
    const canonicalBuild = buildParts.join('.'), previous = seenBuilds.get(canonicalBuild);
    if (previous && (previous.version !== version || previous.url !== url.href || previous.signature !== signature ||
        previous.length !== Number(length) || previous.minimumSystemVersion !== minimumSystemVersion ||
        previous.maximumSystemVersion !== maximumSystemVersion || previous.critical !== critical)) throw invalidFeed();
    seenBuilds.set(canonicalBuild, release);
    const eligible = (minimumSystemVersion === null || compareVersions(systemVersion, minimumSystemVersion) >= 0) &&
      (maximumSystemVersion === null || compareVersions(systemVersion, maximumSystemVersion) <= 0);
    (eligible ? releases : blockedReleases).push(release);
  }
  const newestFirst = (a, b) => compareVersions(b.build, a.build);
  releases.sort(newestFirst); blockedReleases.sort(newestFirst);
  if (!releases.length) throw new UpdateCheckError('NO_COMPATIBLE_RELEASE', 'The public feed does not list a stable Apple silicon release for this macOS version.');
  return { latest: releases[0], newerSystemRequirement: blockedReleases.find(item => compareVersions(item.build, releases[0].build) > 0) ?? null };
}

function parseInstalledPlist(xml, appVersion) {
  // Apple's standard plist declaration is a fixed declaration, not an entity
  // source. Remove only this form; parseXML rejects any other DTD or entity.
  const standardDTD = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
  const root = parseXML(xml.replace(standardDTD, ''));
  if (root.local !== 'plist' || root.namespace || root.children.length !== 1 || root.children[0].local !== 'dict' || root.children[0].namespace) throw new UpdateCheckError('INSTALLED_VERSION', 'The installed app version could not be read.');
  const pairs = root.children[0].children, values = new Map();
  if (pairs.length % 2) throw new UpdateCheckError('INSTALLED_VERSION', 'The installed app version could not be read.');
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index], value = pairs[index + 1];
    if (key.local !== 'key' || key.namespace || key.children.length || values.has(key.text)) throw new UpdateCheckError('INSTALLED_VERSION', 'The installed app version could not be read.');
    values.set(key.text, value.local === 'string' && !value.namespace && !value.children.length ? value.text : null);
  }
  const version = values.get('CFBundleShortVersionString'), build = values.get('CFBundleVersion');
  if (values.get('CFBundleIdentifier') !== 'local.edoise.codex.readaloud' || version !== appVersion) throw new UpdateCheckError('INSTALLED_VERSION', 'The installed app identity does not match the Read Aloud copy.');
  numericVersion(version); numericVersion(build);
  return { version, build };
}

function readInstalledHost(app) {
  let descriptor;
  try {
    const plistPath = path.resolve(path.dirname(app.getPath('exe')), '..', 'Info.plist');
    descriptor = fs.openSync(plistPath, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FEED_BYTES) throw new Error('Invalid plist');
    const bytes = Buffer.alloc(stat.size + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== stat.size) throw new Error('Changed plist');
    return parseInstalledPlist(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)), app.getVersion());
  } catch (error) {
    if (error instanceof UpdateCheckError && error.code === 'INSTALLED_VERSION') throw error;
    throw new UpdateCheckError('INSTALLED_VERSION', 'The installed app version could not be read. The update check has stopped.');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function describeUpdate(installed, result) {
  numericVersion(installed.version); numericVersion(installed.build);
  const latest = result.latest;
  const order = compareVersions(latest.build, installed.build);
  if (order === 0 && latest.version !== installed.version) throw invalidFeed('The public feed and installed app disagree about this build number.');
  const reviewed = latest.version === REVIEWED_HOST.version && latest.build === REVIEWED_HOST.build;
  const status = order > 0 ? 'available' : order < 0 ? 'ahead-of-feed' : 'current';
  const message = { available: 'An official update is available.', 'ahead-of-feed': 'This app is newer than the public update feed.', current: 'Your official base version matches the public update feed.' }[status];
  const detail = [
    `Installed: ${installed.version} (build ${installed.build}).`,
    `Latest public release for this Mac: ${latest.version} (build ${latest.build}).`,
    `Reviewed Read Aloud base: ${REVIEWED_HOST.version} (build ${REVIEWED_HOST.build}).`,
    '',
    reviewed ? 'The listed release matches the reviewed base version. A version match alone does not verify a downloaded app or its Read Aloud integration.' : 'Read Aloud compatibility has not been verified for the listed release. A verified rebuild is needed before upgrading this copy.',
    'This check reports official releases. It does not install updates or check for newer Read Aloud add-on revisions.',
    'The public feed may differ from the rollout offered to your account.',
  ];
  if (latest.critical) detail.push('The official feed marks this release as a critical update.');
  if (result.newerSystemRequirement) detail.push(`A newer public build (${result.newerSystemRequirement.build}) has different macOS requirements.`);
  return { status, installed, latest, reviewed, message, detail: detail.join('\n') };
}

function installUpdateChecker(electron, options = {}) {
  const { app, dialog } = electron;
  if (installations.has(app)) return installations.get(app);
  let disposed = false, inFlight = null, controller = null;
  const fetchFeed = options.fetchFeed ?? fetchOfficialFeed;
  const readInstalled = options.readInstalled ?? readInstalledHost;
  async function runCheck() {
    try {
      if ((options.platform ?? process.platform) !== 'darwin' || (options.arch ?? process.arch) !== 'arm64') throw new UpdateCheckError('UNSUPPORTED_PLATFORM', 'This Read Aloud update checker supports Apple silicon Macs.');
      const installed = readInstalled(app);
      const systemVersion = options.systemVersion ?? process.getSystemVersion?.();
      numericVersion(systemVersion);
      controller = new AbortController();
      const xml = await fetchFeed({ signal: controller.signal });
      if (disposed) return { status: 'cancelled' };
      const result = describeUpdate(installed, parseAppcast(xml, { systemVersion, arch: 'arm64' }));
      await dialog.showMessageBox({ type: 'info', title: 'Read Aloud Updates', message: result.message, detail: result.detail, buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return result;
    } catch (error) {
      if (disposed) return { status: 'cancelled' };
      const detail = error instanceof UpdateCheckError ? error.message : 'The update check could not be completed. Try again later.';
      try { await dialog.showMessageBox({ type: 'warning', title: 'Read Aloud Updates', message: 'Couldn’t check for updates.', detail, buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true }); }
      catch { /* A closing window or app must not create an unhandled rejection. */ }
      return { status: 'error', code: error instanceof UpdateCheckError ? error.code : 'CHECK_ERROR' };
    } finally { controller = null; }
  }
  const api = {
    checkForUpdates() {
      if (disposed) return Promise.resolve({ status: 'cancelled' });
      if (!inFlight) inFlight = runCheck().finally(() => { inFlight = null; });
      return inFlight;
    },
    menuItemOptions(label = 'Check for Updates…') {
      return { id: MENU_ID, label, enabled: true, click: () => api.checkForUpdates() };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      app.removeListener('will-quit', api.dispose);
      installations.delete(app);
    },
  };
  app.once('will-quit', api.dispose);
  installations.set(app, api);
  return api;
}

module.exports = { FEED_URL, REVIEWED_HOST, MENU_ID, MAX_FEED_BYTES, FETCH_TIMEOUT_MS, UpdateCheckError,
  compareVersions, fetchOfficialFeed, parseAppcast, parseInstalledPlist, readInstalledHost, describeUpdate, installUpdateChecker };
