#!/usr/bin/env python3
"""Apply the staged voice upgrade only after every custom-app process has quit.

The default action is read-only --check. --schedule detaches a bounded one-shot
waiter; it never quits or kills a GUI, embedded CLI, or unrelated app. Only after
they exit can verified detached custom-app native helpers receive SIGTERM.
A stopped app is exchanged atomically with its verified stage. Unchanged,
standalone CUA helpers may continue running through the exchange.
"""
import argparse
import ctypes
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import stat
import struct
import subprocess
from signing_identity import verify_signing_identity, verify_signing_transition
import sys
import tempfile
import time

from asar_integrity import patch_integrity_slot
from runtime_voices import read_saved_voice
from launch_registration import reconcile as reconcile_registration
from updater_policy import migrate_custom_preferences, report_update_policy
from updater_policy import validate_bundle_policy, verify_effective_preferences


ROOT = Path(__file__).resolve().parent
IDENTITY = 'local.edoise.codex.readaloud'
DOCK_EXECUTABLE = '/System/Library/CoreServices/Dock.app/Contents/XPCServices/com.apple.dock.external.extra.arm64.xpc/Contents/MacOS/com.apple.dock.external.extra.arm64'
DOCK_RESOURCES = (
    'Contents/PlugIns/CodexDockTilePlugin.docktileplugin/Contents/MacOS/CodexDockTilePlugin',
    'Contents/Resources/icon-codex-light.png',
    'Contents/Resources/icon-codex-dark-color.png',
)
CUA_ROOT = Path('Contents/Resources/cua_node')
CUA_NODE = CUA_ROOT / 'bin/node'
CUA_NODE_REPL = CUA_ROOT / 'bin/node_repl'
CUA_ENTRY = CUA_ROOT / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
AT_FDCWD = -2  # Darwin sys/fcntl.h
RENAME_SWAP = 0x00000002  # Darwin sys/stdio.h
MAX_RETAINED_RESOURCE_ALIASES = 8
RECOVERY_STATES = frozenset(('rollback_pending_quit', 'rollback_waiting_for_quit',
                             'exchanging', 'exchanged', 'verifying_startup',
                             'rolled_back_recovery_pending'))
TRANSACTION_STATES = RECOVERY_STATES | frozenset(('waiting_for_quit', 'wait_expired',
                                                'recheck_failed', 'exchange_failed',
                                                'activated', 'rolled_back'))


@dataclass(frozen=True)
class Config:
    stage: Path = ROOT / 'build/ChatGPT Read Aloud.app'
    target: Path = Path('/Applications/ChatGPT Read Aloud.app')
    official: Path = Path('/Applications/ChatGPT.app')
    profile: Path = Path.home() / 'Library/Application Support/ChatGPT Read Aloud/user-data'
    launcher: Path = Path.home() / 'Applications/Launch ChatGPT Read Aloud.command'
    report: Path = ROOT / 'voice-upgrade-activation.json'
    verification_report: Path = ROOT / 'voice-build-verification.json'
    lock: Path = ROOT / '.voice-upgrade-activation.lock'
    log: Path = ROOT / 'voice-upgrade-activation.log'


