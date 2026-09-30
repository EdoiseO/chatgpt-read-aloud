#!/usr/bin/env python3
"""Verify every packed asset, signature, launcher, and voice-picker hook."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess

from asar_integrity import patch_integrity_slot
from build_copy import ASSET, SELECTION_ASSET, SELECTION_BUTTON, EARLY, PRELOAD, MAIN, FRAMEWORK, RESOURCE, VERSION, read_header, named_entries

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=ROOT / 'build/ChatGPT Read Aloud.app')
    parser.add_argument('--report', type=Path, default=ROOT / 'voice-build-verification.json')
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'local.edoise.codex.readaloud'
    assert info['CFBundleShortVersionString'] == VERSION
    assert info['CodexReadAloudVoicePickerVersion'] == 1
    assert info['CodexReadAloudSelectionHighlightVersion'] == 1
    assert info['CodexReadAloudSkipCodeBlocksVersion'] == 1
    assert info['CodexReadAloudLauncherVersion'] == 1
    assert info['LSEnvironment']['CODEX_ELECTRON_USER_DATA_PATH'] == str(
        Path.home() / 'Library/Application Support/ChatGPT Read Aloud/user-data')
    assert (app / 'Contents/MacOS/ChatGPT-native').is_file()
    for target in (app, Path('/Applications/ChatGPT.app')):
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(target)], check=True)
    patch_integrity_slot((app / FRAMEWORK).read_bytes(),
                         info['ElectronAsarIntegrity'], info['ElectronAsarIntegrity'])
    hooks = {}
    count = 0
    with (app / RESOURCE).open('rb') as stream:
        tree, raw, body = read_header(stream)
        assert hashlib.sha256(raw).hexdigest() == info['ElectronAsarIntegrity']['Resources/app.asar']['hash']
        expected_end = 0
        for key, item in sorted(named_entries(tree), key=lambda pair: int(pair[1]['offset'])):
            offset = int(item['offset'])
            assert offset == expected_end, (key, offset, expected_end)
            expected_end += item['size']
            stream.seek(body + offset)
            digest = hashlib.sha256()
            blocks = []
            remaining = item['size']
            while remaining:
                data = stream.read(min(remaining, item['integrity']['blockSize']))
                assert data
                remaining -= len(data)
                digest.update(data)
                blocks.append(hashlib.sha256(data).hexdigest())
            if item['size'] == 0:
                blocks = [hashlib.sha256(b'').hexdigest()]
            assert digest.hexdigest() == item['integrity']['hash'], key
            assert blocks == item['integrity']['blocks'], key
            count += 1
            if key in (ASSET, SELECTION_ASSET, EARLY, PRELOAD, MAIN):
                stream.seek(body + offset)
                hooks[key] = stream.read(item['size']).decode()
        assert body + expected_end == (app / RESOURCE).stat().st_size
    assert hooks[EARLY].count('require("./local-read-aloud-main.cjs")') == 1
    assert hooks[PRELOAD].count('exposeInMainWorld("codexLocalReadAloud"') == 1
    assert hooks[ASSET].count('function CodexReadAloudVoicePicker(') == 1
    assert hooks[ASSET].count('function CodexLocalReadAloudButton(') == 1
    for source in ('response-button.js', 'voice-picker.js'):
        assert (ROOT / source).read_text() in hooks[ASSET], f'Staged UI is stale: {source}'
    assert 'getVoices' in hooks[ASSET] and 'setVoice' in hooks[ASSET]
    for source, function in [('speech-controller.mjs', 'createResponseSpeaker'),
                             ('kokoro-response-speaker.mjs', 'createKokoroResponseSpeaker')]:
        expected = (ROOT / source).read_text().replace('export function ' + function, 'function ' + function, 1)
        assert expected in hooks[ASSET], f'Staged speech controller is stale: {source}'
    assert (ROOT / 'response-highlight.mjs').read_text().replace('export ', '') in hooks[ASSET]
    assert hooks[ASSET].count('getReadAloudRoot:()=>ye.current?.querySelector(`[data-selected-text-overlay-target]`)') == 1
    assert '::highlight(' in hooks[ASSET] and 'sentenceRanges' in hooks[PRELOAD]
    assert hooks[SELECTION_ASSET].count('"data-codex-local-read-aloud":"selection"') == 1
    assert SELECTION_BUTTON in hooks[SELECTION_ASSET], 'Staged selection action is stale'
    assert 'readAloudRoot:u,readAloudRange:l' in hooks[SELECTION_ASSET]
    assert 'globalThis.codexReadSelectionAloud(codexSelectionRoot,codexSelectionRange)' in hooks[SELECTION_ASSET]
    assert 'af_heart' not in hooks[ASSET], 'No voice may be forced in the response UI'
    assert 'sandbox-exec' in hooks[MAIN] and '(deny network*)' in hooks[MAIN]
    main_hash = hashlib.sha256(hooks[MAIN].encode()).hexdigest()
    assert main_hash == hashlib.sha256((ROOT / 'kokoro-main.cjs').read_bytes()).hexdigest()
    worker_path = Path.home() / 'Library/Application Support/ChatGPT Read Aloud/kokoro/worker-sentences-v1.py'
    assert worker_path.is_file() and not worker_path.is_symlink()
    assert worker_path.stat().st_mode & 0o077 == 0
    worker_hash = hashlib.sha256(worker_path.read_bytes()).hexdigest()
    assert worker_hash == hashlib.sha256((ROOT / 'kokoro_worker.py').read_bytes()).hexdigest()
    settings_path = worker_path.parent / 'settings.json'
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    selected_voice = settings.get('selectedVoice')
    assert selected_voice is None or (isinstance(selected_voice, str)
        and re.fullmatch(r'(?:af|am|bf|bm)_[a-z0-9]+', selected_voice)), 'Invalid saved voice'
    report = {'app': str(app), 'version': VERSION, 'packedAssetsVerified': count,
              'signaturesVerified': True, 'embeddedAsarIntegrityVerified': True,
              'permanentProfilePreserved': True, 'voicePickerHooksVerified': True,
              'selectionHighlightHooksVerified': True,
              'codeBlockSkippingVerified': True,
              'runtimeWorkerPath': str(worker_path), 'runtimeWorkerHash': worker_hash,
              'voiceChoice': selected_voice,
              'voiceName': selected_voice.split('_', 1)[1].title() if selected_voice else None,
              'asarHeaderHash': hashlib.sha256(raw).hexdigest(), 'mainModuleHash': main_hash,
              'manualAudioVerified': False, 'activation': 'staged'}
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
