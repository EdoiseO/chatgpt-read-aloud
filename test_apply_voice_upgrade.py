"""Host-safe activation tests; only temporary fixture bundles are changed."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import shutil
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import apply_voice_upgrade as upgrade


HEADER_HASH = 'a' * 64
OLD_HEADER_HASH = 'd' * 64
MAIN_HASH = 'b' * 64


def successful_runner(arguments, **kwargs):
    return SimpleNamespace(returncode=0, stdout='', stderr='')


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        apps = root / 'Applications'
        apps.mkdir()
        stage = root / 'build/ChatGPT Read Aloud.app'
        target = apps / 'ChatGPT Read Aloud.app'
        official = apps / 'ChatGPT.app'
        profile = root / 'profile/user-data'
        launcher = root / 'Launch.command'
        for bundle, marker in [(stage, 'new'), (target, 'old'), (official, 'official-unchanged')]:
            bundle.mkdir(parents=True)
            (bundle / 'marker').write_text(marker)
        launcher.write_text('#!/bin/sh\nexit 0\n')
        launcher.chmod(0o755)
        config = upgrade.Config(stage=stage, target=target, official=official, profile=profile,
                                launcher=launcher, report=root / 'activation.json',
                                verification_report=root / 'build-verification.json',
                                lock=root / 'activation.lock', log=root / 'activation.log')
        worker = profile.parent / 'kokoro/worker-sentences-v1.py'
        worker.parent.mkdir(parents=True)
        worker.write_bytes(b'# isolated fixture sentence worker\n')
        worker.chmod(0o600)
        report = {'app': str(stage.resolve()), 'version': 'test-version', 'activation': 'staged',
                  'packedAssetsVerified': 20000, 'signaturesVerified': True,
                  'embeddedAsarIntegrityVerified': True, 'permanentProfilePreserved': True,
                  'voicePickerHooksVerified': True, 'selectionHighlightHooksVerified': True,
                  'runtimeWorkerPath': str(worker), 'runtimeWorkerHash': hashlib.sha256(worker.read_bytes()).hexdigest(),
                  'asarHeaderHash': HEADER_HASH, 'mainModuleHash': MAIN_HASH}
        config.verification_report.write_text(json.dumps(report))
        yield config


def fake_verify(config, bundle, version=None, require_upgrade=False):
    if not bundle.is_dir() or bundle.is_symlink():
        raise RuntimeError('Invalid fixture bundle')
    if version is not None and version != 'test-version':
        raise RuntimeError('Mismatched version')
    return {'CFBundleShortVersionString': 'test-version', 'CodexReadAloudVoicePickerVersion': 1,
            'CodexReadAloudSelectionHighlightVersion': 1,
            'ElectronAsarIntegrity': {'Resources/app.asar': {'hash': {'old': OLD_HEADER_HASH, 'newer': 'e' * 64}.get((bundle / 'marker').read_text(), HEADER_HASH)}},
            '_mainModuleHash': MAIN_HASH}


def no_wait(config, timeout, blockers):
    return None


def helper_record(config, pid=100, role='modifier'):
    relative = ('Contents/Resources/native/bare-modifier-monitor' if role == 'modifier' else
                'Contents/Frameworks/Codex Framework.framework/Versions/154.0.8037.57/Helpers/browser_crashpad_handler')
    executable = str(config.target / relative)
    arguments = (executable + ' --key DoubleCommand --immediate' if role == 'modifier' else
                 executable + ' --database=' + str(config.profile / 'Crashpad') + ' --annotation=prod=ChatGPT_Mac --monitor-self')
    return {'pid': pid, 'parent': 1, 'uid': os.getuid(), 'state': 'S',
            'started': 'Tue Sep 29 18:33:01 2026', 'executable': executable, 'arguments': arguments}


def add_cua_tree(config):
    for bundle in (config.target, config.stage):
        for relative in (upgrade.CUA_NODE, upgrade.CUA_NODE_REPL, upgrade.CUA_ENTRY):
            item = bundle / relative
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_bytes(relative.as_posix().encode())
            item.chmod(0o755 if relative != upgrade.CUA_ENTRY else 0o644)
        (bundle / upgrade.CUA_ROOT / 'bin/internal-link').symlink_to('node')


def add_dock_resources(config):
    for bundle in (config.target, config.stage):
        for relative in upgrade.DOCK_RESOURCES:
            item = bundle / relative
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_bytes(relative.encode())


def cua_record(config, pid=100, parent=50, node=False):
    executable = str(config.target / (upgrade.CUA_NODE if node else upgrade.CUA_NODE_REPL))
    arguments = executable + ' ' + str(config.target / upgrade.CUA_ENTRY) if node else executable
    return {'pid': pid, 'parent': parent, 'uid': os.getuid(), 'state': 'S',
            'started': 'Wed Sep 30 10:50:21 2026', 'executable': executable, 'arguments': arguments}


def cua_runner(records, mappings=None, open_files=None, identity_overrides=None, inspection_error=False):
    mappings = mappings or {pid: record['executable'] for pid, record in records.items()}
    open_files = open_files or {pid: [('txt', path)] for pid, path in mappings.items()}
    reads = {}
    def runner(args, **kwargs):
        if args[0] == '/bin/ps' and '-axo' in args:
            output = '\n'.join(f"{pid} {record['parent']} {record['arguments']}" for pid, record in records.items())
        elif args[0] == '/bin/ps':
            pid = int(args[args.index('-p') + 1])
            record = records[pid]
            if 'args=' not in args:
                reads[pid] = reads.get(pid, 0) + 1
                record = {**record, **(identity_overrides or {}).get((pid, reads[pid]), {})}
                output = f"{pid} {record['parent']} {record['uid']} {record['state']} {record['started']} {record['executable']}\n"
            else:
                output = record['arguments'] + '\n'
        elif args[0] == '/usr/sbin/lsof' and '-p' not in args:
            output = ''.join(f'p{pid}\nn{path}\n' for pid, path in mappings.items())
        elif args[0] == '/usr/sbin/lsof':
            if inspection_error:
                return SimpleNamespace(returncode=1, stdout='', stderr='inspection failed')
            pid = int(args[args.index('-p') + 1])
            output = f"p{pid}\nu{records[pid]['uid']}\n" + ''.join(f'f{descriptor}\nn{path}\n' for descriptor, path in open_files[pid])
        else:
            raise AssertionError('Unexpected fixture command')
        return SimpleNamespace(returncode=0, stdout=output, stderr='')
    return runner


def atomic_record(config):
    backup = config.target.with_name('ChatGPT Read Aloud.backup-20260930T160000Z-123.app.disabled')
    record = {'app': str(config.target), 'stage': str(config.stage), 'profile': str(config.profile),
              'backup': str(backup), 'transaction': 'atomic_exchange_v1', 'status': 'exchanged',
              'previousAppPath': str(config.stage), 'previousAsarHeaderHash': OLD_HEADER_HASH,
              'stagedAsarHeaderHash': HEADER_HASH,
              'unchangedCuaSubtreeManifest': upgrade.unchanged_cua_proof(config)[0],
              'unchangedDockResourceHashes': upgrade.unchanged_dock_hashes(config)}
    upgrade.atomic_report(config, record)
    return record, backup


class ActivationTests(unittest.TestCase):
    def test_successful_activation_preserves_backup_and_official_app(self):
        with fixture() as config:
            launches = []
            record = upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [],
                                           wait=no_wait, launch=lambda cfg: launches.append(cfg.target),
                                           startup=lambda _: 1234, runner=successful_runner)
            self.assertEqual(record['status'], 'activated')
            self.assertTrue(record['startupPassed30Seconds'])
            self.assertEqual((config.target / 'marker').read_text(), 'new')
            self.assertEqual((Path(record['backup']) / 'marker').read_text(), 'old')
            self.assertFalse(config.stage.exists())
            self.assertEqual((config.official / 'marker').read_text(), 'official-unchanged')
            self.assertEqual(launches, [config.target])
            self.assertEqual(config.report.stat().st_mode & 0o777, 0o600)

    def test_running_host_and_cli_are_never_killed_or_replaced(self):
        with fixture() as config:
            def refused_wait(cfg, timeout, blockers):
                self.assertEqual(blockers(cfg), [97712, 97713])
                raise RuntimeError('The custom app is still running')
            with patch('os.kill', side_effect=AssertionError('Must never kill a process')):
                with self.assertRaisesRegex(RuntimeError, 'still running'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [97712, 97713],
                                          wait=refused_wait, runner=successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'wait_expired')

    def test_restart_race_aborts_before_bundle_swap(self):
        with fixture() as config:
            with self.assertRaisesRegex(RuntimeError, 'restarted'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [97712],
                                      wait=no_wait, runner=successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'recheck_failed')

    def test_stage_rename_failure_restores_original_bundle(self):
        with fixture() as config:
            original_rename = Path.rename
            def rename(path, destination):
                if path == config.stage:
                    raise OSError('fixture rename failure')
                return original_rename(path, destination)
            with patch.object(Path, 'rename', rename):
                with self.assertRaisesRegex(RuntimeError, 'previous app was restored'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=no_wait,
                                          launch=lambda _: None, runner=successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'rolled_back')

    def test_failed_startup_rolls_back_after_upgraded_processes_exit(self):
        with fixture() as config:
            launches = []
            def fail_startup(_):
                raise RuntimeError('fixture startup failure')
            with self.assertRaisesRegex(RuntimeError, 'previous app was restored'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=no_wait,
                                      launch=lambda _: launches.append(True), startup=fail_startup,
                                      runner=successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(len(launches), 2)
            self.assertEqual(json.loads(config.report.read_text())['status'], 'rolled_back')

    def test_failed_live_startup_preserves_backup_without_replacing_running_archive(self):
        with fixture() as config:
            waits = []
            def wait(cfg, timeout, blockers):
                waits.append(True)
                if len(waits) > 1:
                    raise RuntimeError('Upgraded fixture app is still running')
            def fail_startup(_):
                raise RuntimeError('fixture startup failure')
            with self.assertRaisesRegex(RuntimeError, 'run --rollback'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=wait,
                                      launch=lambda _: None, startup=fail_startup, runner=successful_runner)
            record = json.loads(config.report.read_text())
            self.assertEqual(record['status'], 'rollback_pending_quit')
            self.assertEqual((config.target / 'marker').read_text(), 'new')
            self.assertEqual((Path(record['backup']) / 'marker').read_text(), 'old')
            self.assertFalse(config.stage.exists())
            # After the user quits, the same script completes the recorded rollback.
            upgrade.rollback_saved(config, verify=fake_verify, wait=no_wait,
                                   blockers=lambda _: [], launch=lambda _: None)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'rolled_back')

    def test_missing_stale_or_unverified_build_report_blocks_arming(self):
        with fixture() as config:
            original = json.loads(config.verification_report.read_text())
            cases = [{**original, 'mainModuleHash': 'outdated'}, {**original, 'asarHeaderHash': 'outdated'},
                     {**original, 'signaturesVerified': False}, {**original, 'activation': 'in-use'},
                     {**original, 'app': str(config.target)}, {**original, 'packedAssetsVerified': 0},
                     {**original, 'selectionHighlightHooksVerified': False},
                     {key: value for key, value in original.items() if key != 'selectionHighlightHooksVerified'}]
            for report in cases:
                config.verification_report.write_text(json.dumps(report))
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    upgrade.preflight(config, fake_verify, successful_runner)
            config.verification_report.unlink()
            with self.assertRaisesRegex(RuntimeError, 'not ready'):
                upgrade.preflight(config, fake_verify, successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')

    def test_process_scan_covers_gui_embedded_cli_maps_runtime_and_descendants(self):
        with fixture() as config:
            own = os.getpid()
            rows = f'''100 1 {config.target}/Contents/MacOS/ChatGPT-native --user-data-dir={config.profile}
101 100 {config.target}/Contents/Resources/codex/codex app-server
102 1 {config.profile.parent}/kokoro/.venv/bin/python {config.profile.parent}/kokoro/kokoro_worker.py
103 1 Codex Helper
104 101 /usr/bin/python3 other-helper.py
105 1 {config.official}/Contents/MacOS/ChatGPT
{own} 100 python activation.py
106 {own} /bin/ps inspection
'''
            mapped = f'p103\nn{config.target}/Contents/Frameworks/Codex Framework.framework/Codex Framework\np105\nn{config.official}/Contents/MacOS/ChatGPT\n'
            def runner(args, **kwargs):
                return SimpleNamespace(returncode=0, stdout=rows if args[0] == '/bin/ps' else mapped, stderr='')
            self.assertEqual(upgrade.process_blockers(config, runner), [100, 101, 102, 103, 104])

    def test_executable_map_inspection_fails_closed_on_permission_error(self):
        with fixture() as config:
            def runner(args, **kwargs):
                return SimpleNamespace(returncode=0 if args[0] == '/bin/ps' else 1,
                                       stdout='', stderr='' if args[0] == '/bin/ps' else 'private diagnostic')
            with self.assertRaisesRegex(RuntimeError, 'Cannot safely inspect'):
                upgrade.process_blockers(config, runner)

    def test_wait_requires_three_quiet_scans_and_resets_on_any_process(self):
        with fixture() as config:
            values = iter([[1], [], [2], [], [], []])
            clock = [0]
            sleeps = []
            def sleep(duration):
                sleeps.append(duration)
                clock[0] += duration
            upgrade.wait_until_stopped(config, 10, blockers=lambda _: next(values),
                                       clock=lambda: clock[0], sleep=sleep)
            self.assertEqual(len(sleeps), 5)

    def test_startup_verifies_native_profile_environment_and_survives_thirty_seconds(self):
        with fixture() as config:
            config.profile.mkdir(parents=True)
            (config.profile / 'SingletonLock').symlink_to('fixture-host-4242')
            command = f'{config.target}/Contents/MacOS/ChatGPT-native --user-data-dir={config.profile}'
            def runner(args, **kwargs):
                output = command
                if 'eww' in args:
                    output += ' CODEX_ELECTRON_USER_DATA_PATH=' + str(config.profile)
                if args[0] == '/usr/sbin/lsof':
                    output = 'n' + str(config.target / 'Contents/MacOS/ChatGPT-native') + '\n'
                return SimpleNamespace(returncode=0, stdout=output, stderr='')
            sleeps = []
            pid = upgrade.validate_startup(config, runner, clock=lambda: 0, sleep=sleeps.append)
            self.assertEqual(pid, 4242)
            self.assertEqual(sleeps, [1] * 30)

    def test_bundle_identity_profile_and_containment_are_guarded_without_signing(self):
        with fixture() as config:
            for app in (config.target, config.stage):
                directory = app / 'Contents/MacOS'
                directory.mkdir(parents=True)
                for name in ('ChatGPT', 'ChatGPT-native'):
                    (directory / name).write_text('fixture')
                    (directory / name).chmod(0o755)
                info = {'CFBundleIdentifier': upgrade.IDENTITY, 'CFBundleExecutable': 'ChatGPT',
                        'CFBundleShortVersionString': 'test-version', 'CodexReadAloudLauncherVersion': 1,
                        'LSEnvironment': {'CODEX_ELECTRON_USER_DATA_PATH': str(config.profile)}}
                (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
            self.assertEqual(upgrade.bundle_info(config, config.target)['CFBundleIdentifier'], upgrade.IDENTITY)
            with self.assertRaisesRegex(RuntimeError, 'voice-picker version'):
                upgrade.verify_bundle(config, config.stage, 'test-version', True)
            executable = config.target / 'Contents/MacOS/ChatGPT-native'
            executable.unlink()
            executable.symlink_to(config.official / 'marker')
            with self.assertRaisesRegex(RuntimeError, 'escapes'):
                upgrade.bundle_info(config, config.target)

    def test_report_voice_choice_requires_matching_private_saved_settings(self):
        with fixture() as config:
            report = json.loads(config.verification_report.read_text())
            report['voiceChoice'] = 'af_aoede'
            config.verification_report.write_text(json.dumps(report))
            with self.assertRaisesRegex(RuntimeError, 'not ready'):
                upgrade.preflight(config, fake_verify, successful_runner)
            settings = config.profile.parent / 'kokoro/settings.json'
            settings.parent.mkdir(parents=True, exist_ok=True)
            settings.write_text(json.dumps({'version': 1, 'selectedVoice': 'af_heart'}))
            settings.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                upgrade.preflight(config, fake_verify, successful_runner)
            settings.write_text(json.dumps({'version': 1, 'selectedVoice': 'af_aoede'}))
            before = settings.read_bytes()
            upgrade.preflight(config, fake_verify, successful_runner)
            self.assertEqual(settings.read_bytes(), before)
            self.assertEqual(settings.stat().st_mode & 0o777, 0o600)
            settings.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'private settings'):
                upgrade.preflight(config, fake_verify, successful_runner)

    def test_old_reports_without_voice_choice_remain_compatible_and_preferences_are_preserved(self):
        with fixture() as config:
            settings = config.profile.parent / 'kokoro/settings.json'
            settings.parent.mkdir(parents=True, exist_ok=True)
            settings.write_text(json.dumps({'version': 1, 'selectedVoice': 'af_aoede'}))
            settings.chmod(0o600)
            before = settings.read_bytes()
            upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=no_wait,
                                  launch=lambda _: None, startup=lambda _: 1234, runner=successful_runner)
            self.assertEqual(settings.read_bytes(), before)

    def test_detached_native_helpers_are_not_signaled_while_gui_or_cli_is_alive(self):
        with fixture() as config:
            helper = helper_record(config)
            for live_executable in ['Contents/MacOS/ChatGPT-native', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']:
                live = {**helper, 'pid': 101, 'executable': str(config.target / live_executable)}
                records = {100: helper, 101: live}
                sent = []
                result = upgrade.cleanup_orphan_helpers(config, blockers=lambda _: [100, 101],
                                                        snapshot=lambda: records, send_signal=lambda *args: sent.append(args))
                self.assertEqual(result, [])
                self.assertEqual(sent, [])

    def test_only_exact_owned_orphan_roles_are_eligible(self):
        with fixture() as config:
            good = helper_record(config)
            self.assertTrue(upgrade.allowed_orphan_helper(config, good))
            self.assertTrue(upgrade.allowed_orphan_helper(config, helper_record(config, role='crashpad')))
            bad = [
                {**good, 'parent': 97712}, {**good, 'uid': os.getuid() + 1}, {**good, 'state': 'Z'},
                {**good, 'executable': good['executable'] + '-lookalike'},
                {**good, 'executable': '/Applications/Other.app/Contents/Resources/native/bare-modifier-monitor'},
                {**good, 'arguments': good['arguments'] + ' --unexpected'},
            ]
            crashpad = helper_record(config, role='crashpad')
            bad.extend([{**crashpad, 'arguments': crashpad['arguments'].replace(str(config.profile), '/other/profile')},
                        {**crashpad, 'arguments': crashpad['arguments'].replace('ChatGPT_Mac', 'ChatGPT_MacEvil')}])
            for record in bad:
                self.assertFalse(upgrade.allowed_orphan_helper(config, record))

    def test_exact_detached_helpers_are_sigtermed_only_after_gui_cli_exit(self):
        with fixture() as config:
            records = {100: helper_record(config), 101: helper_record(config, 101, 'crashpad')}
            sent = []
            def snapshot():
                return {pid: record for pid, record in records.items() if pid not in {item[0] for item in sent}}
            def runner(args, **kwargs):
                pid = int(args[args.index('-p') + 1])
                return SimpleNamespace(returncode=0, stdout='n' + records[pid]['executable'] + '\n', stderr='')
            result = upgrade.cleanup_orphan_helpers(config, blockers=lambda _: list(records), snapshot=snapshot,
                                                    runner=runner, send_signal=lambda pid, sig: sent.append((pid, sig)))
            self.assertEqual(set(result), {100, 101})
            self.assertEqual(sent, [(100, signal.SIGTERM), (101, signal.SIGTERM)])
            self.assertEqual((config.target / 'marker').read_text(), 'old')

    def test_pid_reuse_or_unrelated_mapped_executable_prevents_helper_signal(self):
        with fixture() as config:
            good = helper_record(config)
            snapshots = iter([{100: good}, {100: {**good, 'started': 'a different launch'}}])
            sent = []
            runner = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='n' + good['executable'] + '\n', stderr='')
            result = upgrade.cleanup_orphan_helpers(config, blockers=lambda _: [100], snapshot=lambda: next(snapshots),
                                                    runner=runner, send_signal=lambda *args: sent.append(args))
            self.assertEqual(result, [])
            self.assertEqual(sent, [])
            wrong_map = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='n/Applications/Other.app/native\n', stderr='')
            result = upgrade.cleanup_orphan_helpers(config, blockers=lambda _: [100], snapshot=lambda: {100: good},
                                                    runner=wrong_map, send_signal=lambda *args: sent.append(args))
            self.assertEqual(result, [])
            self.assertEqual(sent, [])

    def test_identity_is_refreshed_after_slow_blocker_scan_and_before_each_signal(self):
        with fixture() as config:
            good = helper_record(config)
            records = {100: good}
            sent = []
            scans = [0]
            def blockers(_):
                scans[0] += 1
                if scans[0] == 2:
                    records[100] = {**good, 'started': 'reused during lsof'}
                return [100]
            runner = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='n' + good['executable'] + '\n', stderr='')
            self.assertEqual(upgrade.cleanup_orphan_helpers(config, blockers=blockers, snapshot=lambda: dict(records),
                                                            runner=runner, send_signal=lambda *args: sent.append(args)), [])
            self.assertEqual(sent, [])
            # A second snapshot after the scan may still become obsolete before
            # signaling. The immediate per-PID check rejects that reuse too.
            snapshots = iter([{100: good}, {100: good}, {100: {**good, 'started': 'reused before signal'}}])
            self.assertEqual(upgrade.cleanup_orphan_helpers(config, blockers=lambda _: [100], snapshot=lambda: next(snapshots),
                                                            runner=runner, send_signal=lambda *args: sent.append(args)), [])
            self.assertEqual(sent, [])

    def test_disappeared_helper_is_not_signaled_from_an_older_snapshot(self):
        with fixture() as config:
            good = helper_record(config)
            scans = iter([[100], []])
            sent = []
            runner = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='n' + good['executable'] + '\n', stderr='')
            self.assertEqual(upgrade.cleanup_orphan_helpers(config, blockers=lambda _: next(scans), snapshot=lambda: {100: good},
                                                            runner=runner, send_signal=lambda *args: sent.append(args)), [])
            self.assertEqual(sent, [])

    def test_helper_cleanup_has_bounded_exit_check_and_never_escalates_to_sigkill(self):
        with fixture() as config:
            good = helper_record(config)
            sent = []
            clock = [0]
            def sleep(duration):
                clock[0] += duration
            runner = lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='n' + good['executable'] + '\n', stderr='')
            with self.assertRaisesRegex(RuntimeError, 'did not exit after SIGTERM'):
                upgrade.cleanup_orphan_helpers(config, blockers=lambda _: [100], snapshot=lambda: {100: good},
                                               runner=runner, send_signal=lambda *args: sent.append(args),
                                               clock=lambda: clock[0], sleep=sleep)
            self.assertEqual(sent, [(100, signal.SIGTERM)])
            self.assertLessEqual(clock[0], 10.25)

    def test_dock_exception_requires_exact_os_process_and_all_resources_unchanged(self):
        with fixture() as config:
            for bundle in (config.target, config.stage):
                for relative in upgrade.DOCK_RESOURCES:
                    item = bundle / relative
                    item.parent.mkdir(parents=True, exist_ok=True)
                    item.write_bytes(relative.encode())
            app_maps = {str(config.target / relative) for relative in upgrade.DOCK_RESOURCES}
            all_maps = app_maps | {upgrade.DOCK_EXECUTABLE}
            self.assertTrue(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE, app_maps, all_maps))
            self.assertFalse(upgrade.safe_dock_mapping(config, '/System/OtherProcess', app_maps, all_maps))
            self.assertFalse(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE,
                                                     app_maps | {str(config.target / 'Contents/Resources/app.asar')}, all_maps))
            rows = f'100 1 {upgrade.DOCK_EXECUTABLE}\n'
            maps = 'p100\n' + ''.join('n' + value + '\n' for value in all_maps)
            def runner(args, **kwargs):
                return SimpleNamespace(returncode=0, stdout=rows if args[0] == '/bin/ps' else maps, stderr='')
            self.assertEqual(upgrade.process_blockers(config, runner), [])
            (config.stage / upgrade.DOCK_RESOURCES[-1]).write_bytes(b'changed icon')
            self.assertEqual(upgrade.process_blockers(config, runner), [100])

    def test_dock_hash_exception_survives_atomic_stage_move_using_transaction_record(self):
        with fixture() as config:
            for bundle in (config.target, config.stage):
                for relative in upgrade.DOCK_RESOURCES:
                    item = bundle / relative
                    item.parent.mkdir(parents=True, exist_ok=True)
                    item.write_bytes(relative.encode())
            expected = upgrade.unchanged_dock_hashes(config)
            atomic_record(config)
            config.stage.rename(config.stage.with_name('moved-stage'))
            self.assertEqual(upgrade.unchanged_dock_hashes(config), expected)
            (config.target / upgrade.DOCK_RESOURCES[0]).write_bytes(b'changed plugin')
            self.assertEqual(upgrade.unchanged_dock_hashes(config), {})

    def test_highlight_version_marker_is_required_in_bundle_and_preflight(self):
        with fixture() as config:
            for marker in (None, 0, 2, '1', True):
                info = {**fake_verify(config, config.stage), 'CodexReadAloudSelectionHighlightVersion': marker}
                with patch.object(upgrade, 'bundle_info', return_value=info):
                    with self.assertRaisesRegex(RuntimeError, 'selection-highlight version marker'):
                        upgrade.verify_bundle(config, config.stage, 'test-version', True, runner=successful_runner)
                def verify(cfg, bundle, version=None, require_upgrade=False):
                    result = fake_verify(cfg, bundle, version, require_upgrade)
                    return {**result, 'CodexReadAloudSelectionHighlightVersion': marker} if require_upgrade else result
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    upgrade.preflight(config, verify, successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')

    def test_sentence_worker_report_requires_exact_path_and_valid_matching_hash(self):
        with fixture() as config:
            original = json.loads(config.verification_report.read_text())
            cases = [
                {**original, 'runtimeWorkerPath': str(config.official / 'worker-sentences-v1.py')},
                {**original, 'runtimeWorkerPath': str(config.profile.parent / 'kokoro/worker-sentences-v2.py')},
                {key: value for key, value in original.items() if key != 'runtimeWorkerPath'},
                {**original, 'runtimeWorkerHash': None}, {**original, 'runtimeWorkerHash': 123},
                {**original, 'runtimeWorkerHash': 'g' * 64}, {**original, 'runtimeWorkerHash': 'a' * 63},
                {key: value for key, value in original.items() if key != 'runtimeWorkerHash'},
            ]
            for report in cases:
                config.verification_report.write_text(json.dumps(report))
                with self.assertRaisesRegex(RuntimeError, 'path or SHA-256 is invalid'):
                    upgrade.preflight(config, fake_verify, successful_runner)
            config.verification_report.write_text(json.dumps({**original, 'runtimeWorkerHash': 'c' * 64}))
            with self.assertRaisesRegex(RuntimeError, 'worker does not match'):
                upgrade.preflight(config, fake_verify, successful_runner)

    def test_sentence_worker_must_exist_be_regular_private_and_not_a_symlink(self):
        for kind in ('missing', 'symlink', 'directory', 'fifo', 'group-readable', 'other-readable'):
            with self.subTest(kind=kind), fixture() as config:
                worker = config.profile.parent / 'kokoro/worker-sentences-v1.py'
                if kind in ('missing', 'symlink', 'directory', 'fifo'):
                    worker.unlink()
                if kind == 'symlink':
                    real = worker.with_name('other-worker.py')
                    real.write_bytes(b'# isolated fixture sentence worker\n')
                    real.chmod(0o600)
                    worker.symlink_to(real)
                if kind == 'directory':
                    worker.mkdir(mode=0o700)
                if kind == 'fifo':
                    os.mkfifo(worker, 0o600)
                if kind == 'group-readable':
                    worker.chmod(0o640)
                if kind == 'other-readable':
                    worker.chmod(0o604)
                with self.assertRaisesRegex(RuntimeError, 'private sentence worker is not ready'):
                    upgrade.preflight(config, fake_verify, successful_runner)
                self.assertEqual((config.target / 'marker').read_text(), 'old')
                self.assertEqual((config.stage / 'marker').read_text(), 'new')

    def test_sentence_worker_bytes_and_permissions_are_preserved_during_valid_preflight(self):
        with fixture() as config:
            worker = config.profile.parent / 'kokoro/worker-sentences-v1.py'
            before = worker.read_bytes(), worker.stat().st_mode & 0o777
            upgrade.preflight(config, fake_verify, successful_runner)
            self.assertEqual((worker.read_bytes(), worker.stat().st_mode & 0o777), before)
            self.assertFalse(config.report.exists(), 'preflight must not write an activation record')
            self.assertEqual((config.official / 'marker').read_text(), 'official-unchanged')

    def test_worker_change_while_waiting_aborts_before_bundle_swap(self):
        with fixture() as config:
            def wait(cfg, timeout, blockers):
                (cfg.profile.parent / 'kokoro/worker-sentences-v1.py').write_bytes(b'# changed after readiness\n')
            with self.assertRaisesRegex(RuntimeError, 'worker does not match'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=wait,
                                      launch=lambda _: self.fail('No app may launch'), runner=successful_runner)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'recheck_failed')

    def test_standalone_identical_cua_helpers_are_permitted_with_one_manifest_per_scan(self):
        with fixture() as config:
            add_cua_tree(config)
            records = {100: cua_record(config, node=True), 101: cua_record(config), 102: cua_record(config, parent=100)}
            with patch.object(upgrade, 'cua_subtree_manifest', wraps=upgrade.cua_subtree_manifest) as manifest:
                self.assertEqual(upgrade.process_blockers(config, cua_runner(records)), [])
                self.assertEqual(manifest.call_count, 2, 'Three candidates must share this scan\'s target/stage hashes')
            (config.stage / upgrade.CUA_ENTRY).write_bytes(b'changed after first scan')
            self.assertEqual(upgrade.process_blockers(config, cua_runner(records)), [100, 101, 102])

    def test_cua_under_live_gui_or_embedded_cli_remains_blocked(self):
        with fixture() as config:
            add_cua_tree(config)
            gui = cua_record(config, 90, parent=1)
            gui.update(executable=str(config.target / 'Contents/MacOS/ChatGPT-native'),
                       arguments=str(config.target / 'Contents/MacOS/ChatGPT-native') + ' --profile private')
            cli = cua_record(config, 91, parent=90)
            cli.update(executable=str(config.target / 'Contents/Resources/codex-cli/bin/codex'),
                       arguments=str(config.target / 'Contents/Resources/codex-cli/bin/codex') + ' app-server')
            records = {90: gui, 91: cli, 100: cua_record(config, parent=91), 101: cua_record(config, parent=100)}
            self.assertEqual(upgrade.process_blockers(config, cua_runner(records)), [90, 91, 100, 101])

    def test_any_cua_tree_change_or_escaping_symlink_blocks_exemption(self):
        for change in ('bytes', 'mode', 'added', 'removed', 'symlink'):
            with self.subTest(change=change), fixture() as config:
                add_cua_tree(config)
                if change == 'bytes':
                    (config.stage / upgrade.CUA_ENTRY).write_bytes(b'new code')
                elif change == 'mode':
                    (config.stage / upgrade.CUA_NODE).chmod(0o644)
                elif change == 'added':
                    (config.stage / upgrade.CUA_ROOT / 'extra').write_bytes(b'extra dependency')
                elif change == 'removed':
                    (config.stage / upgrade.CUA_ENTRY).unlink()
                else:
                    link = config.stage / upgrade.CUA_ROOT / 'bin/internal-link'
                    link.unlink()
                    link.symlink_to(config.official / 'marker')
                records = {100: cua_record(config)}
                self.assertEqual(upgrade.process_blockers(config, cua_runner(records)), [100])

    def test_cua_identity_uid_executable_arguments_parent_and_reuse_fail_closed(self):
        for change in ('uid', 'executable', 'arguments', 'parent', 'reuse'):
            with self.subTest(change=change), fixture() as config:
                add_cua_tree(config)
                record = cua_record(config)
                overrides = {}
                if change == 'uid':
                    record['uid'] += 1
                elif change == 'executable':
                    record['executable'] = '/usr/bin/unrelated'
                elif change == 'arguments':
                    record['arguments'] += ' --unexpected'
                elif change == 'parent':
                    overrides[(100, 1)] = {'parent': 99}
                else:
                    overrides[(100, 2)] = {'started': 'Wed Sep 30 11:00:00 2026'}
                self.assertEqual(upgrade.process_blockers(config, cua_runner({100: record}, identity_overrides=overrides)), [100])

    def test_all_cua_open_bundle_files_must_be_whitelisted_including_non_text_asar(self):
        with fixture() as config:
            add_cua_tree(config)
            record = cua_record(config)
            for extra in ('Contents/Resources/app.asar', 'Contents/Frameworks/Codex Framework.framework/Codex Framework',
                          'Contents/Resources/cua_node/unknown', 'Contents/Info.plist'):
                opened = {100: [('txt', record['executable']), ('7r', str(config.target / extra))]}
                self.assertEqual(upgrade.process_blockers(config, cua_runner({100: record}, open_files=opened)), [100])
            missing_native = {100: [('4r', record['executable'])]}
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: record}, open_files=missing_native)), [100])
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: record}, inspection_error=True)), [100])

    def test_cua_mapping_aliases_follow_only_the_verified_transaction_stage_and_backup(self):
        with fixture() as config:
            add_cua_tree(config)
            record, backup = atomic_record(config)
            process = cua_record(config)
            upgrade.atomic_exchange(config.target, config.stage)
            stage_mapping = str(config.stage / upgrade.CUA_NODE_REPL)
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: process}, mappings={100: stage_mapping})), [])
            config.stage.rename(backup)
            backup_mapping = str(backup / upgrade.CUA_NODE_REPL)
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: process}, mappings={100: backup_mapping})), [])
            unknown = backup.with_name('ChatGPT Read Aloud.backup-20260930T155000Z-999.app.disabled')
            shutil.copytree(backup, unknown, symlinks=True)
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: process}, mappings={100: str(unknown / upgrade.CUA_NODE_REPL)})), [100])
            (backup / upgrade.CUA_ENTRY).write_bytes(b'changed old mapping dependency')
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: process}, mappings={100: backup_mapping})), [100])

    def test_dock_mapping_aliases_allow_only_matching_transaction_backup_resources(self):
        with fixture() as config:
            add_cua_tree(config)
            add_dock_resources(config)
            record, backup = atomic_record(config)
            upgrade.atomic_exchange(config.target, config.stage)
            config.stage.rename(backup)
            maps = {str(backup / item) for item in upgrade.DOCK_RESOURCES}
            all_maps = maps | {upgrade.DOCK_EXECUTABLE}
            self.assertTrue(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE, maps, all_maps))
            unknown = backup.with_name('ChatGPT Read Aloud.backup-20260930T155000Z-999.app.disabled')
            unknown_maps = {str(unknown / item) for item in upgrade.DOCK_RESOURCES}
            self.assertFalse(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE, unknown_maps, unknown_maps | {upgrade.DOCK_EXECUTABLE}))
            (backup / upgrade.DOCK_RESOURCES[0]).write_bytes(b'changed plugin')
            self.assertFalse(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE, maps, all_maps))

    def test_second_upgrade_carries_verified_first_backup_through_exchange_and_rollback(self):
        for rollback in (False, True):
            with self.subTest(rollback=rollback), fixture() as config:
                add_cua_tree(config)
                add_dock_resources(config)
                first, first_backup = atomic_record(config)
                upgrade.atomic_exchange(config.target, config.stage)
                config.stage.rename(first_backup)
                first.update(status='activated', previousAppPath=str(first_backup))
                upgrade.atomic_report(config, first)
                shutil.copytree(config.target, config.stage, symlinks=True)
                (config.stage / 'marker').write_text('newer')
                readiness = json.loads(config.verification_report.read_text())
                readiness['asarHeaderHash'] = 'e' * 64
                config.verification_report.write_text(json.dumps(readiness))
                target_argv = cua_record(config, 100, node=True)
                retained_argv = cua_record(config, 101)
                retained_argv.update(executable=str(first_backup / upgrade.CUA_NODE_REPL),
                                     arguments=str(first_backup / upgrade.CUA_NODE_REPL))
                records = {100: target_argv, 101: retained_argv}
                mappings = {100: str(first_backup / upgrade.CUA_NODE), 101: retained_argv['executable']}
                runner = cua_runner(records, mappings=mappings)
                dock_maps = {str(first_backup / item) for item in upgrade.DOCK_RESOURCES}
                phases = []
                def blockers(cfg):
                    journal = upgrade.transaction_record(cfg)
                    phases.append(journal['status'])
                    self.assertIn(str(first_backup), journal.get('retainedResourceBackupAliases', []))
                    self.assertTrue(upgrade.safe_dock_mapping(cfg, upgrade.DOCK_EXECUTABLE,
                                                             dock_maps, dock_maps | {upgrade.DOCK_EXECUTABLE}))
                    return upgrade.process_blockers(cfg, runner)
                def wait(cfg, timeout, blockers):
                    self.assertEqual(blockers(cfg), [])
                def launch(cfg):
                    self.assertEqual(blockers(cfg), [])
                def startup(cfg):
                    if rollback:
                        raise RuntimeError('fixture second startup failure')
                    return 1234
                if rollback:
                    with self.assertRaisesRegex(RuntimeError, 'previous app was restored'):
                        upgrade.apply_upgrade(config, verify=fake_verify, blockers=blockers, wait=wait,
                                              launch=launch, startup=startup, runner=successful_runner)
                else:
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=blockers, wait=wait,
                                          launch=launch, startup=startup, runner=successful_runner)
                journal = upgrade.transaction_record(config)
                self.assertEqual(journal['retainedResourceBackupAliases'], [str(first_backup)])
                self.assertEqual(journal['status'], 'rolled_back' if rollback else 'activated')
                self.assertEqual((first_backup / 'marker').read_text(), 'old')
                self.assertTrue({'waiting_for_quit', 'exchanged', 'verifying_startup'} <= set(phases))
                if rollback:
                    self.assertIn('rollback_waiting_for_quit', phases)
                    self.assertIn('rolled_back', phases)
                self.assertEqual(upgrade.process_blockers(config, runner), [])

    def test_retained_alias_requires_both_unchanged_resource_proofs_and_fresh_scans(self):
        for change in ('cua', 'dock', 'unknown', 'symlink'):
            with self.subTest(change=change), fixture() as config:
                add_cua_tree(config)
                add_dock_resources(config)
                record, previous = atomic_record(config)
                shutil.copytree(config.target, previous, symlinks=True)
                record['retainedResourceBackupAliases'] = [str(previous)]
                record['backup'] = str(previous.with_name('ChatGPT Read Aloud.backup-20260930T170000Z-456.app.disabled'))
                upgrade.atomic_report(config, record)
                process = cua_record(config)
                mapped = str(previous / upgrade.CUA_NODE_REPL)
                runner = cua_runner({100: process}, mappings={100: mapped})
                dock_maps = {str(previous / item) for item in upgrade.DOCK_RESOURCES}
                with patch.object(upgrade, 'cua_subtree_manifest', wraps=upgrade.cua_subtree_manifest) as manifest:
                    self.assertEqual(upgrade.process_blockers(config, runner), [])
                    self.assertEqual(manifest.call_count, 3, 'Retained aliases must be hashed once per scan')
                self.assertTrue(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE,
                                                         dock_maps, dock_maps | {upgrade.DOCK_EXECUTABLE}))
                if change == 'cua':
                    (previous / upgrade.CUA_ENTRY).write_bytes(b'changed earlier helper dependency')
                elif change == 'dock':
                    (previous / upgrade.DOCK_RESOURCES[0]).write_bytes(b'changed earlier plugin')
                elif change == 'unknown':
                    record['retainedResourceBackupAliases'] = []
                    upgrade.atomic_report(config, record)
                else:
                    actual = previous.with_name('old-resource-tree')
                    previous.rename(actual)
                    previous.symlink_to(actual, target_is_directory=True)
                self.assertEqual(upgrade.process_blockers(config, runner), [100])
                self.assertFalse(upgrade.safe_dock_mapping(config, upgrade.DOCK_EXECUTABLE,
                                                          dock_maps, dock_maps | {upgrade.DOCK_EXECUTABLE}))

    def test_retained_alias_does_not_weaken_all_fd_or_gui_ancestry_guards(self):
        with fixture() as config:
            add_cua_tree(config)
            add_dock_resources(config)
            record, previous = atomic_record(config)
            shutil.copytree(config.target, previous, symlinks=True)
            record.update(retainedResourceBackupAliases=[str(previous)],
                          backup=str(previous.with_name('ChatGPT Read Aloud.backup-20260930T170000Z-456.app.disabled')))
            upgrade.atomic_report(config, record)
            process = cua_record(config)
            mapped = str(previous / upgrade.CUA_NODE_REPL)
            opened = {100: [('txt', mapped), ('7r', str(previous / 'Contents/Resources/app.asar'))]}
            self.assertEqual(upgrade.process_blockers(config, cua_runner({100: process}, mappings={100: mapped},
                                                                         open_files=opened)), [100])
            gui = {**process, 'pid': 90, 'parent': 1,
                   'arguments': str(config.target / 'Contents/MacOS/ChatGPT-native'),
                   'executable': str(config.target / 'Contents/MacOS/ChatGPT-native')}
            process['parent'] = 90
            self.assertEqual(upgrade.process_blockers(config, cua_runner({90: gui, 100: process},
                                                                         mappings={90: gui['executable'], 100: mapped})), [90, 100])

    def test_retained_alias_record_is_bounded_private_and_exact(self):
        with fixture() as config:
            add_cua_tree(config)
            add_dock_resources(config)
            record, previous = atomic_record(config)
            shutil.copytree(config.target, previous, symlinks=True)
            record.update(retainedResourceBackupAliases=[str(previous)],
                          backup=str(previous.with_name('ChatGPT Read Aloud.backup-20260930T170000Z-456.app.disabled')))
            process = cua_record(config)
            runner = cua_runner({100: process}, mappings={100: str(previous / upgrade.CUA_NODE_REPL)})
            for values in (str(previous), [str(config.target)], [str(previous)] * (upgrade.MAX_RETAINED_RESOURCE_ALIASES + 1),
                           [str(previous), str(config.official)], [None]):
                upgrade.atomic_report(config, {**record, 'retainedResourceBackupAliases': values})
                self.assertEqual(upgrade.transaction_record(config), {})
                self.assertEqual(upgrade.process_blockers(config, runner), [100])
            upgrade.atomic_report(config, record)
            self.assertEqual(upgrade.process_blockers(config, runner), [])
            config.report.chmod(0o644)
            self.assertEqual(upgrade.process_blockers(config, runner), [100])

    def test_new_journal_carries_existing_retained_aliases_only_while_both_proofs_match(self):
        for change in (None, 'cua', 'dock', 'missing'):
            with self.subTest(change=change), fixture() as config:
                add_cua_tree(config)
                add_dock_resources(config)
                record, prior_backup = atomic_record(config)
                older_backup = prior_backup.with_name('ChatGPT Read Aloud.backup-20260930T150000Z-111.app.disabled')
                for backup in (prior_backup, older_backup):
                    shutil.copytree(config.target, backup, symlinks=True)
                record['retainedResourceBackupAliases'] = [str(older_backup)]
                upgrade.atomic_report(config, record)
                if change == 'cua':
                    (older_backup / upgrade.CUA_ENTRY).write_bytes(b'changed retained code')
                elif change == 'dock':
                    (older_backup / upgrade.DOCK_RESOURCES[-1]).write_bytes(b'changed retained icon')
                elif change == 'missing':
                    shutil.rmtree(older_backup)
                expected = [str(older_backup), str(prior_backup)] if change is None else [str(prior_backup)]
                def wait(cfg, timeout, blockers):
                    self.assertEqual(upgrade.transaction_record(cfg)['retainedResourceBackupAliases'], expected)
                    raise RuntimeError('fixture quit wait stopped')
                with self.assertRaisesRegex(RuntimeError, 'fixture quit wait stopped'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [],
                                          wait=wait, runner=successful_runner)
                self.assertEqual(upgrade.transaction_record(config)['retainedResourceBackupAliases'], expected)
                self.assertEqual(upgrade.transaction_record(config)['status'], 'wait_expired')
                self.assertEqual((config.target / 'marker').read_text(), 'old')

    def test_dock_and_multiple_cua_candidates_share_only_this_scans_retained_manifest(self):
        with fixture() as config:
            add_cua_tree(config)
            add_dock_resources(config)
            record, previous = atomic_record(config)
            shutil.copytree(config.target, previous, symlinks=True)
            record.update(retainedResourceBackupAliases=[str(previous)],
                          backup=str(previous.with_name('ChatGPT Read Aloud.backup-20260930T170000Z-456.app.disabled')))
            upgrade.atomic_report(config, record)
            records = {100: cua_record(config, node=True), 101: cua_record(config)}
            records[200] = {**records[100], 'pid': 200, 'parent': 1,
                            'executable': upgrade.DOCK_EXECUTABLE, 'arguments': upgrade.DOCK_EXECUTABLE}
            mappings = {100: str(previous / upgrade.CUA_NODE), 101: str(previous / upgrade.CUA_NODE_REPL),
                        200: upgrade.DOCK_EXECUTABLE}
            base_runner = cua_runner(records, mappings=mappings)
            def runner(args, **kwargs):
                result = base_runner(args, **kwargs)
                if args[0] == '/usr/sbin/lsof' and '-p' not in args:
                    result.stdout += 'p200\n' + ''.join('n' + str(previous / item) + '\n' for item in upgrade.DOCK_RESOURCES)
                return result
            with patch.object(upgrade, 'cua_subtree_manifest', wraps=upgrade.cua_subtree_manifest) as manifest:
                self.assertEqual(upgrade.process_blockers(config, runner), [])
                self.assertEqual(manifest.call_count, 3)
                self.assertEqual(upgrade.process_blockers(config, runner), [])
                self.assertEqual(manifest.call_count, 6, 'No resource hash may survive into the next scan')

    @unittest.skipUnless(sys.platform == 'darwin', 'Native Darwin atomic exchange test')
    def test_native_darwin_exchange_keeps_both_paths_available_and_preserves_open_files(self):
        with tempfile.TemporaryDirectory() as folder:
            left, right = Path(folder) / 'target', Path(folder) / 'stage'
            left.mkdir()
            right.mkdir()
            (left / 'marker').write_text('old')
            (right / 'marker').write_text('new')
            errors, finished = [], threading.Event()
            def read_paths():
                while not finished.is_set():
                    try:
                        (left / 'marker').read_bytes()
                        (right / 'marker').read_bytes()
                    except OSError as error:
                        errors.append(error)
            reader = threading.Thread(target=read_paths)
            with (left / 'marker').open() as old_open:
                reader.start()
                try:
                    for _ in range(100):
                        upgrade.atomic_exchange(left, right)
                    upgrade.atomic_exchange(left, right)
                    self.assertEqual((left / 'marker').read_text(), 'new')
                    self.assertEqual(old_open.read(), 'old')
                    upgrade.atomic_exchange(left, right)
                finally:
                    finished.set()
                    reader.join(timeout=5)
            self.assertFalse(reader.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual((left / 'marker').read_text(), 'old')
            with self.assertRaises(RuntimeError):
                upgrade.atomic_exchange(left, Path(folder) / 'absent')
            self.assertEqual((left / 'marker').read_text(), 'old')

    def test_atomic_exchange_failure_has_no_non_atomic_fallback_or_bundle_move(self):
        with fixture() as config:
            def exchange(left, right):
                if left == config.target:
                    raise OSError('unsupported volume swap')
                upgrade.atomic_exchange(left, right)
            with self.assertRaisesRegex(RuntimeError, 'previous app was restored'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=no_wait,
                                      runner=successful_runner, exchange=exchange, launch=lambda _: self.fail('No launch'))
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'exchange_failed')

    def test_swap_capability_failure_does_not_arm_or_touch_apps(self):
        with fixture() as config:
            def unavailable(left, right):
                self.assertNotEqual(left, config.target)
                raise RuntimeError('Native swap unavailable')
            with self.assertRaisesRegex(RuntimeError, 'Native swap unavailable'):
                upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], runner=successful_runner,
                                      exchange=unavailable)
            self.assertFalse(config.report.exists())
            self.assertEqual((config.target / 'marker').read_text(), 'old')

    def test_backup_rename_failure_with_restarted_gui_records_stage_old_and_resumes_safely(self):
        with fixture() as config:
            original_rename = Path.rename
            def rename(path, destination):
                if path == config.stage:
                    raise OSError('backup rename failed')
                return original_rename(path, destination)
            waits = []
            def wait(cfg, timeout, blockers):
                waits.append(True)
                if len(waits) > 1:
                    raise RuntimeError('GUI restarted')
            with patch.object(Path, 'rename', rename):
                with self.assertRaisesRegex(RuntimeError, 'run --rollback'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=wait,
                                          runner=successful_runner, launch=lambda _: self.fail('No live GUI launch'))
            record = json.loads(config.report.read_text())
            self.assertEqual(record['status'], 'rollback_pending_quit')
            self.assertEqual(record['previousAppPath'], str(config.stage))
            self.assertEqual((config.target / 'marker').read_text(), 'new')
            self.assertEqual((config.stage / 'marker').read_text(), 'old')
            self.assertFalse(Path(record['backup']).exists())
            upgrade.rollback_saved(config, verify=fake_verify, wait=no_wait, blockers=lambda _: [], launch=lambda _: None)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')

    def test_post_swap_restart_blocks_launch_and_recovery_waits_without_killing(self):
        with fixture() as config:
            calls = [0]
            waits = []
            def blockers(_):
                calls[0] += 1
                return [] if calls[0] == 1 else [100]
            def wait(cfg, timeout, blockers):
                waits.append(True)
                if len(waits) > 1:
                    raise RuntimeError('still running')
            with patch('os.kill', side_effect=AssertionError('No app process may be killed')):
                with self.assertRaisesRegex(RuntimeError, 'run --rollback'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=blockers, wait=wait,
                                          runner=successful_runner, launch=lambda _: self.fail('No launch'))
            record = json.loads(config.report.read_text())
            self.assertEqual(record['status'], 'rollback_pending_quit')
            self.assertEqual(record['previousAppPath'], str(config.stage))
            self.assertEqual((config.target / 'marker').read_text(), 'new')
            self.assertEqual((config.stage / 'marker').read_text(), 'old')

    def test_failed_upgrade_preservation_after_reverse_swap_leaves_safe_old_target_and_is_retryable(self):
        with fixture() as config:
            original_rename = Path.rename
            def rename(path, destination):
                if path.name.startswith('ChatGPT Read Aloud.backup-') and destination == config.stage:
                    raise OSError('preservation rename failed')
                return original_rename(path, destination)
            def startup(_):
                raise RuntimeError('bad startup')
            with patch.object(Path, 'rename', rename):
                with self.assertRaisesRegex(RuntimeError, 'previous app was restored'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=no_wait,
                                          runner=successful_runner, launch=lambda _: None, startup=startup)
            record = json.loads(config.report.read_text())
            self.assertEqual(record['status'], 'rolled_back_recovery_pending')
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((Path(record['failedUpgradePath']) / 'marker').read_text(), 'new')
            self.assertFalse(config.stage.exists())
            swaps = []
            def exchange(left, right):
                swaps.append(left)
                upgrade.atomic_exchange(left, right)
            upgrade.rollback_saved(config, verify=fake_verify, wait=no_wait, blockers=lambda _: [], launch=lambda _: None, exchange=exchange)
            self.assertNotIn(config.target, swaps, 'The restored target must not be exchanged again')
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')

    def test_startup_rejects_old_native_mapping_even_when_argv_profile_environment_match(self):
        with fixture() as config:
            config.profile.mkdir(parents=True)
            (config.profile / 'SingletonLock').symlink_to('fixture-host-4242')
            command = f'{config.target}/Contents/MacOS/ChatGPT-native --user-data-dir={config.profile}'
            def runner(args, **kwargs):
                output = command
                if 'eww' in args:
                    output += ' CODEX_ELECTRON_USER_DATA_PATH=' + str(config.profile)
                if args[0] == '/usr/sbin/lsof':
                    output = 'n' + str(config.stage / 'Contents/MacOS/ChatGPT-native') + '\n'
                return SimpleNamespace(returncode=0, stdout=output, stderr='')
            with self.assertRaisesRegex(RuntimeError, 'not running the upgraded native executable'):
                upgrade.validate_startup(config, runner, clock=lambda: 0, sleep=lambda _: None)

    def test_interrupted_rollback_quit_wait_resumes_with_old_bundle_at_stage_or_backup(self):
        for location in ('stage', 'backup'):
            with self.subTest(location=location), fixture() as config:
                record, backup = atomic_record(config)
                upgrade.atomic_exchange(config.target, config.stage)
                previous = config.stage
                if location == 'backup':
                    config.stage.rename(backup)
                    previous = backup
                def interrupted(*args, **kwargs):
                    raise KeyboardInterrupt('waiter interrupted')
                with self.assertRaises(KeyboardInterrupt):
                    upgrade.restore_previous(config, record, previous, 10, fake_verify, interrupted,
                                             lambda _: [], lambda _: None, upgrade.atomic_exchange)
                self.assertEqual(json.loads(config.report.read_text())['status'], 'rollback_waiting_for_quit')
                self.assertEqual((config.target / 'marker').read_text(), 'new')
                upgrade.rollback_saved(config, verify=fake_verify, wait=no_wait, blockers=lambda _: [], launch=lambda _: None)
                self.assertEqual((config.target / 'marker').read_text(), 'old')
                self.assertEqual((config.stage / 'marker').read_text(), 'new')

    def test_interruption_after_reverse_exchange_preserves_old_target_and_resumes_recovery(self):
        with fixture() as config:
            record, backup = atomic_record(config)
            upgrade.atomic_exchange(config.target, config.stage)
            config.stage.rename(backup)
            report = upgrade.atomic_report
            def interrupted_report(cfg, value):
                report(cfg, value)
                if value['status'] == 'rolled_back_recovery_pending':
                    raise KeyboardInterrupt('interrupted after reverse exchange')
            with patch.object(upgrade, 'atomic_report', side_effect=interrupted_report):
                with self.assertRaises(KeyboardInterrupt):
                    upgrade.restore_previous(config, record, backup, 10, fake_verify, no_wait,
                                             lambda _: [], lambda _: None, upgrade.atomic_exchange)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((backup / 'marker').read_text(), 'new')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'rolled_back_recovery_pending')
            upgrade.rollback_saved(config, verify=fake_verify, wait=no_wait, blockers=lambda _: [], launch=lambda _: None)
            self.assertEqual((config.target / 'marker').read_text(), 'old')
            self.assertEqual((config.stage / 'marker').read_text(), 'new')

    def test_changed_valid_previous_app_is_not_restored_or_exchanged(self):
        with fixture() as config:
            record, backup = atomic_record(config)
            upgrade.atomic_exchange(config.target, config.stage)
            (config.stage / 'marker').write_text('newer')
            exchanges = []
            def exchange(left, right):
                exchanges.append((left, right))
                self.fail('A changed valid previous bundle must never be restored')
            with self.assertRaisesRegex(RuntimeError, 'run --rollback'):
                upgrade.restore_previous(config, record, config.stage, 10, fake_verify, no_wait,
                                         lambda _: [], lambda _: self.fail('No launch'), exchange)
            self.assertEqual(exchanges, [])
            self.assertEqual((config.target / 'marker').read_text(), 'new')
            self.assertEqual((config.stage / 'marker').read_text(), 'newer')
            self.assertEqual(json.loads(config.report.read_text())['status'], 'rollback_pending_quit')

    def test_valid_bundle_changes_while_waiting_abort_before_exchange_even_with_updated_ready_report(self):
        for changed in ('installed', 'staged'):
            with self.subTest(changed=changed), fixture() as config:
                def wait(cfg, timeout, blockers):
                    bundle = cfg.target if changed == 'installed' else cfg.stage
                    (bundle / 'marker').write_text('newer')
                    if changed == 'staged':
                        ready = json.loads(cfg.verification_report.read_text())
                        ready['asarHeaderHash'] = 'e' * 64
                        cfg.verification_report.write_text(json.dumps(ready))
                swaps = []
                def exchange(left, right):
                    if left == config.target:
                        swaps.append((left, right))
                        self.fail('Changed bundles must fail before exchange')
                    upgrade.atomic_exchange(left, right)
                with self.assertRaisesRegex(RuntimeError, 'changed while waiting'):
                    upgrade.apply_upgrade(config, verify=fake_verify, blockers=lambda _: [], wait=wait,
                                          runner=successful_runner, exchange=exchange,
                                          launch=lambda _: self.fail('No launch'))
                self.assertEqual(swaps, [])
                self.assertEqual(json.loads(config.report.read_text())['status'], 'recheck_failed')
                self.assertEqual((config.target / 'marker').read_text(), 'newer' if changed == 'installed' else 'old')
                self.assertEqual((config.stage / 'marker').read_text(), 'newer' if changed == 'staged' else 'new')


if __name__ == '__main__':
    unittest.main()