def checked_run(arguments, runner=subprocess.run):
    result = runner(arguments, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('A required verification or launch command failed.')
    return result


def atomic_exchange(first, second):
    """Exchange two real same-volume directories; never fall back to renames."""
    first, second = Path(first), Path(second)
    if sys.platform != 'darwin':
        raise RuntimeError('Atomic app-directory exchange requires macOS.')
    if (first.is_symlink() or second.is_symlink() or not first.is_dir() or not second.is_dir()
            or first.stat().st_dev != second.stat().st_dev):
        raise RuntimeError('Atomic exchange requires two regular same-volume directories.')
    left, right = first.resolve(strict=True), second.resolve(strict=True)
    if left.is_relative_to(right) or right.is_relative_to(left):
        raise RuntimeError('Atomic exchange paths must be distinct and nonoverlapping.')
    library = ctypes.CDLL(None, use_errno=True)
    try:
        exchange = library.renameatx_np
    except AttributeError:
        raise RuntimeError('Native atomic directory exchange is unavailable.') from None
    exchange.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    exchange.restype = ctypes.c_int
    if exchange(AT_FDCWD, os.fsencode(left), AT_FDCWD, os.fsencode(right), RENAME_SWAP):
        error = ctypes.get_errno()
        raise OSError(error, 'Native atomic directory exchange failed.')


def verify_exchange_capability(exchange):
    """Probe only disposable toy directories before any production exchange."""
    with tempfile.TemporaryDirectory(prefix='codex-read-aloud-swap-') as folder:
        left, right = Path(folder) / 'left', Path(folder) / 'right'
        left.mkdir()
        right.mkdir()
        (left / 'identity').write_text('left')
        (right / 'identity').write_text('right')
        exchange(left, right)
        if (left / 'identity').read_text() != 'right' or (right / 'identity').read_text() != 'left':
            raise RuntimeError('Native atomic exchange capability verification failed.')


def atomic_report(config, record):
    record = {**record, 'updatedAt': datetime.now(timezone.utc).isoformat()}
    descriptor, temporary = tempfile.mkstemp(prefix='.voice-upgrade-', dir=config.report.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(record, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, config.report)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def contained_path(bundle, relative):
    resolved = (bundle / relative).resolve(strict=True)
    if not resolved.is_relative_to(bundle.resolve(strict=True)):
        raise RuntimeError('A custom-app path escapes its bundle.')
    return resolved


def bundle_info(config, bundle, expected_version=None):
    if bundle.is_symlink() or not bundle.is_dir():
        raise RuntimeError('Expected a regular custom-app bundle directory.')
    root = bundle.resolve(strict=True)
    official = config.official.resolve(strict=True)
    if root.is_relative_to(official) or official.is_relative_to(root):
        raise RuntimeError('Refusing a path that overlaps the official app.')
    info = plistlib.loads(contained_path(bundle, Path('Contents/Info.plist')).read_bytes())
    if info.get('CFBundleIdentifier') != IDENTITY or info.get('CFBundleExecutable') != 'ChatGPT':
        raise RuntimeError('Unexpected custom-app identity or executable.')
    if expected_version is not None and info.get('CFBundleShortVersionString') != expected_version:
        raise RuntimeError('The staged and installed custom-app versions differ.')
    if (type(info.get('CodexReadAloudLauncherVersion')) is not int
            or info['CodexReadAloudLauncherVersion'] not in (1, 2, 3) or
            info.get('LSEnvironment', {}).get('CODEX_ELECTRON_USER_DATA_PATH') != str(config.profile)):
        raise RuntimeError('The custom app is not bound to its existing dedicated profile.')
    for name in ('ChatGPT', 'ChatGPT-native'):
        executable = contained_path(bundle, Path('Contents/MacOS') / name)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeError('The existing native profile launcher is missing.')
    return info


def bundle_identity_hash(bundle, asar_header_hash):
    """Bind launcher/policy changes even when the packed application is unchanged."""
    if not isinstance(asar_header_hash, str) or re.fullmatch(r'[0-9a-f]{64}', asar_header_hash) is None:
        raise RuntimeError('The verified archive identity is invalid.')
    digest = hashlib.sha256(b'codex-read-aloud-bundle-identity-v1\x00')
    fields = [('Contents/Info.plist', contained_path(bundle, Path('Contents/Info.plist')).read_bytes())]
    for name in ('ChatGPT', 'ChatGPT-native'):
        relative = 'Contents/MacOS/' + name
        fields.append((relative, hashlib.sha256(contained_path(bundle, Path(relative)).read_bytes()).digest()))
    fields.append(('Contents/Resources/app.asar.header.sha256', bytes.fromhex(asar_header_hash)))
    for name, value in fields:
        label = name.encode('utf-8')
        digest.update(struct.pack('>I', len(label)))
        digest.update(label)
        digest.update(struct.pack('>Q', len(value)))
        digest.update(value)
    return digest.hexdigest()


def validate_transaction_bundle_identities(record):
    fields = ('previousBundleIdentityHash', 'stagedBundleIdentityHash')
    if any(field in record for field in fields) and not all(field in record for field in fields):
        raise RuntimeError('The transaction bundle identity pair is incomplete.')
    for role in ('previous', 'staged'):
        field = role + 'BundleIdentityHash'
        if field in record and (not isinstance(record[field], str)
                                or re.fullmatch(r'[0-9a-f]{64}', record[field]) is None):
            raise RuntimeError('The transaction bundle identity is invalid.')


def matches_transaction_bundle(info, record, role):
    validate_transaction_bundle_identities(record)
    field = role + 'BundleIdentityHash'
    if field in record:
        actual, expected = info.get('_bundleIdentityHash'), record[field]
    else:
        # Existing journals predate launcher identities. Only an absent field
        # permits their legacy ASAR comparison; malformed new fields never do.
        actual = info['ElectronAsarIntegrity']['Resources/app.asar']['hash']
        expected = record.get(role + 'AsarHeaderHash')
    if (not isinstance(expected, str) or re.fullmatch(r'[0-9a-f]{64}', expected) is None
            or not isinstance(actual, str) or re.fullmatch(r'[0-9a-f]{64}', actual) is None):
        raise RuntimeError('The transaction app identity is missing or invalid.')
    return actual == expected


def verify_bundle(config, bundle, expected_version=None, require_upgrade=False, runner=subprocess.run):
    info = bundle_info(config, bundle, expected_version)
    if require_upgrade and info.get('CodexReadAloudVoicePickerVersion') != 1:
        raise RuntimeError('The staged app is missing the verified voice-picker version marker.')
    if require_upgrade and (type(info.get('CodexReadAloudSelectionHighlightVersion')) is not int
                            or info['CodexReadAloudSelectionHighlightVersion'] != 1):
        raise RuntimeError('The staged app is missing the verified selection-highlight version marker.')
    if require_upgrade:
        if type(info.get('CodexReadAloudLauncherVersion')) is not int or info['CodexReadAloudLauncherVersion'] != 3:
            raise RuntimeError('The staged app is missing the verified updater-policy launcher.')
        validate_bundle_policy(info)
        # Markers alone cannot establish that the native wrapper supplies the
        # host's updater gate or that this exact host build honors the gate.
        # Saved preference conflicts are migrated only after the app quits.
        report_update_policy(bundle)
    info['_signingIdentity'] = verify_signing_identity(bundle, info=info, runner=runner)
    framework = contained_path(bundle, Path('Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework'))
    integrity = info['ElectronAsarIntegrity']
    patch_integrity_slot(framework.read_bytes(), integrity, integrity)
    archive = contained_path(bundle, Path('Contents/Resources/app.asar'))
    with archive.open('rb') as stream:
        header = stream.read(16)
        if len(header) != 16:
            raise RuntimeError('The custom-app archive is truncated.')
        values = struct.unpack('<4I', header)
        raw = stream.read(values[3])
        if len(raw) != values[3] or hashlib.sha256(raw).hexdigest() != integrity['Resources/app.asar']['hash']:
            raise RuntimeError('The custom-app archive integrity metadata is inconsistent.')
        if require_upgrade:
            entry = json.loads(raw)
            try:
                for part in '.vite/build/local-read-aloud-main.cjs'.split('/'):
                    entry = entry['files'][part]
            except KeyError:
                raise RuntimeError('The staged app does not contain the voice upgrade.') from None
            if entry.get('unpacked') or 'offset' not in entry or 'size' not in entry:
                raise RuntimeError('The staged voice module has unexpected archive metadata.')
            stream.seek(8 + values[1] + int(entry['offset']))
            content = stream.read(entry['size'])
            if hashlib.sha256(content).hexdigest() != entry.get('integrity', {}).get('hash'):
                raise RuntimeError('The staged voice module failed integrity verification.')
            main_hash = hashlib.sha256(content).hexdigest()
            if main_hash != hashlib.sha256((ROOT / 'kokoro-main.cjs').read_bytes()).hexdigest():
                raise RuntimeError('The staged voice module differs from the current verified source.')
            info['_mainModuleHash'] = main_hash
    info['_bundleIdentityHash'] = bundle_identity_hash(bundle, integrity['Resources/app.asar']['hash'])
    return info


def parse_process_rows(output):
    rows = {}
    for line in output.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    return rows


def dock_resource_hashes(bundle, cache=None):
    key = ('dock', str(bundle))
    if cache is not None and key in cache:
        return cache[key]
    if bundle.is_symlink() or not bundle.is_dir():
        raise RuntimeError('A Dock resource alias is not a regular directory.')
    hashes = {relative: hashlib.sha256(contained_path(bundle, Path(relative)).read_bytes()).hexdigest()
              for relative in DOCK_RESOURCES}
    if cache is not None:
        cache[key] = hashes
    return hashes


def unchanged_dock_hashes(config, cache=None, record=None):
    """Permit only the OS Dock's proven unchanged plugin and icon mappings."""
    try:
        expected = {}
        if config.stage.is_dir():
            expected = dock_resource_hashes(config.target, cache)
            if dock_resource_hashes(config.stage, cache) != expected:
                return {}
        else:
            # During startup/rollback the stage has already been moved. The
            # transaction records hashes proven equal before either rename.
            record = transaction_record(config) if record is None else record
            if record.get('app') != str(config.target):
                return {}
            expected = record.get('unchangedDockResourceHashes', {})
            if set(expected) != set(DOCK_RESOURCES):
                return {}
            if dock_resource_hashes(config.target, cache) != expected:
                return {}
        return expected
    except (OSError, ValueError, RuntimeError):
        return {}


def safe_dock_mapping(config, command, app_mappings, all_mappings, cache=None, record=None):
    if command != DOCK_EXECUTABLE or DOCK_EXECUTABLE not in all_mappings:
        return False
    cache = {} if cache is None else cache
    record = transaction_record(config) if record is None else record
    expected = unchanged_dock_hashes(config, cache, record)
    if set(expected) != set(DOCK_RESOURCES):
        return False
    aliases = [config.target, config.stage]
    if record and record.get('unchangedDockResourceHashes') == expected:
        try:
            backup = valid_backup_path(config, record['backup'])
            if dock_resource_hashes(backup, cache) == expected:
                aliases.append(backup)
        except (OSError, RuntimeError):
            pass
    if record.get('retainedResourceBackupAliases'):
        manifest, _ = unchanged_cua_proof(config, record, cache)
        aliases.extend(verified_retained_resource_aliases(config, record, manifest, expected, cache))
    allowed = {str(bundle / relative) for bundle in aliases for relative in DOCK_RESOURCES}
    plugin_paths = {str(bundle / DOCK_RESOURCES[0]) for bundle in aliases}
    return bool(app_mappings & plugin_paths) and app_mappings <= allowed


def valid_backup_path(config, value):
    if not isinstance(value, str):
        raise RuntimeError('Unexpected previous-app backup path.')
    backup = Path(value)
    if (backup.parent != config.target.parent
            or re.fullmatch(r'ChatGPT Read Aloud\.backup-[0-9]{8}T[0-9]{6}Z-[0-9]+\.app\.disabled', backup.name) is None
            or backup.is_symlink()):
        raise RuntimeError('Unexpected previous-app backup path.')
    return backup


def retained_backup_paths(config, record):
    values = record.get('retainedResourceBackupAliases', [])
    if not isinstance(values, list) or len(values) > MAX_RETAINED_RESOURCE_ALIASES:
        raise RuntimeError('Unexpected retained resource backup aliases.')
    return tuple(dict.fromkeys(valid_backup_path(config, value) for value in values))


def transaction_record(config, *, strict=False):
    """Inspect a private journal; absence and unusable existing state differ.

    Resource/process proofs can conservatively ignore an invalid journal. An
    activation must instead fail closed before replacing any existing record.
    """
    try:
        config.report.lstat()
    except FileNotFoundError:
        return {}
    except OSError:
        if strict:
            raise RuntimeError('The existing activation journal is invalid or unreadable; preserve it and inspect recovery before retrying.') from None
        return {}
    try:
        descriptor = os.open(config.report, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'r') as stream:
            metadata = os.fstat(stream.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or metadata.st_mode & 0o077):
                raise RuntimeError('The activation journal is not private.')
            record = json.load(stream)
        if (not isinstance(record, dict) or record.get('app') != str(config.target) or record.get('stage') != str(config.stage)
                or record.get('profile') != str(config.profile)
                or record.get('transaction') != 'atomic_exchange_v1'
                or record.get('status') not in TRANSACTION_STATES):
            raise RuntimeError('The activation journal identity is invalid.')
        valid_backup_path(config, record.get('backup'))
        retained_backup_paths(config, record)
        validate_transaction_bundle_identities(record)
        return record
    except (OSError, ValueError, TypeError, UnicodeError, RuntimeError):
        if strict:
            raise RuntimeError('The existing activation journal is invalid or unreadable; preserve it and inspect recovery before retrying.') from None
        return {}


def cua_subtree_manifest(bundle):
    """Bind every tree entry, mode, regular-file byte, and internal symlink."""
    if bundle.is_symlink() or not bundle.is_dir():
        raise RuntimeError('A CUA bundle alias is not a regular directory.')
    tree = contained_path(bundle, CUA_ROOT)
    if (bundle / CUA_ROOT).is_symlink() or not tree.is_dir():
        raise RuntimeError('The standalone CUA subtree is not a regular directory.')
    manifest = {}
    def visit(path):
        relative = path.relative_to(tree).as_posix()
        metadata = path.lstat()
        entry = {'mode': stat.S_IMODE(metadata.st_mode)}
        if stat.S_ISDIR(metadata.st_mode):
            entry['type'] = 'directory'
        elif stat.S_ISREG(metadata.st_mode):
            entry['type'] = 'file'
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for part in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(part)
            entry['sha256'] = digest.hexdigest()
        elif stat.S_ISLNK(metadata.st_mode):
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(tree):
                raise RuntimeError('A standalone CUA symlink escapes its subtree.')
            entry.update(type='symlink', target=os.readlink(path), resolved=resolved.relative_to(tree).as_posix())
        else:
            raise RuntimeError('An unexpected standalone CUA file type is present.')
        manifest[relative] = entry
        if len(manifest) > 10000:
            raise RuntimeError('The standalone CUA subtree is unexpectedly large.')
        if entry['type'] == 'directory':
            for child in sorted(path.iterdir()):
                visit(child)
    visit(tree)
    for relative in (CUA_NODE, CUA_NODE_REPL, CUA_ENTRY):
        item = manifest.get(relative.relative_to(CUA_ROOT).as_posix(), {})
        if item.get('type') != 'file':
            raise RuntimeError('A required standalone CUA entry is missing.')
    return manifest


def cached_cua_manifest(bundle, cache):
    key = ('cua', str(bundle))
    if key not in cache:
        cache[key] = cua_subtree_manifest(bundle)
    return cache[key]


def verified_retained_resource_aliases(config, record, manifest, dock_hashes, cache, include_current=False):
    """Allow only recorded exact aliases whose CUA and Dock resources match now."""
    if (not manifest or set(dock_hashes) != set(DOCK_RESOURCES)
            or record.get('unchangedCuaSubtreeManifest') != manifest
            or record.get('unchangedDockResourceHashes') != dock_hashes):
        return ()
    try:
        candidates = list(retained_backup_paths(config, record))
        if include_current:
            candidates.append(valid_backup_path(config, record.get('backup')))
    except RuntimeError:
        return ()
    aliases = []
    for backup in dict.fromkeys(candidates):
        try:
            if (cached_cua_manifest(backup, cache) == manifest
                    and dock_resource_hashes(backup, cache) == dock_hashes):
                aliases.append(backup)
        except (OSError, ValueError, RuntimeError):
            pass  # A changed or removed alias is never permitted or carried.
    return tuple(aliases)


def unchanged_cua_proof(config, record=None, cache=None):
    """Hash once per scan; revalidate current and retained exact backup aliases."""
    record = transaction_record(config) if record is None else record
    cache = {} if cache is None else cache
    try:
        target = cached_cua_manifest(config.target, cache)
        if config.stage.exists() or config.stage.is_symlink():
            if cached_cua_manifest(config.stage, cache) != target:
                return {}, ()
            expected = target
            aliases = [config.target, config.stage]
        else:
            expected = record.get('unchangedCuaSubtreeManifest', {})
            if not expected or expected != target:
                return {}, ()
            aliases = [config.target]
        if record and record.get('unchangedCuaSubtreeManifest') == expected:
            backup = valid_backup_path(config, record.get('backup'))
            if backup.exists() and cached_cua_manifest(backup, cache) == expected:
                aliases.append(backup)
        if record.get('retainedResourceBackupAliases'):
            dock_hashes = unchanged_dock_hashes(config, cache, record)
            aliases.extend(verified_retained_resource_aliases(config, record, expected, dock_hashes, cache))
        return expected, tuple(aliases)
    except (OSError, ValueError, RuntimeError):
        return {}, ()


def custom_app_path(config, path):
    roots = (str(config.target), str(config.stage), str(config.profile.parent / 'kokoro'))
    if any(path == root or path.startswith(root + '/') for root in roots):
        return True
    prefix = str(config.target.parent / 'ChatGPT Read Aloud.backup-')
    return path.startswith(prefix)  # Unrecorded prior backups block; they are never permitted aliases.


def cua_executable(command, aliases):
    for bundle in aliases:
        node, repl, script = (str(bundle / item) for item in (CUA_NODE, CUA_NODE_REPL, CUA_ENTRY))
        if command == node + ' ' + script:
            return node, CUA_NODE.relative_to(CUA_ROOT).as_posix()
        if command == repl:
            return repl, CUA_NODE_REPL.relative_to(CUA_ROOT).as_posix()
    return None


def process_identity(pid, runner=subprocess.run):
    details = checked_run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'pid=,ppid=,uid=,stat=,lstart=,comm='], runner)
    parts = details.stdout.strip().split(None, 9)
    if len(parts) != 10 or not all(value.isdigit() for value in parts[:3]):
        return None
    arguments = checked_run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'args='], runner).stdout.strip()
    return {'pid': int(parts[0]), 'parent': int(parts[1]), 'uid': int(parts[2]), 'state': parts[3],
            'started': ' '.join(parts[4:9]), 'executable': parts[9], 'arguments': arguments}


