"""Reconcile only this custom app's LaunchServices records after publication.

Backups remain intact. This module does not reset LaunchServices, edit the Dock,
launch an app, or change a profile. A successful command alone is insufficient:
the final database view must enable only the current application path.
"""
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess


IDENTITY = 'local.edoise.codex.readaloud'
APP_NAME = 'ChatGPT Read Aloud.app'
REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
BACKUP_NAME = re.compile(
    r'ChatGPT Read Aloud\.(?:backup-[0-9]{8}T[0-9]{6}Z?-[0-9]+'
    r'|kokoro-before-update-[0-9]+(?:\.[0-9]+)*-[0-9]{8}T[0-9]{6}Z?)\.app\.disabled')


def checked_run(arguments, runner):
    result = runner([str(item) for item in arguments], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Custom app launch registration command failed.')
    return result.stdout


def registered_records(output):
    """Read bundle records, ignoring LaunchServices' temporary hexadecimal IDs."""
    records = []
    fields = None

    def finish():
        if fields is None or fields.get('identifier') != IDENTITY:
            return
        value = fields.get('path', '')
        value = re.sub(r'\s+\(0x[0-9a-fA-F]+\)$', '', value)
        if not value.startswith('/') or '\n' in value:
            raise RuntimeError('The custom app launch registration record is unreadable.')
        records.append({**fields, 'path': Path(value)})

    for line in output.splitlines():
        header = re.match(r'^([^:\s][^:]* id):', line)
        if header:
            finish()
            fields = {} if header[1] == 'bundle id' else None
            continue
        match = re.match(r'^(path|identifier|bundle flags|inode|exec inode):\s*(.*?)\s*$', line)
        if fields is None or not match:
            continue
        key, value = match.groups()
        if key in fields:
            raise RuntimeError('The launch registration dump format is ambiguous.')
        else:
            fields[key] = value
    finish()
    return records


def registered_paths(output):
    return {record['path'] for record in registered_records(output)}


def enabled_records(records):
    enabled = []
    for record in records:
        flags = record.get('bundle flags')
        if flags is None:
            raise RuntimeError('Custom app launch registration flags are missing.')
        # Inspect complete tokens in the lsregister format. Missing or malformed
        # flags cannot be used as evidence that an obsolete copy is disabled.
        if not re.fullmatch(r'(?:[a-zA-Z][a-zA-Z0-9-]*\s+)*\([0-9a-fA-F]{8,16}\)', flags):
            raise RuntimeError('Custom app launch registration flags are unreadable.')
        if 'launch-disabled' not in flags.split():
            enabled.append(record)
    return enabled


def verify_registration(output, target, target_identity):
    records = registered_records(output)
    # Unregistered bundles can reappear as launch-disabled records after an
    # asynchronous LS refresh. Their presence does not make them launchable.
    enabled = enabled_records(records)
    if not enabled or {record['path'] for record in enabled} != {target}:
        raise RuntimeError('Custom app launch registration still enables a missing or retired copy.')
    identities = {path: inode for path, _, inode in target_identity}
    for record in enabled:
        for key, path in (('inode', target), ('exec inode', target / 'Contents/MacOS/ChatGPT')):
            if not record.get(key, '').isdigit() or int(record[key]) != identities[path]:
                raise RuntimeError('Custom app launch registration does not match the current bundle identity.')


def verified_bundle(bundle, profile, runner):
    """Bind a signed, owned custom bundle to the expected dedicated profile."""
    bundle = Path(bundle)
    if not bundle.is_absolute() or bundle.resolve(strict=True) != bundle:
        raise RuntimeError('Launch registration requires a regular absolute bundle path.')
    metadata = bundle.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise RuntimeError('Launch registration requires a user-owned custom bundle.')
    identities = [(bundle, metadata.st_dev, metadata.st_ino)]
    for relative in ('Contents', 'Contents/MacOS', 'Contents/Info.plist',
                     'Contents/MacOS/ChatGPT', 'Contents/MacOS/ChatGPT-native'):
        item = bundle / relative
        metadata = item.lstat()
        directory = relative in ('Contents', 'Contents/MacOS')
        if (item.is_symlink() or metadata.st_uid != os.getuid()
                or not (stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode))):
            raise RuntimeError('A launch registration bundle entry is not owned and regular.')
        if relative.startswith('Contents/MacOS/') and not metadata.st_mode & 0o111:
            raise RuntimeError('A custom app launcher is not executable.')
        identities.append((item, metadata.st_dev, metadata.st_ino))
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    if (info.get('CFBundleIdentifier') != IDENTITY or info.get('CFBundleExecutable') != 'ChatGPT'
            or info.get('LSEnvironment', {}).get('CODEX_ELECTRON_USER_DATA_PATH') != str(profile)):
        raise RuntimeError('A launch registration bundle has an unexpected identity or profile.')
    checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle], runner)
    return identities


def unchanged(identities):
    for path, device, inode in identities:
        metadata = path.lstat()
        if path.is_symlink() or (metadata.st_dev, metadata.st_ino) != (device, inode):
            raise RuntimeError('A custom bundle changed during launch registration.')


def reconcile(target, profile, *, retired=(), runner=subprocess.run):
    """Unregister verified retired copies and register/verify the current path.

    Explicit retired paths are staging locations from the activation transaction.
    Historical backups are accepted only as exact named siblings. Unknown
    launchable registrations prevent verification and are never removed.
    """
    target, profile = Path(target), Path(profile)
    if target.name != APP_NAME:
        raise RuntimeError('Unexpected current custom app registration path.')
    target_identity = verified_bundle(target, profile, runner)
    records = registered_records(checked_run([REGISTER, '-dump'], runner))
    # Already-disabled historical records need no mutation. Their files may
    # legitimately have been removed or belong to an older profile/signature;
    # validating those files would block both activation and recovery needlessly.
    paths = {record['path'] for record in enabled_records(records)}
    candidates = {path for path in paths if path.parent == target.parent and BACKUP_NAME.fullmatch(path.name)}
    for value in retired:
        path = Path(value)
        if path == target or (path.name != APP_NAME and not (
                path.parent == target.parent and BACKUP_NAME.fullmatch(path.name))):
            raise RuntimeError('Unexpected retired custom app registration path.')
        if path in paths:
            candidates.add(path)
    # Validate every candidate before the first database mutation. Missing,
    # foreign, or changed bundles are preserved for inspection, never guessed at.
    verified = [(path, verified_bundle(path, profile, runner)) for path in sorted(candidates)]
    for path, identities in verified:
        unchanged(target_identity)
        unchanged(identities)
        checked_run([REGISTER, '-u', path], runner)
    unchanged(target_identity)
    checked_run([REGISTER, '-f', target], runner)
    unchanged(target_identity)
    verify_registration(checked_run([REGISTER, '-dump'], runner), target, target_identity)
    return {'currentAppRegistered': True, 'retiredAppsUnregistered': [str(path) for path, _ in verified]}
