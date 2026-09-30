#!/usr/bin/env python3
"""Verify packed assets, signatures, launcher, and local speech readiness.

These checks are explicit exceptions so optimized Python cannot disable them.
Verification is read-only; it never repairs preferences or voice settings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import subprocess

from asar_integrity import patch_integrity_slot
from build_copy import ASSET, SELECTION_ASSET, SELECTION_BUTTON, EARLY, PRELOAD, MAIN, FRAMEWORK, RESOURCE, VERSION
from runtime_voices import read_saved_voice, supported_voice_ids

ROOT = Path(__file__).resolve().parent
MAX_HEADER_BYTES = 64 * 1024 * 1024
MAX_BLOCK_BYTES = 64 * 1024 * 1024
MAX_HOOK_BYTES = 128 * 1024 * 1024
WORKER_NAME = 'worker-sentences-v2.py'
SHA256 = re.compile(r'[0-9a-f]{64}')


class VerificationError(RuntimeError):
    """The bundle or its local readiness data failed an explicit check."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def read_header(stream, archive_size):
    """Read a bounded Chromium pickle header before allocating its JSON body."""
    prefix = stream.read(16)
    require(len(prefix) == 16, 'Truncated ASAR header prefix')
    pickle_size, header_size, payload_size, raw_size = struct.unpack('<4I', prefix)
    require(pickle_size == 4 and header_size == payload_size + 4,
            'Unexpected ASAR pickle header layout')
    require(0 < raw_size <= MAX_HEADER_BYTES and payload_size == ((raw_size + 7) // 4) * 4,
            'Invalid or oversized ASAR JSON header length')
    body = 8 + header_size
    require(body <= archive_size and 16 + raw_size <= body, 'Truncated ASAR header body')
    raw = stream.read(raw_size)
    require(len(raw) == raw_size, 'Truncated ASAR JSON header')
    try:
        tree = json.loads(raw)
    except (UnicodeError, ValueError) as error:
        raise VerificationError('Invalid ASAR JSON header') from error
    require(isinstance(tree, dict) and isinstance(tree.get('files'), dict),
            'ASAR header must contain a file tree')
    return tree, raw, body


def packed_entries(tree):
    """Validate the tree without trusting offsets, sizes, or integrity metadata."""
    stack = [('', tree, 0)]
    count = 0
    while stack:
        prefix, directory, depth = stack.pop()
        require(depth <= 128, 'ASAR directory nesting exceeds the verification limit')
        require(isinstance(directory.get('files'), dict), 'Invalid ASAR directory')
        for name, item in directory['files'].items():
            count += 1
            require(count <= 100000, 'ASAR entry count exceeds the verification limit')
            require(isinstance(name, str) and name not in ('', '.', '..') and '/' not in name
                    and isinstance(item, dict), 'Invalid ASAR file entry')
            key = prefix + name
            if 'files' in item:
                stack.append((key + '/', item, depth + 1))
                continue
            if item.get('unpacked') or 'link' in item:
                continue
            offset = item.get('offset')
            size = item.get('size')
            require(isinstance(offset, str) and re.fullmatch(r'[0-9]+', offset) is not None
                    and len(offset) <= 20 and type(size) is int and size >= 0,
                    f'Invalid ASAR offset or size: {key}')
            integrity = item.get('integrity')
            require(isinstance(integrity, dict) and integrity.get('algorithm') == 'SHA256'
                    and isinstance(integrity.get('hash'), str) and SHA256.fullmatch(integrity['hash'])
                    and type(integrity.get('blockSize')) is int
                    and 0 < integrity['blockSize'] <= MAX_BLOCK_BYTES
                    and isinstance(integrity.get('blocks'), list)
                    and all(isinstance(value, str) and SHA256.fullmatch(value) for value in integrity['blocks']),
                    f'Invalid ASAR integrity metadata: {key}')
            yield key, item


def verify_archive(path, recorded_hash):
    require(isinstance(recorded_hash, str) and SHA256.fullmatch(recorded_hash),
            'Invalid recorded ASAR header SHA256')
    hooks = {}
    archive_size = path.stat().st_size
    count = 0
    with path.open('rb') as stream:
        tree, raw, body = read_header(stream, archive_size)
        require(hashlib.sha256(raw).hexdigest() == recorded_hash, 'ASAR header SHA256 disagrees with the plist')
        expected_end = 0
        for key, item in sorted(packed_entries(tree), key=lambda pair: int(pair[1]['offset'])):
            offset, size = int(item['offset']), item['size']
            require(offset == expected_end, f'ASAR packed layout is not contiguous: {key}')
            require(size <= archive_size - body - offset, f'Truncated ASAR packed asset: {key}')
            expected_end += size
            stream.seek(body + offset)
            digest, blocks, remaining = hashlib.sha256(), [], size
            while remaining:
                requested = min(remaining, item['integrity']['blockSize'])
                data = stream.read(requested)
                require(len(data) == requested, f'Unexpected EOF in ASAR packed asset: {key}')
                remaining -= len(data)
                digest.update(data)
                blocks.append(hashlib.sha256(data).hexdigest())
            if size == 0:
                blocks = [hashlib.sha256(b'').hexdigest()]
            require(digest.hexdigest() == item['integrity']['hash'], f'ASAR packed asset SHA256 disagrees: {key}')
            require(blocks == item['integrity']['blocks'], f'ASAR packed block hashes disagree: {key}')
            count += 1
            if key in (ASSET, SELECTION_ASSET, EARLY, PRELOAD, MAIN):
                require(size <= MAX_HOOK_BYTES, f'ASAR speech hook exceeds the verification limit: {key}')
                stream.seek(body + offset)
                try:
                    hooks[key] = stream.read(size).decode('utf-8')
                except UnicodeError as error:
                    raise VerificationError(f'Invalid UTF-8 speech hook: {key}') from error
        require(body + expected_end == archive_size, 'ASAR archive has unverified trailing bytes')
    require(count > 0, 'ASAR archive has no packed assets')
    return hooks, count, hashlib.sha256(raw).hexdigest()


def private_file(path, description):
    """Refuse symlinks/FIFOs and check the opened object before reading it."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
                    and metadata.st_mode & 0o077 == 0, f'{description} must be a private owned regular file')
            return stream.read()
    except OSError as error:
        raise VerificationError(f'{description} is unavailable or symlinked') from error


def verify_voice_settings(runtime, manifest_path=ROOT / 'runtime/assets.json'):
    voices = supported_voice_ids(runtime, manifest_path)
    return read_saved_voice(runtime, voices), voices


def verification_scope(app, home):
    applications = (Path('/Applications'), home / 'Applications')
    # A fresh installation verifies a private temporary stage on the destination
    # volume before publication; that path is still staged, not installed.
    if app.parent.name.startswith('.chatgpt-read-aloud-install-'):
        return 'staged'
    return 'installed' if any(app.is_relative_to(path) for path in applications) else 'staged'


def verify_build(app, *, home=None, official=Path('/Applications/ChatGPT.app'), source_root=ROOT,
                 runner=subprocess.run, scope=None):
    home = Path.home() if home is None else Path(home)
    source_root = Path(source_root)
    original_app = Path(app)
    require(not original_app.is_symlink(), 'Verification target must not be a symlinked bundle')
    app = original_app.resolve(strict=True)
    scope = verification_scope(app, home) if scope is None else scope
    require(scope in ('staged', 'installed'), 'Unknown verification scope')
    for relative in (Path('Contents/Info.plist'), RESOURCE, FRAMEWORK,
                     Path('Contents/MacOS/ChatGPT'), Path('Contents/MacOS/ChatGPT-native')):
        require((app / relative).resolve(strict=True).is_relative_to(app),
                f'Bundle verification path escapes the app: {relative}')
        require((app / relative).is_file(), f'Bundle verification file is missing: {relative}')
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    require(info.get('CFBundleIdentifier') == 'local.edoise.codex.readaloud', 'Unexpected custom bundle identifier')
    require(info.get('CFBundleShortVersionString') == VERSION, 'Unsupported custom app version')
    for marker in ('CodexReadAloudVoicePickerVersion', 'CodexReadAloudSelectionHighlightVersion',
                   'CodexReadAloudSkipCodeBlocksVersion'):
        require(type(info.get(marker)) is int and info[marker] == 1, f'Missing or invalid feature marker: {marker}')
    require(type(info.get('CodexReadAloudLauncherVersion')) is int and info['CodexReadAloudLauncherVersion'] == 2,
            'Native launcher policy version is missing or invalid')
    require(isinstance(info.get('LSEnvironment'), dict) and
            info['LSEnvironment'].get('CODEX_ELECTRON_USER_DATA_PATH') == str(
                home / 'Library/Application Support/ChatGPT Read Aloud/user-data'), 'Permanent profile binding disagrees')
    from updater_policy import report_update_policy, validate_bundle_policy
    validate_bundle_policy(info)
    updater = report_update_policy(app, home=home)
    if scope == 'installed':
        require(updater.get('automaticChecksDisabled') is True and updater.get('automaticDownloadsDisabled') is True
                and updater.get('savedPreferencesConflict') is False,
                'Installed custom updater preferences must disable automatic checks and downloads')
    for target in (app, official):
        runner(['codesign', '--verify', '--deep', '--strict', str(target)], check=True)
    patch_integrity_slot((app / FRAMEWORK).read_bytes(),
                         info.get('ElectronAsarIntegrity'), info.get('ElectronAsarIntegrity'))
    recorded = info.get('ElectronAsarIntegrity', {}).get('Resources/app.asar', {}).get('hash')
    hooks, count, header_hash = verify_archive(app / RESOURCE, recorded)
    for key in (ASSET, SELECTION_ASSET, EARLY, PRELOAD, MAIN):
        require(key in hooks, f'Required speech hook asset is missing: {key}')
    require(hooks[EARLY].count('require("./local-read-aloud-main.cjs")') == 1, 'Main bootstrap hook is missing or duplicated')
    require(hooks[PRELOAD].count('exposeInMainWorld("codexLocalReadAloud"') == 1, 'Speech preload bridge is missing or duplicated')
    require(hooks[ASSET].count('function CodexReadAloudVoicePicker(') == 1, 'Voice-picker hook is missing or duplicated')
    require(hooks[ASSET].count('function CodexLocalReadAloudButton(') == 1, 'Response speaker hook is missing or duplicated')
    for source in ('response-button.js', 'voice-picker.js'):
        require((source_root / source).read_text() in hooks[ASSET], f'Bundled UI is stale: {source}')
    require('getVoices' in hooks[ASSET] and 'setVoice' in hooks[ASSET], 'Voice-picker bridge actions are missing')
    for source, function in [('speech-controller.mjs', 'createResponseSpeaker'),
                             ('kokoro-response-speaker.mjs', 'createKokoroResponseSpeaker')]:
        expected = (source_root / source).read_text().replace('export function ' + function, 'function ' + function, 1)
        require(expected in hooks[ASSET], f'Bundled speech controller is stale: {source}')
    require((source_root / 'response-highlight.mjs').read_text().replace('export ', '') in hooks[ASSET],
            'Bundled response highlighter is stale')
    require(hooks[ASSET].count('getReadAloudRoot:()=>ye.current?.querySelector(`[data-selected-text-overlay-target]`)') == 1,
            'Scoped response-root routing is missing or duplicated')
    require('::highlight(' in hooks[ASSET] and 'sentenceRanges' in hooks[PRELOAD], 'Sentence highlighting hooks are missing')
    require(hooks[SELECTION_ASSET].count('"data-codex-local-read-aloud":"selection"') == 1,
            'Selection speech hook is missing or duplicated')
    require(SELECTION_BUTTON in hooks[SELECTION_ASSET], 'Bundled selection action is stale')
    require('readAloudRoot:u,readAloudRange:l' in hooks[SELECTION_ASSET] and
            'globalThis.codexReadSelectionAloud(codexSelectionRoot,codexSelectionRange)' in hooks[SELECTION_ASSET],
            'Selection range routing is missing')
    require('af_heart' not in hooks[ASSET], 'No voice may be forced in the response UI')
    require('sandbox-exec' in hooks[MAIN] and '(deny network*)' in hooks[MAIN], 'Local worker network denial is missing')
    main_hash = hashlib.sha256(hooks[MAIN].encode()).hexdigest()
    require(main_hash == hashlib.sha256((source_root / 'kokoro-main.cjs').read_bytes()).hexdigest(),
            'Bundled main speech bridge is stale')
    worker_path = home / 'Library/Application Support/ChatGPT Read Aloud/kokoro' / WORKER_NAME
    worker_hash = hashlib.sha256(private_file(worker_path, 'Sentence worker')).hexdigest()
    require(worker_hash == hashlib.sha256((source_root / 'kokoro_worker.py').read_bytes()).hexdigest(),
            'Runtime sentence worker does not match the source')
    selected_voice, voices = verify_voice_settings(worker_path.parent, source_root / 'runtime/assets.json')
    return {'app': str(app), 'version': VERSION, 'packedAssetsVerified': count,
            'signaturesVerified': True, 'embeddedAsarIntegrityVerified': True,
            'permanentProfilePreserved': True, 'voicePickerHooksVerified': True,
            'selectionHighlightHooksVerified': True, 'codeBlockSkippingVerified': True,
            'runtimeWorkerPath': str(worker_path), 'runtimeWorkerHash': worker_hash,
            'runtimeProtocolVersion': 2, 'voiceChoice': selected_voice,
            'voiceName': selected_voice.split('_', 1)[1].title() if selected_voice else None,
            'availableVoiceCount': len(voices), 'voiceChoiceInformational': True,
            'updaterPolicy': updater, 'asarHeaderHash': header_hash, 'mainModuleHash': main_hash,
            'manualAudioVerified': False, 'verificationScope': scope, 'activation': scope}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT / 'build/ChatGPT Read Aloud.app')
    parser.add_argument('--report', type=Path, default=ROOT / 'voice-build-verification.json')
    args = parser.parse_args()
    try:
        report = verify_build(args.app)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Verification failed: {error}') from None
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