def safe_cua_process(config, pid, initial_row, manifest, aliases, runner=subprocess.run):
    role = cua_executable(initial_row[1], aliases)
    if not manifest or role is None:
        return False
    try:
        identity = process_identity(pid, runner)
        if (not identity or identity['pid'] != pid or identity['uid'] != os.getuid()
                or identity['parent'] != initial_row[0] or identity['arguments'] != initial_row[1]
                or identity['executable'] != role[0] or identity['state'].startswith('Z')):
            return False
        files = runner(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', str(pid), '-u', str(os.getuid()), '-F', 'pufn'],
                       capture_output=True, text=True, timeout=10)
        if files.returncode or files.stderr.strip():
            return False
        mapped_executable = False
        seen_pid, seen_uid, descriptor = None, None, None
        for line in files.stdout.splitlines():
            if line.startswith('p'):
                seen_pid = int(line[1:]) if line[1:].isdigit() else None
                descriptor = None
            elif line.startswith('u'):
                seen_uid = int(line[1:]) if line[1:].isdigit() else None
            elif line.startswith('f'):
                descriptor = line[1:]
            elif line.startswith('n') and custom_app_path(config, line[1:]):
                if seen_pid != pid or seen_uid != os.getuid():
                    return False
                permitted = False
                for bundle in aliases:
                    prefix = str(bundle / CUA_ROOT) + '/'
                    path = line[1:]
                    relative = '.' if path == str(bundle / CUA_ROOT) else path[len(prefix):] if path.startswith(prefix) else None
                    if relative in manifest:
                        permitted = True
                        if descriptor == 'txt' and relative == role[1]:
                            mapped_executable = True
                        break
                if not permitted:
                    return False
        fresh = process_identity(pid, runner)
        return mapped_executable and same_process(identity, fresh) and not fresh['state'].startswith('Z')
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return False


