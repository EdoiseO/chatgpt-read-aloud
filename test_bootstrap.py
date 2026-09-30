"""Fresh-machine bootstrap checks use toy assets, commands, and app bundles only."""
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import install_fresh as install
import setup_runtime as setup


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder).resolve()
        home = root / 'home'
        home.mkdir(mode=0o700)
        cache = root / 'asset-cache'
        cache.mkdir()
        assets = []
        for index, (name, destination) in enumerate((('kokoro-v1_0.safetensors', 'models/mlx/model.safetensors'),
                    ('config.json', 'models/mlx/config.json'), ('voices-v1.0.bin', 'models/voices-v1.0.bin'))):
            content = (name + '-isolated-test').encode()
            (cache / name).write_bytes(content)
            assets.append({'cacheName': name, 'path': destination, 'size': len(content),
                           'sha256': hashlib.sha256(content).hexdigest(),
                           'url': 'https://huggingface.co/test/pinned/' + name})
        manifest = root / 'assets.json'
        manifest.write_text(json.dumps({'version': 1, 'engine': 'mlx', 'dtype': 'float32', 'assets': assets}))
        requirements = root / 'requirements.lock'
        requirements.write_bytes((setup.ROOT / 'runtime/requirements.lock').read_bytes())
        worker = root / 'worker.py'
        worker.write_bytes(b'# isolated fixture worker, never executed\n')
        commands = []
        def runner(arguments, **kwargs):
            commands.append((list(arguments), kwargs))
            if '-c' in arguments and 'sys.version_info' in arguments[-1]:
                output = json.dumps({'version': [3, 13], 'machine': 'arm64', 'system': 'Darwin'})
            else:
                output = ''
            if '-m' in arguments and 'venv' in arguments:
                python = Path(arguments[-1]) / 'bin/python'
                python.parent.mkdir(parents=True)
                python.write_bytes(b'# fixture interpreter; never run\n')
                python.chmod(0o700)
            return SimpleNamespace(returncode=0, stdout=output, stderr='')
        yield SimpleNamespace(root=root, home=home, cache=cache, manifest=manifest, worker=worker,
                              assets=assets, runner=runner, commands=commands, requirements=requirements)


def create_runtime(data, asset_cache=True, opener=None):
    with patch.object(setup, 'require_platform'), patch('builtins.print'):
        return setup.setup_runtime(home=data.home, python='/fixture/python3.13',
                    asset_cache=data.cache if asset_cache else None, runner=data.runner,
                    opener=opener or (lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('No network'))),
                    manifest_path=data.manifest, worker_source=data.worker, requirements=data.requirements)


