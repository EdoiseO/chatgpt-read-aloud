#!/usr/bin/env python3
"""Install a verified fresh local copy with an empty dedicated profile; never launch it."""
import argparse
import ctypes
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile

import configure_launcher
from launch_registration import REGISTER, reconcile as reconcile_registration
from updater_policy import migrate_custom_preferences
from build_copy import VERSION
from setup_runtime import SUPPORT, ensure_home_directory, file_digest, load_manifest, regular_input, require_platform

ROOT = Path(__file__).resolve().parent
IDENTITY = 'local.edoise.codex.readaloud'
AT_FDCWD = -2
RENAME_EXCL = 0x00000004  # Darwin sys/stdio.h; do not replace a racing target.


@dataclass(frozen=True)
class Config:
    app: Path = ROOT / 'build/ChatGPT Read Aloud.app'
    target: Path = Path('/Applications/ChatGPT Read Aloud.app')
    official: Path = Path('/Applications/ChatGPT.app')
    home: Path = Path.home()

    @property
    def profile(self):
        return self.home / SUPPORT / 'user-data'

    @property
    def launcher(self):
        return self.home / 'Applications/Launch ChatGPT Read Aloud.command'


def require_absent(path, description):
    if path.exists() or path.is_symlink():
        raise RuntimeError(description + ' already exists; fresh installation will not overwrite it.')


def checked_run(arguments, runner=subprocess.run):
    result = runner([str(value) for value in arguments], check=True, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('An installation verification command failed.')
    return result


def private_file(path, read=True):
    metadata = path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077):
        raise RuntimeError('A speech-runtime file must be private, owned, regular, and nonsymlinked.')
    with regular_input(path) as stream:
        return stream.read() if read else None


def verify_completed_runtime(home, manifest_path=ROOT / 'runtime/assets.json', worker_source=ROOT / 'kokoro_worker.py'):
    runtime = home / SUPPORT / 'kokoro'
    # Do not repair permissions or create a missing runtime during installation.
    metadata = runtime.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077):
        raise RuntimeError('Run setup_runtime.py to create a private speech runtime first.')
    manifest = load_manifest(manifest_path)
    installation = json.loads(private_file(runtime / 'installation.json'))
    worker = runtime / 'worker-sentences-v2.py'
    if (not isinstance(installation, dict) or installation.get('version') != 1 or installation.get('assets') != manifest['assets']
            or installation.get('requirementsHash') != file_digest(ROOT / 'runtime/requirements.lock')[1]
            or installation.get('workerHash') != file_digest(worker_source)[1]
            or file_digest(worker)[1] != installation.get('workerHash')):
        raise RuntimeError('The completed runtime does not match the pinned source and model assets.')
    private_file(worker)
    if json.loads(private_file(runtime / 'engine.json')) != {'engine': 'mlx', 'dtype': 'float32'}:
        raise RuntimeError('The runtime must use the tested MLX float32 engine.')
    settings = json.loads(private_file(runtime / 'settings.json'))
    if not isinstance(settings, dict) or settings.get('version') != 1 or 'selectedVoice' not in settings:
        raise RuntimeError('Unexpected reading-voice settings; no settings were changed.')
    voice = settings.get('selectedVoice')
    if voice is not None and (not isinstance(voice, str) or re.fullmatch(r'(?:af|am|bf|bm)_[a-z0-9]+', voice) is None):
        raise RuntimeError('Unexpected saved reading voice.')
    interpreter = runtime / '.venv/bin/python'
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise RuntimeError('The isolated runtime interpreter is missing.')
    for asset in manifest['assets']:
        path = runtime / asset['path']
        for ancestor in path.relative_to(runtime).parents:
            if (runtime / ancestor).is_symlink():
                raise RuntimeError('A runtime model directory is symlinked.')
        private_file(path, read=False)
        if file_digest(path) != (asset['size'], asset['sha256']):
            raise RuntimeError('A runtime model asset failed pinned size and SHA256 verification.')
    return runtime


def validate_source(config):
    if config.app.is_symlink() or not config.app.is_dir():
        raise RuntimeError('Build a regular source copy with build_copy.py first.')
    source = config.app.resolve(strict=True)
    official = config.official.resolve(strict=True)
    target = config.target.resolve()
    if (source.is_relative_to(official) or official.is_relative_to(source)
            or target.is_relative_to(official) or official.is_relative_to(target)
            or source == target):
        raise RuntimeError('Refusing an app path that overlaps the official app or installation target.')
    with regular_input(config.app / 'Contents/Info.plist') as stream:
        info = plistlib.load(stream)
    if (info.get('CFBundleIdentifier') != IDENTITY or info.get('CFBundleExecutable') != 'ChatGPT'
            or info.get('CFBundleShortVersionString') != VERSION
            or any(type(info.get(marker)) is not int or info[marker] != 1 for marker in
                   ('CodexReadAloudVoicePickerVersion', 'CodexReadAloudSelectionHighlightVersion'))):
        raise RuntimeError('The built app identity, version, or feature markers are unexpected.')
    if (info.get('CodexReadAloudLauncherVersion') is not None
            or info.get('LSEnvironment', {}).get('CODEX_ELECTRON_USER_DATA_PATH') is not None
            or (config.app / 'Contents/MacOS/ChatGPT-native').exists()
            or (config.app / 'Contents/MacOS/ChatGPT-native').is_symlink()):
        raise RuntimeError('Fresh installation requires an unconfigured build, not an existing personal app copy.')
    return info