def process_blockers(config, runner=subprocess.run):
    """Find app executables, embedded CLIs, mapped frameworks, and descendants."""
    ps = checked_run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,args='], runner)
    rows = parse_process_rows(ps.stdout)
    roots = (str(config.target.absolute()), str(config.stage.absolute()),
             str((config.profile.parent / 'kokoro').absolute()))
    blocked = {pid for pid, (_, command) in rows.items()
               if any(root + '/' in command or command.endswith(root) for root in roots)
               or str(config.target.parent / 'ChatGPT Read Aloud.backup-') in command}
    # argv can be shortened by a native process. Mapped executable/framework
    # paths provide an independent check without traversing the whole bundle.
    files = runner(['/usr/sbin/lsof', '-n', '-P', '-a', '-u', str(os.getuid()),
                    '-d', 'txt', '-F', 'pn'], capture_output=True, text=True, timeout=30)
    if files.returncode not in (0, 1) or (files.returncode == 1 and files.stderr.strip()):
        raise RuntimeError('Cannot safely inspect custom-app executable mappings.')
    pid = None
    all_mappings = {}
    app_mappings = {}
    for line in files.stdout.splitlines():
        if line.startswith('p') and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith('n') and pid is not None:
            all_mappings.setdefault(pid, set()).add(line[1:])
            if custom_app_path(config, line[1:]):
                blocked.add(pid)
                app_mappings.setdefault(pid, set()).add(line[1:])
    record = transaction_record(config)
    resource_cache = {}  # Discard after this scan, including after exchanges.
    for mapped_pid, paths in app_mappings.items():
        command = rows.get(mapped_pid, (0, ''))[1]
        if safe_dock_mapping(config, command, paths, all_mappings[mapped_pid], resource_cache, record):
            blocked.discard(mapped_pid)
    # Permit only complete, byte-identical standalone CUA code. Each candidate
    # has a fresh native identity and ALL open bundle files checked, not merely
    # executable mappings. Never share a manifest cache across scans.
    candidate_aliases = [config.target, config.stage]
    if record:
        candidate_aliases.append(valid_backup_path(config, record['backup']))
        candidate_aliases.extend(retained_backup_paths(config, record))
    candidates = [pid for pid in blocked if cua_executable(rows.get(pid, (0, ''))[1], candidate_aliases)]
    if candidates:
        manifest, aliases = unchanged_cua_proof(config, record, resource_cache)
        for candidate in candidates:
            if safe_cua_process(config, candidate, rows[candidate], manifest, aliases, runner):
                blocked.discard(candidate)
    # Ignore only this activation process and its own transient inspection
    # subprocesses. The Codex GUI, embedded CLI, and other descendants must exit.
    own = {os.getpid()}
    changed = True
    while changed:
        changed = False
        for child, (parent, _) in rows.items():
            if parent in own and child not in own:
                own.add(child)
                changed = True
            if parent in blocked and child not in blocked and child not in own:
                blocked.add(child)
                changed = True
    return sorted(blocked - own)