def create_bundle(data):
    apps = data.root / 'Applications'
    apps.mkdir()
    source = data.root / 'build/ChatGPT Read Aloud.app'
    official = apps / 'ChatGPT.app'
    (source / 'Contents/MacOS').mkdir(parents=True)
    official.mkdir()
    (official / 'untouched').write_bytes(b'official app must remain unchanged')
    info = {'CFBundleIdentifier': install.IDENTITY, 'CFBundleExecutable': 'ChatGPT',
            'CFBundleShortVersionString': install.VERSION, 'CodexReadAloudVoicePickerVersion': 1,
            'CodexReadAloudSelectionHighlightVersion': 1}
    (source / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    (source / 'Contents/MacOS/ChatGPT').write_bytes(b'# fixture native executable\n')
    config = install.Config(app=source, target=apps / 'ChatGPT Read Aloud.app', official=official, home=data.home)
    return config


def configure_fixture(app, profile, register):
    assert register is False
    assert profile.is_dir() and not list(profile.iterdir())
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    info['CodexReadAloudLauncherVersion'] = 1
    info['LSEnvironment'] = {'CODEX_ELECTRON_USER_DATA_PATH': str(profile)}
    info_path.write_bytes(plistlib.dumps(info))
    main = app / 'Contents/MacOS/ChatGPT'
    main.rename(main.with_name('ChatGPT-native'))
    main.write_bytes(b'# fixture profile wrapper\n')


def publish_fixture(source, target):
    if target.exists() or target.is_symlink():
        raise FileExistsError('fixture target occupied')
    source.rename(target)


def run_install(data, config, **overrides):
    def verify(app, report, runner):
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        assert info['LSEnvironment']['CODEX_ELECTRON_USER_DATA_PATH'] == str(config.profile)
        assert info['CodexReadAloudLauncherVersion'] == 1
        assert (app / 'Contents/MacOS/ChatGPT-native').is_file()
    options = dict(runner=data.runner, configure=configure_fixture, verify=verify,
                   runtime_verify=lambda home: install.verify_completed_runtime(home, data.manifest, data.worker),
                   publish=publish_fixture,
                   migrate_policy=lambda *_args, **_kwargs: {'customPreferencesMigrated': True})
    options.update(overrides)
    with patch.object(install, 'require_platform'):
        return install.install_fresh(config, **options)


class BootstrapTests(unittest.TestCase):
    def test_private_runtime_with_verified_cache_locked_wheels_and_no_default_voice(self):
        with fixture() as data:
            runtime = create_runtime(data)
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads((runtime / 'settings.json').read_text())['selectedVoice'], None)
            self.assertEqual(json.loads((runtime / 'engine.json').read_text()), {'engine': 'mlx', 'dtype': 'float32'})
            self.assertEqual((runtime / 'worker-sentences-v2.py').read_bytes(), data.worker.read_bytes())
            for asset in data.assets:
                target = runtime / asset['path']
                self.assertEqual(target.read_bytes(), (data.cache / asset['cacheName']).read_bytes())
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            pip = next(arguments for arguments, _ in data.commands if 'pip' in arguments)
            for flag in ('--isolated', '--require-hashes', '--no-deps', '--only-binary=:all:'):
                self.assertIn(flag, pip)
            self.assertEqual(pip[0], str(runtime / '.venv/bin/python'))
            self.assertEqual(install.verify_completed_runtime(data.home, data.manifest, data.worker), runtime)

    def test_fresh_setup_installs_from_an_immutable_private_requirements_snapshot(self):
        with fixture() as data:
            original = data.requirements.read_bytes()
            runner = data.runner
            def change_source(arguments, **keywords):
                if 'pip' in arguments:
                    data.requirements.write_bytes(b'changed source after reviewed lock snapshot')
                    self.assertEqual(Path(arguments[-1]).read_bytes(), original)
                return runner(arguments, **keywords)
            data.runner = change_source
            runtime = create_runtime(data)
            self.assertEqual((runtime / 'requirements.lock').read_bytes(), original)
            self.assertEqual((runtime / 'requirements.lock').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((runtime / 'installation.json').read_text())['requirementsHash'], hashlib.sha256(original).hexdigest())

    def test_occupied_runtime_or_symlink_is_never_changed_or_passed_to_commands(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), fixture() as data:
                support = data.home / setup.SUPPORT
                support.mkdir(mode=0o700, parents=True)
                runtime = support / 'kokoro'
                if symlink:
                    runtime.symlink_to(data.cache, target_is_directory=True)
                else:
                    runtime.mkdir()
                    (runtime / 'settings.json').write_bytes(b'preserve existing personal voice choice')
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    create_runtime(data)
                self.assertEqual(data.commands, [])
                if not symlink:
                    self.assertEqual((runtime / 'settings.json').read_bytes(), b'preserve existing personal voice choice')

    def test_corrupt_short_or_oversized_cache_removes_only_this_incomplete_runtime(self):
        for change in ('bytes', 'short', 'long'):
            with self.subTest(change=change), fixture() as data:
                asset = data.assets[0]
                path = data.cache / asset['cacheName']
                content = path.read_bytes()
                path.write_bytes(b'x' * len(content) if change == 'bytes' else content[:-1] if change == 'short' else content + b'x')
                changed = path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'pinned'):
                    create_runtime(data)
                self.assertFalse((data.home / setup.SUPPORT / 'kokoro').exists())
                self.assertEqual(path.read_bytes(), changed)

    def test_asset_source_symlink_and_existing_destination_are_preserved(self):
        with fixture() as data:
            runtime = data.root / 'private-runtime'
            runtime.mkdir()
            asset = data.assets[0]
            target = runtime / asset['path']
            target.parent.mkdir(parents=True)
            target.write_bytes(b'keep existing destination')
            with self.assertRaises(FileExistsError):
                setup.install_asset(asset, runtime, data.cache)
            self.assertEqual(target.read_bytes(), b'keep existing destination')
            target.unlink()
            cache_file = data.cache / asset['cacheName']
            outside = data.root / 'outside-model'
            cache_file.rename(outside)
            cache_file.symlink_to(outside)
            with self.assertRaises(OSError):
                setup.install_asset(asset, runtime, data.cache)
            self.assertFalse(target.exists())
            self.assertEqual(outside.read_bytes(), (asset['cacheName'] + '-isolated-test').encode())

    def test_download_stream_is_pinned_without_reading_or_saving_any_input_text(self):
        with fixture() as data:
            calls = []
            contents = {asset['url']: (data.cache / asset['cacheName']).read_bytes() for asset in data.assets}
            def opener(url, timeout):
                calls.append((url, timeout))
                return io.BytesIO(contents[url])
            runtime = create_runtime(data, asset_cache=False, opener=opener)
            self.assertEqual(calls, [(asset['url'], 30) for asset in data.assets])
            self.assertTrue((runtime / 'installation.json').is_file())

    def test_wrong_python_and_symlinked_home_component_stop_before_installation(self):
        with fixture() as data:
            def wrong_python(arguments, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps({'version': [3, 12], 'machine': 'arm64', 'system': 'Darwin'}))
            with patch.object(setup, 'require_platform'):
                with self.assertRaisesRegex(RuntimeError, 'Python3.13'):
                    setup.setup_runtime(home=data.home, python='/fixture/python', runner=wrong_python,
                                        manifest_path=data.manifest, worker_source=data.worker)
            self.assertFalse((data.home / setup.SUPPORT).exists())
            (data.home / 'Library').symlink_to(data.cache, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlinked'):
                create_runtime(data)
            self.assertFalse((data.cache / 'Application Support').exists())

    def test_fresh_install_leaves_blank_profile_source_official_and_runtime_unchanged(self):
        with fixture() as data:
            runtime = create_runtime(data)
            config = create_bundle(data)
            source_info = (config.app / 'Contents/Info.plist').read_bytes()
            worker = (runtime / 'worker-sentences-v2.py').read_bytes()
            result = run_install(data, config)
            self.assertEqual(result['app'], str(config.target))
            self.assertEqual(config.profile.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(config.profile.iterdir()), [])
            self.assertEqual(config.launcher.stat().st_mode & 0o777, 0o700)
            self.assertIn('/usr/bin/open -a', config.launcher.read_text())
            self.assertEqual((config.app / 'Contents/Info.plist').read_bytes(), source_info)
            self.assertFalse((config.app / 'Contents/MacOS/ChatGPT-native').exists())
            self.assertEqual((config.official / 'untouched').read_bytes(), b'official app must remain unchanged')
            self.assertEqual((runtime / 'worker-sentences-v2.py').read_bytes(), worker)
            commands = [arguments for arguments, _ in data.commands]
            self.assertFalse(any(arguments[0] in ('/usr/bin/open', 'open', 'kill', '/bin/kill') for arguments in commands))
            self.assertTrue(any(arguments[0] == install.REGISTER for arguments in commands))

    def test_existing_target_profile_launcher_and_dangling_symlink_refuse_before_copying(self):
        for occupied in ('target', 'profile', 'launcher', 'target_symlink'):
            with self.subTest(occupied=occupied), fixture() as data:
                create_runtime(data)
                config = create_bundle(data)
                path = config.target if occupied.startswith('target') else getattr(config, occupied)
                path.parent.mkdir(parents=True, exist_ok=True)
                if occupied == 'target_symlink':
                    path.symlink_to(data.root / 'nonexistent')
                elif occupied == 'launcher':
                    path.write_bytes(b'keep existing launcher')
                else:
                    path.mkdir()
                    (path / 'preserve').write_bytes(b'keep existing personal data')
                before = len(data.commands)
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    run_install(data, config, configure=lambda **_: self.fail('No app configuration allowed'))
                self.assertEqual(len(data.commands), before)
                self.assertTrue(path.exists() or path.is_symlink())

    def test_signature_failure_cleans_only_empty_new_profile_and_never_publishes(self):
        with fixture() as data:
            create_runtime(data)
            config = create_bundle(data)
            def fail_verify(*args):
                raise RuntimeError('fixture invalid signature or archive integrity')
            with self.assertRaisesRegex(RuntimeError, 'invalid signature'):
                run_install(data, config, verify=fail_verify,
                            publish=lambda *_: self.fail('Unverified app must never be published'))
            self.assertFalse(config.target.exists())
            self.assertFalse(config.profile.exists())
            self.assertFalse(config.launcher.exists())
            self.assertTrue(config.app.is_dir())

    def test_racing_target_is_never_replaced_and_profile_data_is_never_deleted(self):
        with fixture() as data:
            create_runtime(data)
            config = create_bundle(data)
            def raced_publish(source, target):
                target.mkdir()
                (target / 'racing-app').write_bytes(b'preserve unrelated racing installation')
                (config.profile / 'new-data').write_bytes(b'preserve data written by another process')
                publish_fixture(source, target)
            with self.assertRaises(FileExistsError):
                run_install(data, config, publish=raced_publish)
            self.assertEqual((config.target / 'racing-app').read_bytes(), b'preserve unrelated racing installation')
            self.assertEqual((config.profile / 'new-data').read_bytes(), b'preserve data written by another process')
            self.assertFalse(config.launcher.exists())

    def test_post_publication_failure_preserves_installed_bundle_profile_and_launcher(self):
        with fixture() as data:
            create_runtime(data)
            config = create_bundle(data)
            def runner(arguments, **kwargs):
                if arguments[0] == install.REGISTER:
                    raise RuntimeError('fixture registration failure')
                return data.runner(arguments, **kwargs)
            with self.assertRaisesRegex(RuntimeError, 'registration failure'):
                run_install(data, config, runner=runner)
            self.assertTrue(config.target.is_dir())
            self.assertTrue(config.profile.is_dir())
            self.assertTrue(config.launcher.is_file())

    def test_interruption_immediately_after_publication_preserves_app_profile_and_launcher(self):
        with fixture() as data:
            create_runtime(data)
            config = create_bundle(data)
            def interrupt_after_publish(source, target):
                publish_fixture(source, target)
                raise KeyboardInterrupt('fixture interrupt after native publication')
            with self.assertRaises(KeyboardInterrupt):
                run_install(data, config, publish=interrupt_after_publish)
            self.assertTrue(config.target.is_dir())
            self.assertTrue(config.profile.is_dir())
            self.assertTrue(config.launcher.is_file())

    def test_failed_configuration_preserves_replaced_profile_and_failed_publish_preserves_foreign_launcher(self):
        for change in ('profile', 'launcher'):
            with self.subTest(change=change), fixture() as data:
                create_runtime(data)
                config = create_bundle(data)
                if change == 'profile':
                    def configure(app, profile, register):
                        profile.rename(profile.with_name('owned-profile-aside'))
                        profile.mkdir()
                        (profile / 'foreign-data').write_bytes(b'never remove replacement profile')
                        raise RuntimeError('fixture configure failure')
                    with self.assertRaisesRegex(RuntimeError, 'configure failure'):
                        run_install(data, config, configure=configure)
                    self.assertEqual((config.profile / 'foreign-data').read_bytes(), b'never remove replacement profile')
                else:
                    def publish(source, target):
                        config.launcher.rename(config.launcher.with_name('owned-launcher-aside'))
                        config.launcher.write_bytes(b'never remove replacement launcher')
                        raise RuntimeError('fixture publish failure')
                    with self.assertRaisesRegex(RuntimeError, 'publish failure'):
                        run_install(data, config, publish=publish)
                    self.assertEqual(config.launcher.read_bytes(), b'never remove replacement launcher')
                self.assertFalse(config.target.exists())

    def test_malformed_settings_or_installation_metadata_stop_without_touching_existing_runtime(self):
        for filename, content in (('settings.json', '[]'), ('settings.json', '{broken'),
                                  ('settings.json', '{"version":1}'), ('installation.json', 'null'),
                                  ('installation.json', '{"version":1,"assets":[]}')):
            with self.subTest(filename=filename, content=content), fixture() as data:
                runtime = create_runtime(data)
                config = create_bundle(data)
                (runtime / filename).write_text(content)
                with self.assertRaises((RuntimeError, ValueError)):
                    run_install(data, config)
                self.assertEqual((runtime / filename).read_text(), content)
                self.assertFalse(config.profile.exists())
                self.assertFalse(config.target.exists())

    def test_platform_gate_matches_the_actual_locked_wheel_minimum(self):
        setup.require_platform(system='Darwin', machine='arm64', version='26.0')
        for system, machine, version in (('Darwin', 'arm64', '25.0'), ('Darwin', 'x86_64', '26.0'),
                                         ('Linux', 'arm64', '26.0'), ('Darwin', 'arm64', '')):
            with self.assertRaises(RuntimeError):
                setup.require_platform(system=system, machine=machine, version=version)

    def test_runtime_asset_worker_permissions_and_dtype_changes_block_fresh_install(self):
        for change in ('model', 'worker', 'permissions', 'dtype', 'symlink'):
            with self.subTest(change=change), fixture() as data:
                runtime = create_runtime(data)
                config = create_bundle(data)
                if change == 'model':
                    (runtime / data.assets[0]['path']).write_bytes(b'changed pinned model')
                elif change == 'worker':
                    (runtime / 'worker-sentences-v2.py').write_bytes(b'changed worker')
                elif change == 'permissions':
                    (runtime / 'engine.json').chmod(0o644)
                elif change == 'dtype':
                    (runtime / 'engine.json').write_text('{"engine":"mlx","dtype":"bfloat16"}')
                else:
                    models = runtime / 'models'
                    moved = runtime / 'old-models'
                    models.rename(moved)
                    models.symlink_to(moved, target_is_directory=True)
                with self.assertRaises((RuntimeError, OSError)):
                    run_install(data, config)
                self.assertFalse(config.profile.exists())
                self.assertFalse(config.target.exists())

    def test_complete_verifier_flags_and_path_are_required(self):
        with fixture() as data:
            config = create_bundle(data)
            report = data.root / 'verification.json'
            base = {'app': str(config.app.resolve()), 'version': install.VERSION, 'packedAssetsVerified': 42,
                    'signaturesVerified': True, 'embeddedAsarIntegrityVerified': True,
                    'voicePickerHooksVerified': True, 'selectionHighlightHooksVerified': True,
                    'permanentProfilePreserved': True}
            for change in ({}, {'signaturesVerified': False}, {'app': str(config.official)}, {'packedAssetsVerified': 0}):
                def runner(arguments, **kwargs):
                    self.assertIn('--app', arguments)
                    report.write_text(json.dumps({**base, **change}))
                    return SimpleNamespace(returncode=0, stdout='', stderr='')
                if change:
                    with self.assertRaisesRegex(RuntimeError, 'verification'):
                        install.verify_staged_app(config.app, report, runner)
                else:
                    install.verify_staged_app(config.app, report, runner)

    @unittest.skipUnless(sys.platform == 'darwin', 'Native macOS no-replace publication')
    def test_native_exclusive_publication_refuses_existing_target_then_publishes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            source, target = root / 'source', root / 'target'
            source.mkdir()
            target.mkdir()
            (source / 'marker').write_bytes(b'new')
            (target / 'marker').write_bytes(b'keep existing')
            with self.assertRaises(OSError):
                install.exclusive_rename(source, target)
            self.assertEqual((target / 'marker').read_bytes(), b'keep existing')
            self.assertEqual((source / 'marker').read_bytes(), b'new')
            shutil.rmtree(target)
            install.exclusive_rename(source, target)
            self.assertEqual((target / 'marker').read_bytes(), b'new')
            self.assertFalse(source.exists())


def legacy_runtime(data):
    runtime = create_runtime(data)
    (runtime / setup.WORKER_NAME).rename(runtime / 'worker-sentences-v1.py')
    record = runtime / 'installation.json'
    installation = json.loads(record.read_text())
    installation.pop('workerName')
    installation.pop('protocolVersion')
    record.write_text(json.dumps(installation))
    (runtime / 'settings.json').write_text('{"version":1,"selectedVoice":"af_aoede"}')
    data.worker.write_bytes(b'# reviewed protocol 2 fixture; never executed\n')
    return runtime


def snapshot(directory):
    return {str(path.relative_to(directory)): (path.read_bytes(), path.stat().st_mode & 0o777)
            for path in directory.rglob('*') if path.is_file() and not path.is_symlink()}


def migrate(data, **options):
    arguments = dict(home=data.home, manifest_path=data.manifest, worker_source=data.worker, requirements=data.requirements,
                     expected_worker_hash=hashlib.sha256(data.worker.read_bytes()).hexdigest())
    arguments.update(options)
    with patch.object(setup, 'require_platform'):
        return setup.upgrade_worker(**arguments)


class WorkerMigrationTests(unittest.TestCase):
    def test_recorded_v1_upgrade_preserves_every_existing_file_and_voice_then_identical_v2_is_noop(self):
        with fixture() as data:
            runtime = legacy_runtime(data)
            before, sources, commands = snapshot(runtime), snapshot(data.cache), list(data.commands)
            source_bytes = data.worker.read_bytes()
            self.assertEqual(migrate(data), runtime)
            after = snapshot(runtime)
            for name, value in before.items():
                self.assertEqual(after[name], value)
            self.assertEqual(set(after) - set(before), {setup.WORKER_NAME, setup.WORKER_MIGRATION_NAME})
            self.assertEqual(after[setup.WORKER_NAME], (source_bytes, 0o600))
            metadata = json.loads((runtime / setup.WORKER_MIGRATION_NAME).read_text())
            self.assertEqual(metadata['workerHash'], hashlib.sha256(source_bytes).hexdigest())
            self.assertEqual(metadata['protocolVersion'], 2)
            self.assertEqual(metadata['previousWorkerName'], 'worker-sentences-v1.py')
            self.assertEqual(metadata['previousWorkerHash'], hashlib.sha256(before['worker-sentences-v1.py'][0]).hexdigest())
            self.assertEqual(migrate(data), runtime)
            self.assertEqual(snapshot(runtime), after)
            self.assertEqual(snapshot(data.cache), sources)
            self.assertEqual(data.worker.read_bytes(), source_bytes)
            self.assertEqual(data.commands, commands)
            self.assertFalse(any(path.name.startswith('.worker-v2-') for path in runtime.iterdir()))

    def test_fresh_v2_installation_records_identity_and_matching_upgrade_is_noop(self):
        with fixture() as data:
            runtime = create_runtime(data)
            installation = json.loads((runtime / 'installation.json').read_text())
            self.assertEqual(installation['workerName'], setup.WORKER_NAME)
            self.assertEqual(installation['protocolVersion'], 2)
            before, commands = snapshot(runtime), list(data.commands)
            self.assertEqual(migrate(data), runtime)
            self.assertEqual(snapshot(runtime), before)
            self.assertEqual(data.commands, commands)

    def test_invalid_runtime_record_assets_original_worker_or_occupied_v2_refuse_without_writes(self):
        for change in ('asset', 'oldworker', 'requirements', 'metadata', 'metadata_absent', 'worker_name',
                       'newworker', 'newworker_symlink', 'migration_orphan', 'engine', 'settings', 'permissions',
                       'oldworker_symlink', 'model_directory_symlink', 'metadata_symlink', 'installed_lock'):
            with self.subTest(change=change), fixture() as data:
                runtime = legacy_runtime(data)
                record = runtime / 'installation.json'
                if change == 'asset':
                    (runtime / data.assets[0]['path']).write_bytes(b'changed pinned asset')
                elif change == 'oldworker':
                    (runtime / 'worker-sentences-v1.py').write_bytes(b'changed original worker')
                elif change in ('requirements', 'worker_name'):
                    metadata = json.loads(record.read_text())
                    metadata['requirementsHash' if change == 'requirements' else 'workerName'] = '0' * 64 if change == 'requirements' else '../outside.py'
                    record.write_text(json.dumps(metadata))
                elif change == 'metadata':
                    record.write_text('{invalid')
                elif change == 'metadata_absent':
                    record.unlink()
                elif change == 'newworker':
                    setup.write_private(runtime / setup.WORKER_NAME, b'keep existing different v2')
                elif change == 'newworker_symlink':
                    (runtime / setup.WORKER_NAME).symlink_to(data.worker)
                elif change == 'migration_orphan':
                    setup.write_private(runtime / setup.WORKER_MIGRATION_NAME, b'preserve recovery metadata')
                elif change == 'oldworker_symlink':
                    old = runtime / 'worker-sentences-v1.py'
                    old.rename(data.root / 'original-worker')
                    old.symlink_to(data.root / 'original-worker')
                elif change == 'metadata_symlink':
                    record.rename(data.root / 'original-installation')
                    record.symlink_to(data.root / 'original-installation')
                elif change == 'model_directory_symlink':
                    models = runtime / 'models'
                    models.rename(data.root / 'original-models')
                    models.symlink_to(data.root / 'original-models', target_is_directory=True)
                elif change == 'installed_lock':
                    (runtime / 'requirements.lock').write_bytes(b'changed requirements snapshot')
                elif change == 'engine':
                    (runtime / 'engine.json').write_text('{"engine":"mlx","dtype":"bfloat16"}')
                elif change == 'settings':
                    (runtime / 'settings.json').write_text('{"version":1,"selectedVoice":"bad"}')
                else:
                    (runtime / 'settings.json').chmod(0o644)
                before, source, commands = snapshot(runtime), data.worker.read_bytes(), list(data.commands)
                with self.assertRaises((OSError, RuntimeError, ValueError)):
                    migrate(data)
                self.assertEqual(snapshot(runtime), before)
                self.assertEqual(data.worker.read_bytes(), source)
                self.assertEqual(data.commands, commands)

    def test_reviewed_hash_is_required_and_candidate_change_during_asset_checks_is_rejected(self):
        with fixture() as data:
            runtime = legacy_runtime(data)
            before = snapshot(runtime)
            for value in (None, '', '0' * 64, 'BAD', True):
                with self.assertRaisesRegex(RuntimeError, 'SHA256|worker-sha256'):
                    migrate(data, expected_worker_hash=value)
            digest = setup.file_digest
            def changed(path):
                value = digest(path)
                if Path(path) == runtime / data.assets[-1]['path']:
                    data.worker.write_bytes(b'candidate changed during validation')
                return value
            expected = hashlib.sha256(data.worker.read_bytes()).hexdigest()
            with patch.object(setup, 'file_digest', side_effect=changed):
                with self.assertRaisesRegex(RuntimeError, 'changed during'):
                    migrate(data, expected_worker_hash=expected)
            self.assertEqual(snapshot(runtime), before)

    def test_original_worker_or_record_changed_during_asset_checks_refuses_before_publication(self):
        for change in ('worker', 'record'):
            with self.subTest(change=change), fixture() as data:
                runtime = legacy_runtime(data)
                digest = setup.file_digest
                def changed(path):
                    value = digest(path)
                    if Path(path) == runtime / data.assets[-1]['path']:
                        target = runtime / ('worker-sentences-v1.py' if change == 'worker' else 'installation.json')
                        target.write_bytes(b'changed by another operation during verification')
                    return value
                with patch.object(setup, 'file_digest', side_effect=changed):
                    with self.assertRaisesRegex(RuntimeError, 'changed during'):
                        migrate(data)
                self.assertFalse((runtime / setup.WORKER_NAME).exists())
                self.assertFalse((runtime / setup.WORKER_MIGRATION_NAME).exists())

    def test_publication_race_preserves_foreign_worker_and_removes_only_owned_new_metadata(self):
        with fixture() as data:
            runtime = legacy_runtime(data)
            before = snapshot(runtime)
            link = os.link
            def race(source, destination, **arguments):
                if destination == setup.WORKER_NAME:
                    setup.write_private(runtime / setup.WORKER_NAME, b'foreign racing v2')
                return link(source, destination, **arguments)
            with patch.object(setup.os, 'link', side_effect=race):
                with self.assertRaises(FileExistsError):
                    migrate(data)
            after = snapshot(runtime)
            for name, value in before.items():
                self.assertEqual(after[name], value)
            self.assertEqual(set(after) - set(before), {setup.WORKER_NAME})
            self.assertEqual((runtime / setup.WORKER_NAME).read_bytes(), b'foreign racing v2')
            self.assertFalse(any(path.name.startswith('.worker-v2-') for path in runtime.iterdir()))


if __name__ == '__main__':
    unittest.main()
