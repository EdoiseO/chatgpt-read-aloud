"""Verifier and staging checks use tiny local fixtures, never an installed app."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import asar_integrity
import configure_launcher as launcher
import verify_voice_build as verify
import speech_host_adapter as speech_host
import selection_host_adapter as selection_host
from updater_host_gate import HOST_GATE_ASSETS, HOST_GATE_ANCHORS


def write_archive(path, files, change=None):
    tree, offset, payload = {'files': {}}, 0, b''
    for key, data in files.items():
        parent = tree
        pieces = key.split('/')
        for piece in pieces[:-1]:
            parent = parent['files'].setdefault(piece, {'files': {}})
        digest = hashlib.sha256(data).hexdigest()
        parent['files'][pieces[-1]] = {'offset': str(offset), 'size': len(data),
            'integrity': {'algorithm': 'SHA256', 'hash': digest, 'blockSize': 4,
                          'blocks': [hashlib.sha256(data[i:i + 4]).hexdigest() for i in range(0, len(data), 4)]
                                    if data else [hashlib.sha256(b'').hexdigest()]}}
        offset += len(data)
        payload += data
    if change:
        change(tree)
    raw = json.dumps(tree, separators=(',', ':')).encode()
    size = ((len(raw) + 7) // 4) * 4
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack('<4I', 4, size + 4, size, len(raw)) + raw +
                     b'\0' * (size - 4 - len(raw)) + payload)
    return hashlib.sha256(raw).hexdigest()


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        app, source, home = root / 'build/ChatGPT Read Aloud.app', root / 'source', root / 'home'
        source.mkdir()
        (app / 'Contents/MacOS').mkdir(parents=True)
        home.mkdir()
        contents = {
            'response-button.js': 'function CodexLocalReadAloudButton() {}',
            'voice-picker.js': 'function CodexReadAloudVoicePicker() {getVoices();setVoice()}',
            'speech-controller.mjs': 'export function createResponseSpeaker() {}',
            'kokoro-response-speaker.mjs': 'export function createKokoroResponseSpeaker() {}',
            'response-highlight.mjs': 'export function highlight() {/* ::highlight( */}',
            'kokoro-main.cjs': '/* sandbox-exec (deny network*) */',
            'kokoro_worker.py': '# fixture worker never executed\n',
        }
        for name in ('voice-response-groups.mjs', 'voice-response-group-host.js'):
            contents[name] = (verify.ROOT / name).read_text()
        for name, content in contents.items():
            (source / name).write_text(content)
        runtime = home / 'Library/Application Support/ChatGPT Read Aloud/kokoro'
        (runtime / 'models').mkdir(parents=True)
        bank = runtime / 'models/voices-v1.0.bin'
        with zipfile.ZipFile(bank, 'w') as archive:
            archive.writestr('af_aoede.npy', b'fixture array never loaded')
            archive.writestr('af_bella.npy', b'fixture array never loaded')
        bank.chmod(0o600)
        (source / 'runtime').mkdir()
        (source / 'runtime/assets.json').write_text(json.dumps({'assets': [{
            'path': 'models/voices-v1.0.bin', 'size': bank.stat().st_size,
            'sha256': hashlib.sha256(bank.read_bytes()).hexdigest()}]}))
        worker = runtime / verify.WORKER_NAME
        worker.write_text(contents['kokoro_worker.py'])
        worker.chmod(0o600)
        settings = runtime / 'settings.json'
        settings.write_text(json.dumps({'version': 1, 'selectedVoice': 'af_aoede'}))
        settings.chmod(0o600)
        payload = '\n'.join(contents[name].replace('export ', '') for name in
                            ('response-button.js', 'voice-picker.js', 'speech-controller.mjs',
                             'kokoro-response-speaker.mjs', 'response-highlight.mjs'))
        toolbar = '\n'.join(before for _label, before, _after in speech_host.PATCHES) + '\nexport{}'
        toolbar_hash = hashlib.sha256(toolbar.encode()).hexdigest()
        with patch.object(speech_host, 'TOOLBAR_SHA256', toolbar_hash):
            asset = speech_host.append_payload(speech_host.patch_toolbar(toolbar), payload)
        timeline = '\n'.join(before for _label, before, _after in speech_host.VOICE_TIMELINE_PATCHES) + '\nexport{}'
        timeline_hash = hashlib.sha256(timeline.encode()).hexdigest()
        with patch.object(speech_host, 'VOICE_TIMELINE_SHA256', timeline_hash):
            patched_timeline = speech_host.patch_voice_timeline(timeline)
        selection = '\n'.join(before for before, _after, _label in
                              selection_host._HOST_REPLACEMENTS + selection_host._MENU_REPLACEMENTS)
        selection_hash = hashlib.sha256(selection.encode()).hexdigest()
        with patch.object(selection_host, 'HOST_SHA256', selection_hash):
            patched_selection = selection_host.patch_selection_menu(selection)
        files = {verify.ASSET: asset.encode(),
                 verify.VOICE_TIMELINE_ASSET: patched_timeline.encode(),
                 verify.SELECTION_ASSET: patched_selection.encode(),
                 verify.EARLY: b'require("./local-read-aloud-main.cjs");',
                 verify.PRELOAD: b'exposeInMainWorld("codexLocalReadAloud" /* sentenceRanges */',
                 verify.MAIN: contents['kokoro-main.cjs'].encode()}
        gate_files = {key: b'\n'.join(HOST_GATE_ANCHORS[key]) for key in HOST_GATE_ASSETS}
        files.update(gate_files)
        archive = app / verify.RESOURCE
        header_hash = write_archive(archive, files)
        integrity = {'Resources/app.asar': {'algorithm': 'SHA256', 'hash': header_hash}}
        info = {'CFBundleIdentifier': 'local.edoise.codex.readaloud', 'CFBundleExecutable': 'ChatGPT',
                'CFBundleShortVersionString': verify.VERSION, 'CodexReadAloudVoicePickerVersion': 1,
                'CodexReadAloudSelectionHighlightVersion': 1, 'CodexReadAloudSkipCodeBlocksVersion': 1,
                'CodexReadAloudLauncherVersion': 3, 'CodexReadAloudUpdaterPolicyVersion': 2,
                'CodexReadAloudSpeechHostAdapterVersion': speech_host.ADAPTER_VERSION,
                'SUEnableAutomaticChecks': False, 'SUAutomaticallyUpdate': False,
                'SUAllowsAutomaticUpdates': False, 'ElectronAsarIntegrity': integrity,
                'LSEnvironment': {'CODEX_ELECTRON_USER_DATA_PATH': str(runtime.parent / 'user-data'),
                                  'CODEX_SPARKLE_ENABLED': 'false'}}
        info_path = app / 'Contents/Info.plist'
        info_path.write_bytes(plistlib.dumps(info))
        framework = app / verify.FRAMEWORK
        framework.parent.mkdir(parents=True)
        framework.write_bytes(asar_integrity.SENTINEL + b'\x01\x01' +
                              asar_integrity.integrity_dictionary_digest(integrity))
        (app / 'Contents/MacOS/ChatGPT').write_bytes(
            b'SUEnableAutomaticChecks\0SUAutomaticallyUpdate\0NO\0CODEX_SPARKLE_ENABLED\0false\0')
        (app / 'Contents/MacOS/ChatGPT-native').write_bytes(b'fixture native executable')
        commands = []
        def runner(arguments, **kwargs):
            commands.append(list(arguments))
            return SimpleNamespace(returncode=0, stdout='0\n' if arguments[0] == '/usr/bin/defaults' else '', stderr='')
        with patch.dict(HOST_GATE_ASSETS, {key: hashlib.sha256(value).hexdigest()
                                          for key, value in gate_files.items()}, clear=True), \
                patch.object(speech_host, 'TOOLBAR_SHA256', toolbar_hash), \
                patch.object(speech_host, 'VOICE_TIMELINE_SHA256', timeline_hash), \
                patch.object(selection_host, 'HOST_SHA256', selection_hash):
            yield SimpleNamespace(root=root, app=app, home=home, source=source, runtime=runtime,
                                  archive=archive, info=info, info_path=info_path, files=files,
                                  header_hash=header_hash, framework=framework, runner=runner, commands=commands,
                                  ui_hashes={'toolbar': toolbar_hash, 'timeline': timeline_hash,
                                             'selection': selection_hash})


def check(data, **kwargs):
    return verify.verify_build(data.app, home=data.home, source_root=data.source, runner=data.runner, **kwargs)


class VerifierTests(unittest.TestCase):
    def test_complete_staged_and_installed_scopes_and_voice_are_read_only(self):
        with fixture() as data:
            settings = (data.runtime / 'settings.json').read_bytes()
            report = check(data)
            self.assertEqual(report['activation'], 'staged')
            self.assertEqual(report['verificationScope'], 'staged')
            self.assertTrue(report['voiceChoiceInformational'])
            self.assertEqual(report['voiceChoice'], 'af_aoede')
            self.assertEqual(report['availableVoiceCount'], 2)
            self.assertEqual(report['packedAssetsVerified'], 8)
            self.assertTrue(report['staticUIAdapterVerified'])
            self.assertEqual(report['speechHostAdapter']['adapterVersion'], speech_host.ADAPTER_VERSION)
            self.assertTrue(report['speechHostAdapter']['selectionIndependentOfNativeActions'])
            self.assertTrue(report['speechHostAdapter']['voiceTimeline']['canonicalVoiceResponseGrouping'])
            self.assertTrue(report['selectionHostAdapter']['exactSelectionRouting'])
            self.assertEqual(report['selectionHostAdapter']['hostSelectionSha256'], data.ui_hashes['selection'])
            self.assertFalse(report['desktopBehaviorVerified'])
            self.assertFalse(report['manualAudioVerified'])
            self.assertIn('static pinned', report['integrationVerification'])
            self.assertNotIn('manualUpdateCheckVerified', report)
            self.assertTrue(report['updaterPolicy']['hostUpdaterDisabled'])
            self.assertTrue(report['updaterPolicy']['manualUpdatesBlocked'])
            self.assertEqual(check(data, scope='installed')['activation'], 'installed')
            self.assertEqual((data.runtime / 'settings.json').read_bytes(), settings)
            self.assertEqual(len(data.commands), 6)

    def test_installed_effective_preferences_cannot_hide_behind_stale_disk_values(self):
        with fixture() as data:
            prefs = data.home / 'Library/Preferences/local.edoise.codex.readaloud.plist'
            prefs.parent.mkdir(parents=True)
            prefs.write_bytes(plistlib.dumps({'SUEnableAutomaticChecks': False, 'SUAutomaticallyUpdate': False}))
            data.runner = lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout='1\n', stderr='')
            with self.assertRaisesRegex(RuntimeError, 'remains enabled'):
                check(data, scope='installed')

    def test_saved_voice_can_change_or_be_absent_without_changing_build_identity(self):
        with fixture() as data:
            initial = check(data)
            path = data.runtime / 'settings.json'
            for voice in ('af_bella', None):
                path.write_text(json.dumps({'version': 1, 'selectedVoice': voice}))
                latest = check(data)
                self.assertEqual(latest['voiceChoice'], voice)
                self.assertEqual(latest['asarHeaderHash'], initial['asarHeaderHash'])
                self.assertEqual(latest['mainModuleHash'], initial['mainModuleHash'])
            path.unlink()
            self.assertIsNone(check(data)['voiceChoice'])

    def test_supported_voice_bank_required_and_unknown_regex_matching_voice_rejected(self):
        with fixture() as data:
            (data.runtime / 'settings.json').write_text(json.dumps({'version': 1, 'selectedVoice': 'af_invented'}))
            with self.assertRaisesRegex(RuntimeError, 'not supported'):
                check(data)
            bank = data.runtime / 'models/voices-v1.0.bin'
            bank.write_bytes(bank.read_bytes() + b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'pinned'):
                check(data)

    def test_staged_reports_conflicting_preferences_installed_requires_disabled(self):
        with fixture() as data:
            prefs = data.home / 'Library/Preferences/local.edoise.codex.readaloud.plist'
            prefs.parent.mkdir(parents=True)
            prefs.write_bytes(plistlib.dumps({'SUEnableAutomaticChecks': True, 'SUAutomaticallyUpdate': True}))
            before = prefs.read_bytes()
            self.assertTrue(check(data)['updaterPolicy']['savedPreferencesConflict'])
            with self.assertRaisesRegex(verify.VerificationError, 'updater preferences'):
                check(data, scope='installed')
            self.assertEqual(prefs.read_bytes(), before)

    def test_invalid_sizes_integrity_and_truncated_archives_reject_promptly(self):
        with fixture() as data:
            for field, value in (('size', -1), ('size', True), ('offset', '-1')):
                with self.subTest(field=field, value=value):
                    digest = write_archive(data.archive, {'test': b'hello'},
                        lambda tree: tree['files']['test'].__setitem__(field, value))
                    with self.assertRaisesRegex(verify.VerificationError, 'offset or size'):
                        verify.verify_archive(data.archive, digest)
            for block_size in (0, -1, True, verify.MAX_BLOCK_BYTES + 1):
                with self.subTest(block_size=block_size):
                    digest = write_archive(data.archive, {'test': b'hello'},
                        lambda tree: tree['files']['test']['integrity'].__setitem__('blockSize', block_size))
                    with self.assertRaisesRegex(verify.VerificationError, 'integrity metadata'):
                        verify.verify_archive(data.archive, digest)
            digest = write_archive(data.archive, {'test': b'hello'})
            data.archive.write_bytes(data.archive.read_bytes()[:-1])
            with self.assertRaisesRegex(verify.VerificationError, 'Truncated'):
                verify.verify_archive(data.archive, digest)
            data.archive.write_bytes(struct.pack('<4I', 4, 100, 96, 89))
            with self.assertRaisesRegex(verify.VerificationError, 'Truncated'):
                verify.verify_archive(data.archive, digest)

    def test_codesign_and_embedded_integrity_are_independent_required_checks(self):
        with fixture() as data:
            data.framework.write_bytes(data.framework.read_bytes()[:-1] + b'X')
            with self.assertRaisesRegex(ValueError, 'digest disagree'):
                check(data)
            self.assertEqual(len(data.commands), 2)
        with fixture() as data:
            with self.assertRaises(subprocess.CalledProcessError):
                verify.verify_build(data.app, home=data.home, source_root=data.source,
                    runner=lambda arguments, **_kwargs: (_ for _ in ()).throw(subprocess.CalledProcessError(1, arguments)))

    def test_corruption_fails_with_normal_optimized_and_environment_optimized_python(self):
        code = ('from pathlib import Path; import sys,json; import verify_voice_build as v; '
                'import updater_host_gate as g; g.HOST_GATE_ASSETS.update(json.loads(sys.argv[4])); '
                'import speech_host_adapter as h, selection_host_adapter as s; pins=json.loads(sys.argv[5]); '
                'h.TOOLBAR_SHA256=pins["toolbar"]; h.VOICE_TIMELINE_SHA256=pins["timeline"]; s.HOST_SHA256=pins["selection"]; '
                'v.verify_build(Path(sys.argv[1]),home=Path(sys.argv[2]),source_root=Path(sys.argv[3]),'
                'runner=lambda *a,**k:None)')
        for mutation in ('valid', 'identity', 'marker', 'header', 'truncated', 'block_size', 'stale_worker', 'voice',
                         'ui_marker', 'toolbar_host', 'timeline_host', 'selection_host', 'stale_group'):
            with self.subTest(mutation=mutation), fixture() as data:
                if mutation == 'identity':
                    data.info['CFBundleIdentifier'] = 'wrong'
                elif mutation == 'marker':
                    data.info['CodexReadAloudSkipCodeBlocksVersion'] = 0
                elif mutation == 'header':
                    data.info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = '0' * 64
                    data.framework.write_bytes(asar_integrity.SENTINEL + b'\x01\x01' +
                        asar_integrity.integrity_dictionary_digest(data.info['ElectronAsarIntegrity']))
                elif mutation == 'truncated':
                    data.archive.write_bytes(data.archive.read_bytes()[:-1])
                elif mutation == 'block_size':
                    digest = write_archive(data.archive, data.files,
                        lambda tree: tree['files']['webview']['files']['assets']['files'][Path(verify.ASSET).name]['integrity'].__setitem__('blockSize', 0))
                    data.info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = digest
                    data.framework.write_bytes(asar_integrity.SENTINEL + b'\x01\x01' +
                        asar_integrity.integrity_dictionary_digest(data.info['ElectronAsarIntegrity']))
                elif mutation == 'stale_worker':
                    (data.runtime / verify.WORKER_NAME).write_text('# stale worker')
                elif mutation == 'voice':
                    (data.runtime / 'settings.json').write_text(json.dumps({'version': 1, 'selectedVoice': 'af_invented'}))
                elif mutation == 'ui_marker':
                    data.info['CodexReadAloudSpeechHostAdapterVersion'] = speech_host.ADAPTER_VERSION - 1
                elif mutation in ('toolbar_host', 'timeline_host', 'selection_host'):
                    key = {'toolbar_host': verify.ASSET, 'timeline_host': verify.VOICE_TIMELINE_ASSET,
                           'selection_host': verify.SELECTION_ASSET}[mutation]
                    data.files[key] += b'\n/* unreviewed host change */'
                    digest = write_archive(data.archive, data.files)
                    data.info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = digest
                    data.framework.write_bytes(asar_integrity.SENTINEL + b'\x01\x01' +
                        asar_integrity.integrity_dictionary_digest(data.info['ElectronAsarIntegrity']))
                elif mutation == 'stale_group':
                    (data.source / 'voice-response-group-host.js').write_text('/* newer grouping UI */')
                data.info_path.write_bytes(plistlib.dumps(data.info))
                for flag, optimized in (([], None), (['-O'], None), ([], '1')):
                    environment = dict(os.environ)
                    environment.pop('PYTHONOPTIMIZE', None)
                    if optimized:
                        environment['PYTHONOPTIMIZE'] = optimized
                    result = subprocess.run([sys.executable, *flag, '-c', code, str(data.app), str(data.home),
                                             str(data.source), json.dumps(HOST_GATE_ASSETS), json.dumps(data.ui_hashes)],
                                            cwd=verify.ROOT, env=environment, capture_output=True, text=True, timeout=5)
                    if mutation == 'valid':
                        self.assertEqual(result.returncode, 0, result.stderr)
                        continue
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertNotIn('AssertionError', result.stderr)
                    self.assertIn('Error', result.stderr)


class LauncherStageTests(unittest.TestCase):
    def test_installed_targets_rejected_before_commands_or_files_are_read(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            for path in (Path('/Applications/ChatGPT Read Aloud.app'), home / 'Applications/ChatGPT Read Aloud.app'):
                with self.subTest(path=path), patch.object(launcher.subprocess, 'run') as run:
                    with self.assertRaisesRegex(RuntimeError, 'stage-only'):
                        launcher.validate_stage_target(path, home=home)
                    run.assert_not_called()

    def test_private_fresh_install_stage_permitted_but_nested_or_public_folder_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            apps = home / 'Applications'
            apps.mkdir()
            with tempfile.TemporaryDirectory(prefix='.chatgpt-read-aloud-install-', dir=apps) as folder:
                stage = Path(folder) / 'ChatGPT Read Aloud.app'
                self.assertEqual(launcher.validate_stage_target(stage, home=home), stage)
                with self.assertRaisesRegex(RuntimeError, 'inside another app'):
                    launcher.validate_stage_target(stage / 'inner.app', home=home)
                Path(folder).chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, 'private'):
                    launcher.validate_stage_target(stage, home=home)

    def test_compile_or_signature_failure_preserves_complete_input_stage(self):
        for failure in ('compile', 'sign'):
            with self.subTest(failure=failure), fixture() as data:
                # An unconfigured stage has only the native entry.
                (data.app / 'Contents/MacOS/ChatGPT-native').unlink()
                before = {str(path.relative_to(data.app)): path.read_bytes()
                          for path in data.app.rglob('*') if path.is_file()}
                def runner(arguments, **_kwargs):
                    if arguments[0] == 'xcrun':
                        if failure == 'compile':
                            raise subprocess.CalledProcessError(1, arguments)
                        Path(arguments[-1]).write_bytes(b'fixture compiled launcher')
                    if arguments[0] == 'codesign' and '--force' in arguments and failure == 'sign':
                        raise subprocess.CalledProcessError(1, arguments)
                    return SimpleNamespace(returncode=0, stdout='', stderr='')
                with patch.object(launcher.subprocess, 'run', side_effect=runner):
                    with self.assertRaises(subprocess.CalledProcessError):
                        launcher.main(data.app, profile=data.runtime.parent / 'user-data')
                after = {str(path.relative_to(data.app)): path.read_bytes()
                         for path in data.app.rglob('*') if path.is_file()}
                self.assertEqual(before, after)
                self.assertEqual(list(data.app.parent.iterdir()), [data.app])

    def test_refresh_launcher_preserves_native_and_profile_and_never_registers(self):
        with fixture() as data:
            native = (data.app / 'Contents/MacOS/ChatGPT-native').read_bytes()
            profile = data.runtime.parent / 'user-data'
            commands = []
            def runner(arguments, **_kwargs):
                commands.append(arguments)
                if arguments[0] == 'xcrun':
                    Path(arguments[-1]).write_bytes(b'updated wrapper')
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            with patch.object(launcher.subprocess, 'run', side_effect=runner), patch('builtins.print'):
                launcher.main(data.app, profile=profile, refresh_launcher=True)
            self.assertEqual((data.app / 'Contents/MacOS/ChatGPT-native').read_bytes(), native)
            self.assertEqual((data.app / 'Contents/MacOS/ChatGPT').read_bytes(), b'updated wrapper')
            info = plistlib.loads(data.info_path.read_bytes())
            self.assertEqual(info['CodexReadAloudLauncherVersion'], 3)
            self.assertEqual(info['LSEnvironment']['CODEX_ELECTRON_USER_DATA_PATH'], str(profile))
            self.assertFalse(any('lsregister' in str(argument) for arguments in commands for argument in arguments))


if __name__ == '__main__':
    unittest.main()