def native_process_snapshot(runner=subprocess.run):
    result = checked_run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,uid=,stat=,lstart=,comm='], runner)
    commands = parse_process_rows(checked_run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,args='], runner).stdout)
    records = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 9)
        if len(parts) != 10 or not all(value.isdigit() for value in parts[:3]):
            continue
        pid, parent, uid = map(int, parts[:3])
        records[pid] = {'pid': pid, 'parent': parent, 'uid': uid, 'state': parts[3],
                        'started': ' '.join(parts[4:9]), 'executable': parts[9],
                        'arguments': commands.get(pid, (0, ''))[1]}
    return records


def allowed_orphan_helper(config, record, uid=None):
    if (record.get('parent') != 1 or record.get('uid') != (os.getuid() if uid is None else uid)
            or record.get('state', '').startswith('Z')):
        return False
    executable = record.get('executable', '')
    role = None
    for bundle in (config.target, config.stage):
        prefix = str(bundle) + '/'
        if not executable.startswith(prefix):
            continue
        if not Path(executable).resolve().is_relative_to(bundle.resolve()):
            continue
        relative = executable[len(prefix):]
        if relative == 'Contents/Resources/native/bare-modifier-monitor':
            role = 'modifier'
        elif re.fullmatch(r'Contents/Frameworks/Codex Framework\.framework/Versions/[0-9.]+/Helpers/browser_crashpad_handler', relative):
            role = 'crashpad'
    arguments = record.get('arguments', '')
    if role == 'modifier':
        return arguments == executable + ' --key DoubleCommand --immediate'
    if role == 'crashpad':
        database = str(config.profile / 'Crashpad')
        return (arguments.startswith(executable + ' ')
                and re.search(r'(?:^| )--database=' + re.escape(database) + r'(?: |$)', arguments) is not None
                and re.search(r'(?:^| )--annotation=prod=ChatGPT_Mac(?: |$)', arguments) is not None)
    return False


def same_process(first, second):
    keys = ('pid', 'parent', 'uid', 'started', 'executable', 'arguments')
    return first is not None and second is not None and all(first.get(key) == second.get(key) for key in keys)


def cleanup_orphan_helpers(config, blockers=process_blockers, snapshot=native_process_snapshot,
                           runner=subprocess.run, send_signal=None, clock=time.monotonic, sleep=time.sleep):
    """Clean only exact owned PPID1 native roles once every GUI/CLI is gone."""
    records = snapshot()
    active = set(blockers(config))
    candidates = {pid: records[pid] for pid in active if pid in records and allowed_orphan_helper(config, records[pid])}
    if not candidates or active - candidates.keys():
        return []  # A GUI, CLI, live-parent helper, or unknown process is active.
    # Independent mapped-binary confirmation protects against argv lookalikes.
    for pid, record in candidates.items():
        mappings = runner(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', str(pid), '-d', 'txt', '-F', 'n'],
                          capture_output=True, text=True, timeout=10)
        if mappings.returncode:
            return []
        paths = {Path(line[1:]).resolve() for line in mappings.stdout.splitlines() if line.startswith('n')}
        if Path(record['executable']).resolve() not in paths:
            return []
    active = set(blockers(config))
    if active - candidates.keys():
        return []
    # The blocker scan can take time. Read identities after that scan, then
    # refresh each candidate immediately before its signal; a disappeared or
    # reused PID must not receive the old process's SIGTERM.
    fresh = snapshot()
    for pid, record in candidates.items():
        if pid not in active:
            continue
        if not same_process(fresh.get(pid), record) or not allowed_orphan_helper(config, fresh[pid]):
            return []
    sender = os.kill if send_signal is None else send_signal
    signaled = []
    for pid in candidates:
        if pid not in active:
            continue
        current = snapshot().get(pid)
        if not same_process(current, candidates[pid]) or not allowed_orphan_helper(config, current):
            continue
        try:
            sender(pid, signal.SIGTERM)
            signaled.append(pid)
        except ProcessLookupError:
            pass
    if not signaled:
        return []
    deadline = clock() + 10
    while clock() <= deadline:
        remaining = snapshot()
        alive = [pid for pid in signaled if same_process(remaining.get(pid), candidates[pid])
                 and not remaining[pid]['state'].startswith('Z')]
        if not alive:
            return signaled
        sleep(0.25)
    raise RuntimeError('Verified detached custom-app helpers did not exit after SIGTERM; no bundle was replaced.')


def wait_until_stopped(config, timeout, blockers=process_blockers, clock=time.monotonic, sleep=time.sleep, cleanup=None):
    if cleanup is None:
        # Injected unit-test snapshots must never inspect or signal real apps.
        cleanup = cleanup_orphan_helpers if blockers is process_blockers else lambda _: []
    deadline = clock() + timeout
    quiet = 0
    while clock() <= deadline:
        active = blockers(config)
        if active:
            quiet = 0
            cleanup(config)
        else:
            quiet += 1
            if quiet >= 3:
                return
        sleep(1)
    raise RuntimeError('The custom app or its embedded CLI is still running; no in-use bundle was replaced.')


def launch_existing(config, runner=subprocess.run):
    if not config.launcher.is_file() or config.launcher.is_symlink() or not os.access(config.launcher, os.X_OK):
        raise RuntimeError('The existing permanent launcher is unavailable.')
    checked_run([str(config.launcher)], runner)


def reconcile_launch_registration(config, runner=subprocess.run):
    return reconcile_registration(config.target, config.profile, retired=(config.stage,), runner=runner)


def profile_pid(config, runner=subprocess.run):
    lock = config.profile / 'SingletonLock'
    if not lock.is_symlink():
        return None
    value = os.readlink(lock).rsplit('-', 1)[-1]
    if not value.isdigit():
        raise RuntimeError('The dedicated profile has an unexpected process lock.')
    pid = int(value)
    result = runner(['/bin/ps', '-p', str(pid), '-o', 'args='], capture_output=True, text=True, timeout=10)
    command = result.stdout.strip()
    if not command:
        return None
    native = str(config.target / 'Contents/MacOS/ChatGPT-native')
    if not command.startswith(native + ' ') or '--user-data-dir=' + str(config.profile) not in command:
        raise RuntimeError('The dedicated profile belongs to an unexpected running process.')
    return pid


