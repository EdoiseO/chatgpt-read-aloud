"""Custom-copy updater policy; never write the official app's preferences."""
import os
from pathlib import Path
import plistlib
import stat
import subprocess

IDENTITY = 'local.edoise.codex.readaloud'
KEYS = ('SUEnableAutomaticChecks', 'SUAutomaticallyUpdate', 'SUAllowsAutomaticUpdates')
STARTUP_KEYS = KEYS[:2]
DEFAULTS_TIMEOUT_SECONDS = 10


def validate_bundle_policy(info):
    if info.get('CFBundleIdentifier') != IDENTITY:
        raise RuntimeError('Updater policy applies only to the custom Read Aloud copy.')
    if type(info.get('CodexReadAloudUpdaterPolicyVersion')) is not int or info['CodexReadAloudUpdaterPolicyVersion'] != 1:
        raise RuntimeError('The custom updater policy is missing.')
    if any(info.get(key) is not False for key in KEYS):
        raise RuntimeError('The custom app must disable automatic update checks and downloads.')


def read_custom_preferences(home=Path.home()):
    path = Path(home) / 'Library/Preferences' / (IDENTITY + '.plist')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {}
    with os.fdopen(descriptor, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError('The custom updater preferences must be an owned regular file.')
        try:
            value = plistlib.load(stream)
        except (ValueError, plistlib.InvalidFileException):
            raise RuntimeError('The custom updater preferences are unreadable.') from None
    if not isinstance(value, dict):
        raise RuntimeError('The custom updater preferences are invalid.')
    return {key: value.get(key) for key in KEYS}


def report_update_policy(app, home=Path.home()):
    app = Path(app)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    validate_bundle_policy(info)
    launcher = app / 'Contents/MacOS/ChatGPT'
    data = launcher.read_bytes()
    overrides = {key: False if key.encode() in data and b'NO\x00' in data else None for key in STARTUP_KEYS}
    if (type(info.get('CodexReadAloudLauncherVersion')) is not int
            or info['CodexReadAloudLauncherVersion'] != 2
            or any(value is not False for value in overrides.values())):
        raise RuntimeError('The native launcher does not enforce the custom updater policy.')
    saved = read_custom_preferences(home)
    conflict = any(saved.get(key) is not None and saved.get(key) is not False for key in STARTUP_KEYS)
    return {'policyVersion': 1, 'bundleDefaults': {key: info[key] for key in KEYS},
            'savedPreferences': saved, 'startupOverrides': overrides,
            'automaticChecksDisabled': True, 'automaticDownloadsDisabled': True,
            'preferencesMigrated': all(saved.get(key) is False for key in STARTUP_KEYS),
            'savedPreferencesConflict': conflict, 'manualUpdatesBlocked': False}


def migrate_custom_preferences(app, home=Path.home(), runner=subprocess.run):
    """Invoke only after all custom-app processes quit and before relaunch."""
    if Path(home).resolve() != Path.home().resolve():
        raise RuntimeError('Updater migration must target the current macOS user home.')
    report_update_policy(app, home)
    # defaults coordinates with cfprefsd; do not edit a cached plist in place.
    # An explicit domain and keys preserve unrelated preferences and official updates.
    for key in STARTUP_KEYS:
        result = runner(['/usr/bin/defaults', 'write', IDENTITY, key, '-bool', 'false'],
                        check=True, capture_output=True, text=True, timeout=DEFAULTS_TIMEOUT_SECONDS)
        if result.returncode:
            raise RuntimeError('The custom updater preference migration failed.')
    # Read the effective CFPreferences domain through defaults, not its disk cache.
    for key in STARTUP_KEYS:
        result = runner(['/usr/bin/defaults', 'read', IDENTITY, key],
                        check=True, capture_output=True, text=True, timeout=DEFAULTS_TIMEOUT_SECONDS)
        if result.returncode or result.stdout.strip() not in ('0', 'false', 'NO'):
            raise RuntimeError('The custom automatic-update preference remains enabled.')
    return {'customPreferencesMigrated': True, 'automaticChecksDisabled': True,
            'automaticDownloadsDisabled': True, 'manualUpdatesBlocked': False}
