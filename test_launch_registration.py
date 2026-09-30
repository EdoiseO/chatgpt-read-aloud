"""LaunchServices repair tests use signed-bundle fixtures and a fake registry."""
from contextlib import contextmanager
import os
from pathlib import Path
import plistlib
from types import SimpleNamespace
import tempfile
import unittest

import launch_registration as registration


def create_bundle(path, profile, identity=registration.IDENTITY):
    (path / 'Contents/MacOS').mkdir(parents=True)
    (path / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': identity, 'CFBundleExecutable': 'ChatGPT',
        'LSEnvironment': {'CODEX_ELECTRON_USER_DATA_PATH': str(profile)}}))
    for name in ('ChatGPT', 'ChatGPT-native'):
        item = path / 'Contents/MacOS' / name
        item.write_bytes(b'# fixture executable; never executed\n')
        item.chmod(0o755)


def dump_record(path, *, disabled=False, identity=registration.IDENTITY, inode=None):
    return (f'bundle id: ChatGPT (0xf00)\npath: {path} (0xabc)\nidentifier: {identity}\n'
            f'bundle flags: has-display-name {"launch-disabled" if disabled else ""} wildcard (00000002)\n'
            f'inode: {path.stat().st_ino if inode is None else inode}\n'
            f'exec inode: {(path / "Contents/MacOS/ChatGPT").stat().st_ino}\n')


class Registry:
    def __init__(self, paths=()):
        self.paths = {path: False for path in paths}
        self.calls = []
        self.keep_disabled = False
        self.ignore_unregister = False
        self.fail = None
        self.final_inode = None
        self.record_overrides = {}

    def __call__(self, args, **kwargs):
        self.calls.append(list(args))
        if self.fail and self.fail(args):
            return SimpleNamespace(returncode=1, stdout='', stderr='isolated fixture failure')
        output = ''
        if args[0] == registration.REGISTER:
            if args[1] == '-dump':
                output = ''.join(self.record_overrides[path] if path in self.record_overrides else
                                 dump_record(path, disabled=disabled,
                                             inode=self.final_inode if path.name == registration.APP_NAME else None)
                                 for path, disabled in self.paths.items())
            elif args[1] == '-u':
                path = Path(args[2])
                if self.keep_disabled:
                    self.paths[path] = True
                elif not self.ignore_unregister:
                    self.paths.pop(path, None)
            elif args[1] == '-f':
                self.paths[Path(args[2])] = False
            else:
                raise AssertionError('No global LaunchServices operations are allowed')
        elif args[:4] != ['/usr/bin/codesign', '--verify', '--deep', '--strict']:
            raise AssertionError('Unexpected fixture command')
        return SimpleNamespace(returncode=0, stdout=output, stderr='')


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        apps = root / 'Applications'
        apps.mkdir()
        target = apps / registration.APP_NAME
        profile = root / 'profile/user-data'
        backups = [apps / name for name in (
            'ChatGPT Read Aloud.backup-20260930T161059Z-38522.app.disabled',
            'ChatGPT Read Aloud.backup-20260930T015504-15981.app.disabled',
            'ChatGPT Read Aloud.kokoro-before-update-26.928.20755-20260930T140511.app.disabled')]
        for path in [target, *backups]:
            create_bundle(path, profile)
        yield SimpleNamespace(root=root, target=target, profile=profile, backups=backups)


