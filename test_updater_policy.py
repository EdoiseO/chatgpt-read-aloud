"""Updater and voice-policy regressions use temporary data and mocked writes."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import runtime_voices as voices
import updater_policy as policy

ROOT = Path(__file__).resolve().parent


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        home, app = root / 'home', root / 'ChatGPT Read Aloud.app'
        home.mkdir()
        (app / 'Contents/MacOS').mkdir(parents=True)
        info = {'CFBundleIdentifier': policy.IDENTITY, 'CodexReadAloudUpdaterPolicyVersion': 1,
                'CodexReadAloudLauncherVersion': 2, **{key: False for key in policy.KEYS}}
        info_path = app / 'Contents/Info.plist'
        info_path.write_bytes(plistlib.dumps(info))
        (app / 'Contents/MacOS/ChatGPT').write_bytes(b'SUEnableAutomaticChecks\0SUAutomaticallyUpdate\0NO\0')
        prefs = home / 'Library/Preferences' / (policy.IDENTITY + '.plist')
        prefs.parent.mkdir(parents=True)
        yield SimpleNamespace(root=root, home=home, app=app, info=info, info_path=info_path, prefs=prefs)


class UpdaterPolicyTests(unittest.TestCase):
    def test_absent_preferences_use_disabled_defaults_and_explicit_manual_update_limit(self):
        with fixture() as data:
            report = policy.report_update_policy(data.app, data.home)
            self.assertTrue(report['automaticChecksDisabled'])
            self.assertTrue(report['automaticDownloadsDisabled'])
            self.assertFalse(report['savedPreferencesConflict'])
            self.assertFalse(report['preferencesMigrated'])
            self.assertFalse(report['manualUpdatesBlocked'])
            self.assertEqual(report['startupOverrides'], {key: False for key in policy.STARTUP_KEYS})
            self.assertFalse(data.prefs.exists())

    def test_saved_false_values_are_migrated_true_values_conflict_and_reports_never_write(self):
        with fixture() as data:
            for value in (False, True, 'YES', 0, 1, [], {}):
                with self.subTest(value=value):
                    data.prefs.write_bytes(plistlib.dumps({key: value for key in policy.STARTUP_KEYS}))
                    before = data.prefs.read_bytes()
                    report = policy.report_update_policy(data.app, data.home)
                    self.assertEqual(report['preferencesMigrated'], value is False)
                    self.assertEqual(report['savedPreferencesConflict'], value is not False)
                    self.assertEqual(data.prefs.read_bytes(), before)

    def test_official_identity_missing_policy_and_nonboolean_defaults_are_rejected(self):
        with fixture() as data:
            for key, value in (('CFBundleIdentifier', 'com.openai.chat'),
                               ('CodexReadAloudUpdaterPolicyVersion', True),
                               ('CodexReadAloudUpdaterPolicyVersion', 1.0),
                               ('CodexReadAloudLauncherVersion', 2.0),
                               *[(key, value) for key in policy.KEYS for value in (True, 0, 'NO')]):
                with self.subTest(key=key, value=value):
                    changed = dict(data.info)
                    changed[key] = value
                    data.info_path.write_bytes(plistlib.dumps(changed))
                    with self.assertRaises(RuntimeError):
                        policy.report_update_policy(data.app, data.home)
            for key in policy.KEYS:
                changed = dict(data.info)
                del changed[key]
                data.info_path.write_bytes(plistlib.dumps(changed))
                with self.assertRaises(RuntimeError):
                    policy.report_update_policy(data.app, data.home)

    def test_native_policy_arguments_are_required_and_unknown_launcher_does_not_claim_override(self):
        with fixture() as data:
            launcher = data.app / 'Contents/MacOS/ChatGPT'
            for content in (b'NO\0', b'SUEnableAutomaticChecks\0NO\0',
                            b'SUEnableAutomaticChecks\0SUAutomaticallyUpdate\0YES\0'):
                launcher.write_bytes(content)
                with self.assertRaisesRegex(RuntimeError, 'native launcher'):
                    policy.report_update_policy(data.app, data.home)

    def test_invalid_or_symlinked_preference_files_reject_without_change(self):
        with fixture() as data:
            for content in (b'not a plist', plistlib.dumps([])):
                data.prefs.write_bytes(content)
                with self.assertRaises(RuntimeError):
                    policy.report_update_policy(data.app, data.home)
                self.assertEqual(data.prefs.read_bytes(), content)
            data.prefs.unlink()
            outside = data.root / 'outside.plist'
            content = plistlib.dumps({'SUEnableAutomaticChecks': True})
            outside.write_bytes(content)
            data.prefs.symlink_to(outside)
            with self.assertRaises(OSError):
                policy.report_update_policy(data.app, data.home)
            self.assertEqual(outside.read_bytes(), content)

    def test_alternate_home_migration_refuses_before_defaults_commands(self):
        with fixture() as data:
            runner = unittest.mock.Mock()
            with self.assertRaisesRegex(RuntimeError, 'current user|home'):
                policy.migrate_custom_preferences(data.app, home=data.home, runner=runner)
            runner.assert_not_called()

    def test_migration_targets_only_custom_domain_and_validates_effective_values(self):
        with fixture() as data:
            # Every command is intercepted. This never invokes real defaults or
            # accesses the real user's preference file.
            calls = []
            def runner(arguments, **kwargs):
                calls.append(arguments)
                self.assertTrue(kwargs['check'])
                self.assertEqual(kwargs['timeout'], 10)
                return SimpleNamespace(returncode=0, stdout='0\n', stderr='')
            with patch.object(policy, 'report_update_policy', return_value={}):
                result = policy.migrate_custom_preferences(data.app, home=Path.home(), runner=runner)
            self.assertTrue(result['customPreferencesMigrated'])
            self.assertFalse(result['manualUpdatesBlocked'])
            self.assertEqual(calls, [
                ['/usr/bin/defaults', 'write', policy.IDENTITY, key, '-bool', 'false'] for key in policy.STARTUP_KEYS
            ] + [['/usr/bin/defaults', 'read', policy.IDENTITY, key] for key in policy.STARTUP_KEYS])
            self.assertFalse(data.prefs.exists())
            def still_enabled(arguments, **_kwargs):
                return SimpleNamespace(returncode=0, stdout='1\n', stderr='')
            with patch.object(policy, 'report_update_policy', return_value={}):
                with self.assertRaisesRegex(RuntimeError, 'remains enabled'):
                    policy.migrate_custom_preferences(data.app, home=Path.home(), runner=still_enabled)

    def test_failed_or_timed_out_migration_is_bounded_and_retry_preserves_unrelated_keys(self):
        for failing_action in ('write', 'read'):
            with self.subTest(failing_action=failing_action):
                preferences = {key: True for key in policy.STARTUP_KEYS}
                preferences['unrelated'] = 'preserved'
                failed = False
                def runner(arguments, **kwargs):
                    nonlocal failed
                    self.assertEqual(arguments[2], policy.IDENTITY)
                    self.assertEqual(kwargs['timeout'], policy.DEFAULTS_TIMEOUT_SECONDS)
                    action, key = arguments[1], arguments[3]
                    if not failed and action == failing_action and key == policy.STARTUP_KEYS[1]:
                        failed = True
                        raise subprocess.TimeoutExpired(arguments, kwargs['timeout'])
                    if action == 'write':
                        preferences[key] = False
                    return SimpleNamespace(returncode=0, stdout='0\n', stderr='')
                with patch.object(policy, 'report_update_policy', return_value={}):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        policy.migrate_custom_preferences(Path('/unused.app'), home=Path.home(), runner=runner)
                    result = policy.migrate_custom_preferences(Path('/unused.app'), home=Path.home(), runner=runner)
                self.assertTrue(result['customPreferencesMigrated'])
                self.assertEqual(preferences, {**{key: False for key in policy.STARTUP_KEYS},
                                               'unrelated': 'preserved'})


class RuntimeVoicePolicyTests(unittest.TestCase):
    def make_runtime(self, data):
        runtime = data.root / 'runtime'
        (runtime / 'models').mkdir(parents=True)
        bank = runtime / 'models/voices-v1.0.bin'
        with zipfile.ZipFile(bank, 'w') as archive:
            for name in ('af_aoede.npy', 'am_michael.npy', 'bf_emma.npy', 'bm_george.npy',
                         'jf_alpha.npy', '../af_outside.npy', 'af_text.txt'):
                archive.writestr(name, b'fixture voice never deserialized')
        manifest = data.root / 'assets.json'
        manifest.write_text(json.dumps({'assets': [{'path': 'models/voices-v1.0.bin',
            'size': bank.stat().st_size, 'sha256': hashlib.sha256(bank.read_bytes()).hexdigest()}]}))
        return runtime, bank, manifest

    def test_pinned_bank_provides_only_supported_english_names(self):
        with fixture() as data:
            runtime, bank, manifest = self.make_runtime(data)
            self.assertEqual(voices.supported_voice_ids(runtime, manifest),
                             frozenset(('af_aoede', 'am_michael', 'bf_emma', 'bm_george')))
            for content in (bank.read_bytes() + b'x', b'x' * bank.stat().st_size):
                bank.write_bytes(content)
                with self.assertRaisesRegex(RuntimeError, 'pinned assets'):
                    voices.supported_voice_ids(runtime, manifest)

    def test_choice_is_latest_supported_private_value_or_null_without_rewriting(self):
        with fixture() as data:
            runtime, _bank, manifest = self.make_runtime(data)
            supported = voices.supported_voice_ids(runtime, manifest)
            self.assertIsNone(voices.read_saved_voice(runtime, supported))
            settings = runtime / 'settings.json'
            for choice in ('af_aoede', 'bm_george', None):
                settings.write_text(json.dumps({'version': 1, 'selectedVoice': choice}))
                settings.chmod(0o600)
                before = settings.read_bytes()
                self.assertEqual(voices.read_saved_voice(runtime, supported), choice)
                self.assertEqual(settings.read_bytes(), before)
            for value in ({'version': True, 'selectedVoice': 'af_aoede'},
                          {'version': 1, 'selectedVoice': 'af_invented'},
                          {'version': 1, 'selectedVoice': False}, {'version': 1}, []):
                settings.write_text(json.dumps(value))
                with self.assertRaises(RuntimeError):
                    voices.read_saved_voice(runtime, supported)

    def test_settings_permission_symlink_fifo_and_oversize_fail_without_blocking(self):
        with fixture() as data:
            runtime, _bank, manifest = self.make_runtime(data)
            supported = voices.supported_voice_ids(runtime, manifest)
            settings = runtime / 'settings.json'
            settings.write_text(json.dumps({'version': 1, 'selectedVoice': 'af_aoede'}))
            settings.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'private'):
                voices.read_saved_voice(runtime, supported)
            settings.chmod(0o600)
            settings.write_text('x' * 4097)
            with self.assertRaisesRegex(RuntimeError, 'large'):
                voices.read_saved_voice(runtime, supported)
            settings.unlink()
            outside = data.root / 'outside-settings.json'
            outside.write_text('{}')
            outside.chmod(0o600)
            settings.symlink_to(outside)
            with self.assertRaises(OSError):
                voices.read_saved_voice(runtime, supported)
            settings.unlink()
            os.mkfifo(settings, 0o600)
            with self.assertRaisesRegex(RuntimeError, 'regular'):
                voices.read_saved_voice(runtime, supported)


@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('xcrun'), 'Native macOS compiler required')
class NativeLauncherPolicyTests(unittest.TestCase):
    def test_argument_domain_overrides_old_values_and_incoming_flags_are_filtered(self):
        with fixture() as data:
            profile = data.root / 'dedicated-profile'
            main = data.app / 'Contents/MacOS/ChatGPT'
            native = main.with_name('ChatGPT-native')
            probe = data.root / 'probe.m'
            probe.write_text(r'''#import <Foundation/Foundation.h>
                #include <stdlib.h>
                int main(int argc, const char **argv) { @autoreleasepool {
                    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
                    [defaults registerDefaults:@{@"SUEnableAutomaticChecks":@YES,@"SUAutomaticallyUpdate":@YES}];
                    NSMutableArray *args = [NSMutableArray array];
                    for (int i=1;i<argc;i++) [args addObject:[NSString stringWithUTF8String:argv[i]]];
                    const char *profile = getenv("CODEX_ELECTRON_USER_DATA_PATH");
                    NSDictionary *result = @{@"args":args,@"profile":profile?[NSString stringWithUTF8String:profile]:@"",
                        @"argumentDomain":[defaults volatileDomainForName:NSArgumentDomain],
                        @"automaticChecks":@([defaults boolForKey:@"SUEnableAutomaticChecks"]),
                        @"automaticUpdates":@([defaults boolForKey:@"SUAutomaticallyUpdate"])};
                    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
                    fwrite([json bytes],1,[json length],stdout); return 0;
                }}''')
            subprocess.run(['xcrun', 'clang', '-arch', 'arm64', '-Wall', '-Wextra', '-Werror', '-O2',
                            '-DREAD_ALOUD_PROFILE=' + json.dumps(str(profile)),
                            str(ROOT / 'profile-launcher.c'), '-o', str(main)], check=True, capture_output=True, timeout=30)
            subprocess.run(['xcrun', 'clang', '-framework', 'Foundation', str(probe), '-o', str(native)],
                           check=True, capture_output=True, timeout=30)
            incoming = ['--user-data-dir=/wrong', '--user-data-dir', '/also-wrong',
                        '-SUEnableAutomaticChecks', 'YES', '-SUAutomaticallyUpdate=YES',
                        '-SUEnableAutomaticChecks=1', '-SUAutomaticallyUpdate', 'YES', '--fixture-option', 'keep']
            output = subprocess.run([str(main), *incoming], check=True, capture_output=True, text=True, timeout=5)
            result = json.loads(output.stdout)
            self.assertEqual(result['profile'], str(profile))
            self.assertEqual(result['args'], ['--user-data-dir=' + str(profile),
                '-SUEnableAutomaticChecks', 'NO', '-SUAutomaticallyUpdate', 'NO', '--fixture-option', 'keep'])
            self.assertFalse(result['automaticChecks'])
            self.assertFalse(result['automaticUpdates'])
            self.assertEqual(result['argumentDomain']['SUEnableAutomaticChecks'], 'NO')
            self.assertEqual(result['argumentDomain']['SUAutomaticallyUpdate'], 'NO')


if __name__ == '__main__':
    unittest.main()