def exclusive_rename(source, target):
    """Publish with native no-replace semantics; never use an overwrite rename."""
    if sys.platform != 'darwin':
        raise RuntimeError('Native exclusive directory publication requires macOS.')
    if (source.is_symlink() or not source.is_dir() or target.parent.is_symlink()
            or source.stat().st_dev != target.parent.stat().st_dev):
        raise RuntimeError('Publication requires regular same-volume directories.')
    library = ctypes.CDLL(None, use_errno=True)
    try:
        rename = library.renameatx_np
    except AttributeError:
        raise RuntimeError('Native exclusive directory publication is unavailable.') from None
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), RENAME_EXCL):
        raise OSError(ctypes.get_errno(), 'Native exclusive app publication failed.')


def verify_staged_app(app, report, runner=subprocess.run):
    checked_run([sys.executable, ROOT / 'verify_voice_build.py', '--app', app, '--report', report], runner)
    with regular_input(report) as stream:
        result = json.load(stream)
    if (result.get('app') != str(app.resolve()) or result.get('version') != VERSION
            or result.get('packedAssetsVerified', 0) <= 0
            or any(result.get(flag) is not True for flag in
                   ('signaturesVerified', 'embeddedAsarIntegrityVerified', 'voicePickerHooksVerified',
                    'selectionHighlightHooksVerified', 'permanentProfilePreserved',
                    'manualUpdateCheckVerified', 'realtimeReadingControlsVerified',
                    'persistentReadingControlsVerified'))):
        raise RuntimeError('The scratch app did not pass complete asset, signature, and profile verification.')


def launcher_bytes(config):
    command = 'exec /usr/bin/open -a ' + shlex.quote(str(config.target))
    return ('#!/bin/sh\nset -eu\n' + command + '\n').encode()


def same_directory(path, identity):
    try:
        metadata = path.lstat()
        return stat.S_ISDIR(metadata.st_mode) and (metadata.st_dev, metadata.st_ino) == identity
    except OSError:
        return False


def install_fresh(config=Config(), runner=subprocess.run, configure=None, verify=verify_staged_app,
                  runtime_verify=verify_completed_runtime, publish=exclusive_rename, migrate_policy=None):
    migrate_policy = migrate_custom_preferences if migrate_policy is None else migrate_policy
    require_platform()
    configure = configure_launcher.main if configure is None else configure
    for path, description in ((config.target, 'The installation target'), (config.profile, 'The dedicated profile'),
                              (config.launcher, 'The launcher')):
        require_absent(path, description)
    if (config.target.parent.is_symlink() or not config.target.parent.is_dir()
            or config.target.parent.resolve() != config.target.parent.absolute()):
        raise RuntimeError('The application destination must be an existing regular directory.')
    validate_source(config)
    runtime_verify(config.home)
    checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', config.app], runner)
    checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', config.official], runner)
    ensure_home_directory(config.home, SUPPORT, private=True)
    ensure_home_directory(config.home, Path('Applications'))
    profile_identity = None
    launcher_identity = None
    staged_identity = None
    published = False
    content = launcher_bytes(config)
    try:
        config.profile.mkdir(mode=0o700)  # Exclusive: never reuse a user's data.
        config.profile.chmod(0o700)
        metadata = config.profile.stat()
        profile_identity = (metadata.st_dev, metadata.st_ino)
        with tempfile.TemporaryDirectory(prefix='.chatgpt-read-aloud-install-', dir=config.target.parent) as folder:
            stage = Path(folder) / 'ChatGPT Read Aloud.app'
            shutil.copytree(config.app, stage, symlinks=True)
            configure(app=stage, profile=config.profile, register=False)
            verify(stage, Path(folder) / 'verification.json', runner)
            migrate_policy(stage, home=config.home, runner=runner)
            # All verification and launcher preparation precede publication.
            require_absent(config.target, 'The installation target')
            descriptor = os.open(config.launcher, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o700)
                metadata = os.fstat(stream.fileno())
                launcher_identity = (metadata.st_dev, metadata.st_ino)
                stream.write(content)
            metadata = stage.stat()
            staged_identity = (metadata.st_dev, metadata.st_ino)
            publish(stage, config.target)
            published = True
        checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', config.target], runner)
        checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', config.official], runner)
        reconcile_registration(config.target, config.profile, runner=runner)
        return {'app': str(config.target), 'profile': str(config.profile), 'launcher': str(config.launcher)}
    except BaseException:
        # An interruption can occur just after the native publication returns.
        # Preserve a published app and its profile even in that narrow window.
        if published or (staged_identity is not None and same_directory(config.target, staged_identity)):
            raise
        if launcher_identity is not None:
            try:
                metadata = config.launcher.lstat()
                if (stat.S_ISREG(metadata.st_mode) and (metadata.st_dev, metadata.st_ino) == launcher_identity
                        and config.launcher.read_bytes() == content):
                    config.launcher.unlink()
            except OSError:
                pass
        if profile_identity is not None and same_directory(config.profile, profile_identity):
            try:
                config.profile.rmdir()  # Only if still empty; never delete chats or login data.
            except OSError:
                pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Config.app, help='Unconfigured built app (default: build/ChatGPT Read Aloud.app)')
    args = parser.parse_args()
    try:
        result = install_fresh(Config(app=args.app.expanduser().absolute()))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
    print('Installed ChatGPT Read Aloud without launching it.')
    print('Open: ' + result['app'])
    print('Launcher: ' + result['launcher'])
    print('The dedicated profile is blank. Sign in yourself, then choose a reading voice with previews.')


if __name__ == '__main__':
    main()
