#!/usr/bin/env python3
"""Bind the experimental app's native entry point to its permanent profile."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
APP = Path('/Applications/ChatGPT Read Aloud.app')
PROFILE = Path.home() / 'Library/Application Support/ChatGPT Read Aloud/user-data'


def main(app=APP, profile=PROFILE, register=True):
    app = Path(app).expanduser().absolute()
    profile = Path(profile).expanduser().absolute()
    official = Path('/Applications/ChatGPT.app').resolve()
    if app.is_symlink() or app.resolve().is_relative_to(official) or official.is_relative_to(app.resolve()):
        raise SystemExit('Refusing the official app or a symlinked target')
    info_path = app / 'Contents/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    if info.get('CFBundleIdentifier') != 'local.edoise.codex.readaloud' or info.get('CFBundleExecutable') != 'ChatGPT':
        raise SystemExit('Unexpected experimental app identity or executable')
    main_binary = app / 'Contents/MacOS/ChatGPT'
    native_binary = main_binary.with_name('ChatGPT-native')
    if native_binary.exists() or native_binary.is_symlink():
        raise SystemExit('Native launcher already configured; no changes made')
    for item in (info_path, main_binary):
        if not item.resolve(strict=True).is_relative_to(app.resolve()):
            raise SystemExit('App path escapes the experimental bundle')
    processes = subprocess.run(['ps', '-axo', 'args='], capture_output=True, text=True).stdout.splitlines()
    if any(row.strip().startswith(str(app / 'Contents/MacOS') + '/') for row in processes):
        raise SystemExit('Quit the experimental app before configuring its launcher')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    with tempfile.TemporaryDirectory(prefix='read-aloud-launcher-') as temporary:
        compiled = Path(temporary) / 'ChatGPT'
        definition = '-DREAD_ALOUD_PROFILE=' + json.dumps(str(profile))
        subprocess.run(['xcrun', 'clang', '-arch', 'arm64', '-Wall', '-Wextra', '-Werror', '-O2',
                        definition, str(ROOT / 'profile-launcher.c'), '-o', str(compiled)], check=True)
        compiled.chmod(0o755)
        main_binary.rename(native_binary)
        main_binary.write_bytes(compiled.read_bytes())
        main_binary.chmod(0o755)
    info.setdefault('LSEnvironment', {})['CODEX_ELECTRON_USER_DATA_PATH'] = str(profile)
    info['CodexReadAloudLauncherVersion'] = 1
    info_path.write_bytes(plistlib.dumps(info))
    entitlements = str(ROOT / 'local-entitlements.plist')
    subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                    '--entitlements', entitlements, str(native_binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', '--options', 'runtime',
                    '--entitlements', entitlements, str(main_binary)], check=True)
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--preserve-metadata=flags',
                    '--entitlements', entitlements, str(app)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    if register:
        registration_tool = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
        subprocess.run([registration_tool, '-f', str(app)], check=True)
    print('Native app launcher now supplies the permanent profile before Chromium starts.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=APP)
    parser.add_argument('--profile', type=Path, default=PROFILE)
    parser.add_argument('--no-register', action='store_true', help='Skip Launch Services registration for a scratch stage')
    args = parser.parse_args()
    main(args.app, args.profile, register=not args.no_register)