def validate_startup_process(config, pid, runner=subprocess.run):
    # Read arguments separately so an updater-looking argument cannot stand in
    # for the inherited environment. Never include other environment values in
    # a report or error message.
    command = checked_run(['/bin/ps', 'ww', '-p', str(pid), '-o', 'args='], runner).stdout.strip()
    combined = checked_run(['/bin/ps', 'eww', '-p', str(pid), '-o', 'command='], runner).stdout.strip()
    if not command or not combined.startswith(command + ' '):
        raise RuntimeError('The upgraded process environment could not be verified.')
    environment = combined[len(command) + 1:]
    if 'CODEX_ELECTRON_USER_DATA_PATH=' + str(config.profile) not in environment:
        raise RuntimeError('The upgraded process is missing its dedicated profile environment.')
    updater_values = re.findall(r'(?:^|\s)CODEX_SPARKLE_ENABLED=([^\s]*)', environment)
    if updater_values != ['false']:
        raise RuntimeError('The upgraded process does not disable the host updater.')
    mappings = checked_run(['/usr/sbin/lsof', '-n', '-P', '-a', '-p', str(pid), '-d', 'txt', '-F', 'n'], runner).stdout
    native = str(config.target / 'Contents/MacOS/ChatGPT-native')
    paths = {line[1:] for line in mappings.splitlines() if line.startswith('n')}
    natives = {path for path in paths if custom_app_path(config, path)
               and path.endswith('/Contents/MacOS/ChatGPT-native')}
    if natives != {native}:
        raise RuntimeError('Startup is not running the upgraded native executable at the current app path.')
    if any('/Contents/Resources/native/sparkle.node' in path for path in paths):
        raise RuntimeError('The upgraded process loaded the disabled native updater.')


