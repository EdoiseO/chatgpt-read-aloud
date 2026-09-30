#!/usr/bin/env python3
"""Bind the experimental app's native entry point to its permanent profile."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'build/ChatGPT Read Aloud.app'
PROFILE = Path.home() / 'Library/Application Support/ChatGPT Read Aloud/user-data'


def validate_stage_target(app, *, home=None, official=Path('/Applications/ChatGPT.app')):
    """Allow a regular scratch stage, never an installed Applications bundle.

    install_fresh uses an exclusive, owned temporary directory on the Applications
    volume. That immediate child is the only permitted stage within Applications.
    """
    app = Path(app).expanduser().absolute()
    home = Path.home() if home is None else Path(home)
    official = Path(official).resolve()
    resolved = app.resolve()
    if app.is_symlink() or app != resolved or resolved.is_relative_to(official) or official.is_relative_to(resolved):
        raise RuntimeError('Refusing the official app or a symlinked stage target')
    if any(parent.suffix == '.app' for parent in app.parents):
        raise RuntimeError('Refusing a stage inside another app bundle')
    for applications in (Path('/Applications'), home / 'Applications'):
        if not resolved.is_relative_to(applications):
            continue
        temporary = app.parent
        if (temporary.parent != applications or not temporary.name.startswith('.chatgpt-read-aloud-install-')
                or temporary.is_symlink() or not temporary.is_dir()):
            raise RuntimeError('Launcher configuration is stage-only; refuse an installed Applications target')
        metadata = temporary.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
            raise RuntimeError('Fresh-install staging requires an owned private temporary directory')
    return app


def main(app=APP, profile=PROFILE, register=False, refresh_launcher=False):
    app = validate_stage_target(app)
    profile = Path(profile).expanduser().absolute()
    if register:
        raise RuntimeError('Do not register scratch stages; install_fresh registers only after publication')
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    if info.get('CFBundleIdentifier') != 'local.edoise.codex.readaloud' or info.get('CFBundleExecutable') != 'ChatGPT':
        raise RuntimeError('Unexpected experimental app identity or executable')
    main_binary = app / 'Contents/MacOS/ChatGPT'
    native_binary = main_binary.with_name('ChatGPT-native')
    native_exists = native_binary.exists() or native_binary.is_symlink()
    if native_exists and not refresh_launcher:
        raise RuntimeError('Native launcher already configured; no changes made')
    if refresh_launcher:
        if (not native_binary.is_file() or native_binary.is_symlink()
                or type(info.get('CodexReadAloudLauncherVersion')) is not int
                or info['CodexReadAloudLauncherVersion'] not in (1, 2, 3)
                or info.get('LSEnvironment', {}).get('CODEX_ELECTRON_USER_DATA_PATH') != str(profile)):
            raise RuntimeError('Refreshing a launcher requires a configured stage with the same permanent profile')
    for item in (info_path, main_binary, *((native_binary,) if refresh_launcher else ())):
        if item.is_symlink() or not item.is_file() or not item.resolve(strict=True).is_relative_to(app):
            raise RuntimeError('App path escapes the experimental bundle or is not a regular file')
    processes = subprocess.run(['ps', '-axo', 'args='], check=True, capture_output=True, text=True).stdout.splitlines()
    if any(row.strip().startswith(str(app / 'Contents/MacOS') + '/') for row in processes):
        raise RuntimeError('Quit the experimental app before configuring its launcher')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    # Work on an independent bundle. Compiler/signature failures leave the input
    # stage byte-for-byte intact rather than partly renaming its native entry.
    with tempfile.TemporaryDirectory(prefix='.read-aloud-launcher-', dir=app.parent) as temporary:
        compiled = Path(temporary) / 'ChatGPT'
        definition = '-DREAD_ALOUD_PROFILE=' + json.dumps(str(profile))
        subprocess.run(['xcrun', 'clang', '-arch', 'arm64', '-Wall', '-Wextra', '-Werror', '-O2',
                        definition, str(ROOT / 'profile-launcher.c'), '-o', str(compiled)], check=True)
        compiled.chmod(0o755)
        working = Path(temporary) / app.name
        shutil.copytree(app, working, symlinks=True)
        working_main = working / 'Contents/MacOS/ChatGPT'
        working_native = working_main.with_name('ChatGPT-native')
        if not refresh_launcher:
            working_main.rename(working_native)
        shutil.copy2(compiled, working_main)
        info.setdefault('LSEnvironment', {})['CODEX_ELECTRON_USER_DATA_PATH'] = str(profile)
        info['LSEnvironment']['CODEX_SPARKLE_ENABLED'] = 'false'
        info['CodexReadAloudLauncherVersion'] = 3
        # Marker accompanies the native Sparkle gate and preference overrides.
        info['CodexReadAloudUpdaterPolicyVersion'] = 2
        (working / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        entitlements = str(ROOT / 'local-entitlements.plist')
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                        '--entitlements', entitlements, str(working_native)], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                        '--entitlements', entitlements, str(working_main)], check=True)
        subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--preserve-metadata=flags',
                        '--entitlements', entitlements, str(working)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(working)], check=True)
        previous = Path(temporary) / 'unconfigured-original.app'
        try:
            app.rename(previous)
            working.rename(app)
        except BaseException:
            if previous.exists() and not app.exists():
                previous.rename(app)
            raise
    print('Native app launcher now supplies the permanent profile before Chromium starts.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=APP)
    parser.add_argument('--profile', type=Path, default=PROFILE)
    parser.add_argument('--no-register', action='store_true', help='Compatibility flag; stages are never registered')
    parser.add_argument('--refresh-launcher', action='store_true', help='Recompile the wrapper of an already configured scratch stage')
    args = parser.parse_args()
    try:
        main(args.app, args.profile, register=False, refresh_launcher=args.refresh_launcher)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