class RegistrationTests(unittest.TestCase):
    def test_reconciles_all_verified_historical_backups_and_preserves_files(self):
        with fixture() as data:
            registry = Registry([data.target, *data.backups])
            before = {path: (path.stat().st_ino, (path / 'Contents/Info.plist').read_bytes())
                      for path in [data.target, *data.backups]}
            result = registration.reconcile(data.target, data.profile, runner=registry)
            self.assertTrue(result['currentAppRegistered'])
            self.assertEqual(set(result['retiredAppsUnregistered']), set(map(str, data.backups)))
            mutations = [args for args in registry.calls if args[0] == registration.REGISTER and args[1] != '-dump']
            self.assertEqual(mutations, [[registration.REGISTER, '-u', str(path)] for path in sorted(data.backups)]
                             + [[registration.REGISTER, '-f', str(data.target)]])
            for path, identity in before.items():
                self.assertEqual((path.stat().st_ino, (path / 'Contents/Info.plist').read_bytes()), identity)
            registry.calls.clear()
            registration.reconcile(data.target, data.profile, runner=registry)
            self.assertFalse(any('-u' in args for args in registry.calls))

    def test_accepts_retained_launch_disabled_records_after_unregister(self):
        with fixture() as data:
            registry = Registry([data.target, *data.backups])
            registry.keep_disabled = True
            registration.reconcile(data.target, data.profile, runner=registry)
            self.assertTrue(all(registry.paths[path] for path in data.backups))

    def test_already_disabled_historical_copies_do_not_need_file_validation(self):
        for damage in ('profile', 'signature', 'missing'):
            with self.subTest(damage=damage), fixture() as data:
                backup = data.backups[0]
                registry = Registry([data.target, backup])
                registry.paths[backup] = True
                if damage == 'profile':
                    info_path = backup / 'Contents/Info.plist'
                    info = plistlib.loads(info_path.read_bytes())
                    info['LSEnvironment']['CODEX_ELECTRON_USER_DATA_PATH'] = '/historical/profile'
                    info_path.write_bytes(plistlib.dumps(info))
                elif damage == 'signature':
                    registry.fail = lambda args: args[0] == '/usr/bin/codesign' and args[-1] == str(backup)
                else:
                    registry.record_overrides[backup] = dump_record(backup, disabled=True)
                    backup.rename(backup.with_name('preserved-unregistered-copy'))
                result = registration.reconcile(data.target, data.profile, runner=registry)
                self.assertTrue(result['currentAppRegistered'])
                self.assertEqual(result['retiredAppsUnregistered'], [])
                self.assertFalse(any(args[-1] == str(backup) for args in registry.calls))
                self.assertTrue(registry.paths[backup])

    def test_disabled_records_with_missing_or_malformed_flags_fail_before_mutation(self):
        for flags in (None, '', 'unknown', 'launch-disabled', 'launch-disabled, (00000082)'):
            with self.subTest(flags=flags), fixture() as data:
                backup = data.backups[0]
                registry = Registry([data.target, backup])
                registry.paths[backup] = True
                record = dump_record(backup, disabled=True)
                lines = [line for line in record.splitlines() if not line.startswith('bundle flags:')]
                if flags is not None:
                    lines.append('bundle flags: ' + flags)
                registry.record_overrides[backup] = '\n'.join(lines) + '\n'
                with self.assertRaisesRegex(RuntimeError, 'flags are (missing|unreadable)'):
                    registration.reconcile(data.target, data.profile, runner=registry)
                self.assertFalse(any(args[0] == registration.REGISTER and args[1] in ('-u', '-f')
                                     for args in registry.calls))

    def test_registered_recovery_stage_is_removed_only_when_explicit(self):
        with fixture() as data:
            stage = data.root / 'build' / registration.APP_NAME
            create_bundle(stage, data.profile)
            registry = Registry([data.target, stage])
            with self.assertRaisesRegex(RuntimeError, 'retired copy'):
                registration.reconcile(data.target, data.profile, runner=registry)
            self.assertFalse(any('-u' in args for args in registry.calls))
            registration.reconcile(data.target, data.profile, retired=(stage,), runner=registry)
            self.assertEqual(registry.paths, {data.target: False})
            self.assertTrue(stage.is_dir())

    def test_wrong_identity_profile_symlink_or_signature_cannot_be_unregistered(self):
        for damage in ('identity', 'profile', 'symlink', 'signature'):
            with self.subTest(damage=damage), fixture() as data:
                backup = data.backups[0]
                registry = Registry([data.target, backup])
                info_path = backup / 'Contents/Info.plist'
                if damage in ('identity', 'profile'):
                    info = plistlib.loads(info_path.read_bytes())
                    if damage == 'identity':
                        info['CFBundleIdentifier'] = 'unrelated.application'
                    else:
                        info['LSEnvironment']['CODEX_ELECTRON_USER_DATA_PATH'] = '/unrelated/profile'
                    info_path.write_bytes(plistlib.dumps(info))
                elif damage == 'symlink':
                    moved = backup.with_name('unrelated')
                    backup.rename(moved)
                    backup.symlink_to(moved, target_is_directory=True)
                else:
                    registry.fail = lambda args: args[0] == '/usr/bin/codesign' and args[-1] == str(backup)
                with self.assertRaises(RuntimeError):
                    registration.reconcile(data.target, data.profile, runner=registry)
                self.assertFalse(any(args[0] == registration.REGISTER and args[1] in ('-u', '-f')
                                     for args in registry.calls))

    def test_command_and_verification_failures_are_not_success(self):
        for failure in ('unregister', 'register', 'dump', 'ignored-unregister', 'inode'):
            with self.subTest(failure=failure), fixture() as data:
                registry = Registry([data.target, data.backups[0]])
                if failure in ('unregister', 'register', 'dump'):
                    flag = {'unregister': '-u', 'register': '-f', 'dump': '-dump'}[failure]
                    registry.fail = lambda args: args[:2] == [registration.REGISTER, flag]
                elif failure == 'ignored-unregister':
                    registry.ignore_unregister = True
                else:
                    registry.final_inode = 1
                with self.assertRaises(RuntimeError):
                    registration.reconcile(data.target, data.profile, runner=registry)
                self.assertTrue(data.target.is_dir())
                self.assertTrue(data.backups[0].is_dir())

    def test_parser_ignores_temporary_ids_and_separates_other_record_types(self):
        with fixture() as data:
            output = (dump_record(data.target)
                      + 'type id: example (0x3)\nidentifier: unrelated\nflags: inactive\n'
                      + 'container id: example\npath: /unrelated/path\n'
                      + dump_record(data.backups[0], disabled=True))
            records = registration.registered_records(output)
            self.assertEqual([record['path'] for record in records], [data.target, data.backups[0]])
            identities = registration.verified_bundle(data.target, data.profile, Registry())
            registration.verify_registration(output, data.target, identities)
            with self.assertRaisesRegex(RuntimeError, 'flags are missing'):
                registration.verify_registration(output.replace('bundle flags:', 'unknown flags:'), data.target, identities)


if __name__ == '__main__':
    unittest.main()