def validate_startup(config, runner=subprocess.run, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + 20
    pid = None
    while clock() < deadline:
        pid = profile_pid(config, runner)
        if pid is not None:
            break
        sleep(0.5)
    if pid is None:
        raise RuntimeError('The upgraded custom app did not start in its dedicated profile.')
    validate_startup_process(config, pid, runner)
    for _ in range(30):
        sleep(1)
        if profile_pid(config, runner) != pid:
            raise RuntimeError('The upgraded app exited during its 30-second startup check.')
    # Recheck after host initialization: a launcher argument or a freshly
    # migrated preference does not prove that the running host stayed disabled.
    validate_startup_process(config, pid, runner)
    verify_effective_preferences(runner=runner)
    if report_update_policy(config.target).get('savedPreferencesConflict') is not False:
        raise RuntimeError('The upgraded app changed its disabled updater preferences during startup.')
    return pid


@contextmanager
def activation_lock(config):
    descriptor = os.open(config.lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('A voice-upgrade activation is already waiting or running.') from None
        yield
    finally:
        os.close(descriptor)


def verify_runtime_worker(config, readiness):
    worker = config.profile.parent / 'kokoro/worker-sentences-v2.py'
    digest = readiness.get('runtimeWorkerHash')
    if (readiness.get('runtimeWorkerPath') != str(worker)
            or not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None):
        raise RuntimeError('The verified sentence worker path or SHA-256 is invalid.')
    try:
        # Refuse symlinks and inspect the opened file before reading. Nonblocking
        # open also prevents an unexpected FIFO from hanging the quit waiter.
        descriptor = os.open(worker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            metadata = os.fstat(stream.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or metadata.st_mode & 0o077):
                raise RuntimeError('The private sentence worker is not ready.')
            actual = hashlib.sha256(stream.read()).hexdigest()
    except OSError:
        raise RuntimeError('The private sentence worker is not ready.') from None
    if actual != digest:
        raise RuntimeError('The private sentence worker does not match the verified build.')


def preflight(config, verify=verify_bundle, runner=subprocess.run):
    installed = verify(config, config.target)
    staged = verify(config, config.stage, installed['CFBundleShortVersionString'], True)
    staged['_signingTransition'] = verify_signing_transition(
        config.target, config.stage, installed['_signingIdentity'], staged['_signingIdentity'], runner=runner)
    if config.verification_report.is_symlink() or not config.verification_report.is_file():
        raise RuntimeError('The staged voice-build verification report is not ready.')
    readiness = json.loads(config.verification_report.read_text())
    flags = ('signaturesVerified', 'embeddedAsarIntegrityVerified', 'permanentProfilePreserved',
             'voicePickerHooksVerified', 'selectionHighlightHooksVerified',
             'manualUpdateCheckVerified', 'realtimeReadingControlsVerified', 'persistentReadingControlsVerified')
    if (readiness.get('app') != str(config.stage.resolve(strict=True))
            or readiness.get('version') != staged['CFBundleShortVersionString']
            or readiness.get('activation') != 'staged'
            or type(staged.get('CodexReadAloudSelectionHighlightVersion')) is not int
            or staged['CodexReadAloudSelectionHighlightVersion'] != 1
            or not all(readiness.get(flag) is True for flag in flags)
            or not isinstance(readiness.get('packedAssetsVerified'), int)
            or readiness['packedAssetsVerified'] < 1
            or readiness.get('asarHeaderHash') != staged['ElectronAsarIntegrity']['Resources/app.asar']['hash']
            or readiness.get('signingIdentity') != staged['_signingIdentity']
            or readiness.get('mainModuleHash') != staged.get('_mainModuleHash')):
        raise RuntimeError('The staged voice-build verification report does not match this ready build.')
    verify_runtime_worker(config, readiness)
    # voiceChoice is an informational snapshot, not part of bundle identity.
    # Validate the current private preference against the installed voice bank;
    # preserve a valid later choice (or no choice) while waiting for user quit.
    read_saved_voice(config.profile.parent / 'kokoro')
    if config.stage.parent.stat().st_dev != config.target.parent.stat().st_dev:
        raise RuntimeError('The staged app is on another filesystem; atomic activation is unavailable.')
    checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(config.official)], runner)
    if not config.launcher.is_file() or config.launcher.is_symlink() or not os.access(config.launcher, os.X_OK):
        raise RuntimeError('The existing permanent launcher is unavailable.')
    return installed, staged


def restore_previous(config, record, previous, wait_seconds, verify, wait, blockers, launch, exchange,
                     runner=subprocess.run):
    """Reverse-exchange only after quit; the target path is never removed."""
    pending = {**record, 'status': 'rollback_waiting_for_quit', 'previousAppPath': str(previous),
               'startupPassed30Seconds': False}
    atomic_report(config, pending)
    try:
        wait(config, wait_seconds, blockers=blockers)
        if blockers(config):
            raise RuntimeError('The upgraded app is still running.')
        previous_info = verify(config, previous)
        if not matches_transaction_bundle(previous_info, record, 'previous'):
            raise RuntimeError('The previous app no longer matches the transaction identity.')
        verify(config, config.target)
        exchange(config.target, previous)
    except Exception:
        atomic_report(config, {**pending, 'status': 'rollback_pending_quit'})
        raise RuntimeError('Activation failed; quit the custom app, then run --rollback. Its previous bundle is preserved at the recorded path.') from None
    # The old app is now safely restored. Failure preserving the failed upgrade
    # must never exchange it back or remove the restored target.
    restored = {**record, 'status': 'rolled_back_recovery_pending',
                'previousAppPath': str(config.target),
                'failedUpgradePath': str(previous), 'startupPassed30Seconds': False,
                'launchRegistration': {'currentAppRegistered': False}}
    atomic_report(config, restored)
    preservation_pending = False
    if previous != config.stage:
        try:
            if config.stage.exists() or config.stage.is_symlink():
                raise RuntimeError('The staged recovery path is occupied.')
            previous.rename(config.stage)
            restored['failedUpgradePath'] = str(config.stage)
        except Exception:
            preservation_pending = True
    atomic_report(config, restored)
    try:
        restored['launchRegistration'] = reconcile_launch_registration(config, runner)
    except Exception:
        atomic_report(config, restored)
        raise RuntimeError('The previous app is restored, but launch registration needs recovery; run --rollback to retry.') from None
    if not preservation_pending:
        restored['status'] = 'rolled_back'
    atomic_report(config, restored)
    try:
        launch(config)
    except Exception:
        pass
    return restored


def migrate_update_policy(config, runner=subprocess.run):
    if config.profile != Path.home() / 'Library/Application Support/ChatGPT Read Aloud/user-data':
        raise RuntimeError('Updater migration requires the current user dedicated profile.')
    return migrate_custom_preferences(config.stage, home=Path.home(), runner=runner)


def apply_upgrade(config, wait_seconds=1800, verify=verify_bundle, blockers=process_blockers,
                  wait=wait_until_stopped, launch=launch_existing, startup=validate_startup,
                  runner=subprocess.run, exchange=None, migrate_policy=None):
    migrate_policy = migrate_update_policy if migrate_policy is None else migrate_policy
    exchange = atomic_exchange if exchange is None else exchange
    with activation_lock(config):
        prior_record = transaction_record(config, strict=True)
        if prior_record.get('status') in RECOVERY_STATES:
            raise RuntimeError('A previous activation still needs recovery; preserve its journal and run --rollback before preparing another upgrade.')
        installed, staged = preflight(config, verify, runner)
        verify_exchange_capability(exchange)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = config.target.with_name(f'ChatGPT Read Aloud.backup-{stamp}-{os.getpid()}.app.disabled')
        if backup.exists() or backup.is_symlink():
            raise RuntimeError('The reversible backup destination already exists.')
        # Read the prior private journal before replacing it. Shared-daemon CUA
        # helpers can still map an earlier successful backup across many updates.
        resource_cache = {}
        dock_hashes = unchanged_dock_hashes(config, resource_cache, prior_record)
        cua_manifest = unchanged_cua_proof(config, prior_record, resource_cache)[0]
        retained = verified_retained_resource_aliases(config, prior_record, cua_manifest, dock_hashes,
                                                      resource_cache, include_current=True)
        if len(retained) > MAX_RETAINED_RESOURCE_ALIASES:
            raise RuntimeError('Too many verified retained resource backups; no app bundle was changed.')
        record = {'status': 'waiting_for_quit', 'app': str(config.target), 'stage': str(config.stage),
                  'backup': str(backup), 'profile': str(config.profile),
                  'version': staged['CFBundleShortVersionString'],
                  'transaction': 'atomic_exchange_v1', 'previousAppPath': str(config.target),
                  'previousAsarHeaderHash': installed['ElectronAsarIntegrity']['Resources/app.asar']['hash'],
                  'stagedAsarHeaderHash': staged['ElectronAsarIntegrity']['Resources/app.asar']['hash'],
                  'previousBundleIdentityHash': installed['_bundleIdentityHash'],
                  'stagedBundleIdentityHash': staged['_bundleIdentityHash'],
                  'signingIdentity': staged['_signingIdentity'],
                  'signingTransition': staged['_signingTransition'],
                  'unchangedDockResourceHashes': dock_hashes,
                  'unchangedCuaSubtreeManifest': cua_manifest,
                  'retainedResourceBackupAliases': [str(alias) for alias in retained],
                  'shutdownMethod': 'user quit; GUI/CLI never killed; verified detached native helpers may receive SIGTERM'}
        validate_transaction_bundle_identities(record)
        atomic_report(config, record)
        try:
            wait(config, wait_seconds, blockers=blockers)
        except Exception:
            atomic_report(config, {**record, 'status': 'wait_expired'})
            raise
        # Repeat all identity/signature checks after waiting, then inspect once
        # more immediately before the native atomic exchange.
        try:
            current_installed, current_staged = preflight(config, verify, runner)
            if (not matches_transaction_bundle(current_installed, record, 'previous')
                    or not matches_transaction_bundle(current_staged, record, 'staged')):
                raise RuntimeError('A verified app bundle changed while waiting; recheck the staged upgrade.')
            if blockers(config):
                raise RuntimeError('The custom app restarted; no in-use bundle was replaced.')
            record['updaterPolicyMigration'] = migrate_policy(config, runner)
            if blockers(config):
                raise RuntimeError('The custom app restarted during updater migration; no bundle was replaced.')
            # Retire an enabled stage registration while its signed bundle is
            # still present. After exchange/rename, LaunchServices may retain
            # that pathname; a disabled stale record needs no missing-file guess.
            record['preExchangeLaunchRegistration'] = reconcile_launch_registration(config, runner)
            atomic_report(config, record)
            if blockers(config):
                raise RuntimeError('The custom app restarted during pre-exchange launch registration; no bundle was replaced.')
        except Exception:
            atomic_report(config, {**record, 'status': 'recheck_failed'})
            raise
        exchanged = False
        previous = config.stage
        try:
            record.update(status='exchanging', plannedPreviousAppPath=str(config.stage))
            atomic_report(config, record)
            exchange(config.target, config.stage)
            exchanged = True
            record.update(status='exchanged', previousAppPath=str(config.stage))
            atomic_report(config, record)
            # A GUI racing the final pre-swap scan may now map the old stage or
            # the new target. Either remains a blocker; recovery waits for quit.
            if blockers(config):
                raise RuntimeError('The custom app restarted during the atomic exchange.')
            config.stage.rename(backup)
            previous = backup
            record.update(status='verifying_startup', previousAppPath=str(backup))
            atomic_report(config, record)
            verify(config, config.target, installed['CFBundleShortVersionString'], True)
            if blockers(config):
                raise RuntimeError('The custom app restarted before upgraded startup validation.')
            record['launchRegistration'] = reconcile_launch_registration(config, runner)
            atomic_report(config, record)
            if blockers(config):
                raise RuntimeError('The custom app restarted during launch registration.')
            launch(config)
            pid = startup(config)
            checked_run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(config.official)], runner)
            record.update(status='activated', pid=pid, startupPassed30Seconds=True,
                          originalAppSignatureVerified=True)
            atomic_report(config, record)
            return record
        except Exception:
            if exchanged:
                restore_previous(config, record, previous, wait_seconds, verify, wait, blockers, launch, exchange, runner)
            else:
                atomic_report(config, {**record, 'status': 'exchange_failed', 'previousAppPath': str(config.target)})
            raise RuntimeError('Voice-upgrade activation failed; the previous app was restored when safe.') from None


def rollback_saved(config, wait_seconds=1800, verify=verify_bundle,
                   wait=wait_until_stopped, blockers=process_blockers, launch=launch_existing, exchange=None,
                   runner=subprocess.run):
    exchange = atomic_exchange if exchange is None else exchange
    with activation_lock(config):
        record = transaction_record(config, strict=True)
        if record.get('status') not in RECOVERY_STATES:
            raise RuntimeError('There is no pending rollback for this custom app.')
        verify_exchange_capability(exchange)
        backup = valid_backup_path(config, record['backup'])
        current = verify(config, config.target)
        if matches_transaction_bundle(current, record, 'previous'):
            # Reverse exchange succeeded, but preserving the failed upgrade was
            # interrupted. The safe old target remains in place throughout.
            failed = Path(record.get('failedUpgradePath', str(backup)))
            if failed not in (config.stage, backup):
                raise RuntimeError('Unexpected failed-upgrade recovery path.')
            if failed != config.stage and failed.exists():
                verify(config, failed)
                wait(config, wait_seconds, blockers=blockers)
                if blockers(config) or config.stage.exists() or config.stage.is_symlink():
                    raise RuntimeError('The app is running or its recovery staging path is occupied.')
                failed.rename(config.stage)
            restored = {**record, 'status': 'rolled_back_recovery_pending', 'previousAppPath': str(config.target),
                        'failedUpgradePath': str(config.stage), 'startupPassed30Seconds': False,
                        'launchRegistration': {'currentAppRegistered': False}}
            atomic_report(config, restored)
            restored['launchRegistration'] = reconcile_launch_registration(config, runner)
            restored['status'] = 'rolled_back'
            atomic_report(config, restored)
            launch(config)
            return
        # Recorded reports can precede a successful backup rename or reverse
        # exchange. Locate the verified old bundle by hash, never by a wildcard.
        previous = None
        for candidate in (config.stage, backup):
            if candidate.exists() and not candidate.is_symlink():
                info = verify(config, candidate)
                if matches_transaction_bundle(info, record, 'previous'):
                    previous = candidate
                    break
        if previous is None:
            raise RuntimeError('The verified previous app is not at a transaction recovery path.')
        restore_previous(config, record, previous, wait_seconds, verify, wait, blockers, launch, exchange, runner)


def schedule_detached(config, wait_seconds):
    # Fail before detaching or asking the user to quit when an existing
    # transaction needs recovery. Release the lock before fork: the child
    # acquires its own lock and repeats this check in apply_upgrade.
    with activation_lock(config):
        record = transaction_record(config, strict=True)
        if record.get('status') in RECOVERY_STATES:
            raise RuntimeError('A previous activation still needs recovery; preserve its journal and run --rollback before preparing another upgrade.')
        preflight(config)
        verify_exchange_capability(atomic_exchange)
    executable = Path(sys.executable).resolve(strict=True)
    if any(executable.is_relative_to(root.resolve()) for root in (config.target, config.stage)):
        raise RuntimeError('Run the activation script with a system Python outside the custom app.')
    read_pipe, write_pipe = os.pipe()
    first = os.fork()
    if first == 0:
        os.close(read_pipe)
        try:
            os.setsid()
            second = os.fork()
            if second != 0:
                os._exit(0)
            output = os.open(config.log, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            null = os.open(os.devnull, os.O_RDONLY)
            os.dup2(null, 0)
            os.dup2(output, 1)
            os.dup2(output, 2)
            os.write(write_pipe, str(os.getpid()).encode('ascii'))
            os.close(write_pipe)
            os.closerange(3, os.sysconf('SC_OPEN_MAX'))
            os.execv(str(executable), [str(executable), str(Path(__file__).resolve()),
                                     '--apply', '--wait-seconds', str(wait_seconds)])
        except Exception:
            os._exit(1)
    os.close(write_pipe)
    value = os.read(read_pipe, 32)
    os.close(read_pipe)
    os.waitpid(first, 0)
    if not value.isdigit():
        raise RuntimeError('Unable to detach the one-shot activation waiter.')
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--check', action='store_true', help='Verify staged bundle without changing or launching apps (default)')
    actions.add_argument('--schedule', action='store_true', help='Detach a bounded waiter, then quit ChatGPT Read Aloud normally')
    actions.add_argument('--apply', action='store_true', help='Wait in this process for user quit, then activate')
    actions.add_argument('--rollback', action='store_true', help='Finish a recorded rollback after the custom app has quit')
    parser.add_argument('--wait-seconds', type=int, default=1800)
    args = parser.parse_args()
    if not 10 <= args.wait_seconds <= 3600:
        parser.error('--wait-seconds must be between 10 and 3600')
    config = Config()
    try:
        if args.schedule:
            pid = schedule_detached(config, args.wait_seconds)
            print(f'One-shot waiter {pid} is ready. Quit ChatGPT Read Aloud normally; it will upgrade and reopen after all its processes exit.', flush=True)
        elif args.apply:
            result = apply_upgrade(config, args.wait_seconds)
            print(f'Voice upgrade activated. Startup passed 30 seconds. Previous app preserved at {result["backup"]}.', flush=True)
        elif args.rollback:
            rollback_saved(config, args.wait_seconds)
            print('Previous custom app restored and reopened.', flush=True)
        else:
            preflight(config)
            print('Staged voice upgrade and existing profile launcher verified. No app changed or launched.', flush=True)
    except Exception as error:
        # All subprocess output stays captured. These deliberately bounded
        # local messages never contain chat responses or raw app diagnostics.
        print(str(error)[:500], file=sys.stderr, flush=True)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
