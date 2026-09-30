#!/usr/bin/env python3
"""Create a pinned private runtime, or add an explicitly verified v2 worker without replacing existing files."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import uuid
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SUPPORT = Path('Library/Application Support/ChatGPT Read Aloud')
WORKER_NAME = 'worker-sentences-v2.py'
WORKER_PROTOCOL_VERSION = 2
WORKER_MIGRATION_NAME = 'worker-v2-installation.json'
ASSET_PATHS = {'models/mlx/model.safetensors', 'models/mlx/config.json', 'models/voices-v1.0.bin'}


def require_platform(system=None, machine=None, version=None):
    if (system or platform.system()) != 'Darwin' or (machine or platform.machine()) != 'arm64':
        raise RuntimeError('This runtime requires native Apple Silicon macOS, not Intel or Rosetta.')
    version = platform.mac_ver()[0] if version is None else version
    if not version.split('.')[0].isdigit() or int(version.split('.')[0]) < 26:
        raise RuntimeError('The pinned MLX wheels require macOS26 or newer.')


def ensure_home_directory(home, relative, private=False):
    """Create only missing owned directories; reject symlink ancestors."""
    home = Path(home).absolute()
    if home.is_symlink() or not home.is_dir():
        raise RuntimeError('Expected a regular home directory.')
    cursor = home
    for part in Path(relative).parts:
        if part in ('', '.', '..') or Path(part).is_absolute():
            raise RuntimeError('Unexpected private directory path.')
        cursor = cursor / part
        try:
            cursor.mkdir(mode=0o700)
        except FileExistsError:
            pass
        metadata = cursor.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022):
            raise RuntimeError('A home directory component is symlinked, unowned, or writable by others.')
    if private and cursor.stat().st_mode & 0o077:
        raise RuntimeError('The existing Read Aloud support directory must be private (mode0700).')
    return cursor


@contextmanager
def regular_input(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError('Expected a regular, nonsymlinked local input file.')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None
            yield stream
    finally:
        if descriptor is not None:
            os.close(descriptor)


def file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with regular_input(path) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def load_manifest(path=ROOT / 'runtime/assets.json'):
    with regular_input(path) as stream:
        manifest = json.load(stream)
    assets = manifest.get('assets') if isinstance(manifest, dict) else None
    if (not isinstance(manifest, dict) or manifest.get('version') != 1 or manifest.get('engine') != 'mlx'
            or manifest.get('dtype') != 'float32' or not isinstance(assets, list)
            or {asset.get('path') for asset in assets if isinstance(asset, dict)} != ASSET_PATHS
            or len(assets) != len(ASSET_PATHS)):
        raise RuntimeError('Unexpected pinned runtime manifest.')
    for asset in assets:
        if (not isinstance(asset, dict) or type(asset.get('size')) is not int or asset['size'] <= 0
                or not isinstance(asset.get('sha256'), str) or re.fullmatch('[0-9a-f]{64}', asset['sha256']) is None
                or not isinstance(asset.get('cacheName'), str) or Path(asset['cacheName']).name != asset['cacheName']
                or asset['cacheName'] in ('', '.', '..') or not isinstance(asset.get('url'), str)
                or not asset['url'].startswith(('https://huggingface.co/', 'https://github.com/'))):
            raise RuntimeError('Unexpected pinned asset metadata.')
    return manifest


def checked_run(arguments, runner=subprocess.run):
    result = runner([str(value) for value in arguments], check=True, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('A runtime setup command failed.')
    return result


def verify_python(python, runner=subprocess.run):
    result = checked_run([python, '-c', 'import json,platform,sys;print(json.dumps({"version":list(sys.version_info[:2]),"machine":platform.machine(),"system":platform.system()}))'], runner)
    metadata = json.loads(result.stdout)
    if metadata != {'version': [3, 13], 'machine': 'arm64', 'system': 'Darwin'}:
        raise RuntimeError('Use a native arm64 Python3.13 interpreter for the locked wheels.')


def write_private(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(content)


def install_asset(asset, runtime, asset_cache=None, opener=urlopen):
    target = runtime / asset['path']
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = None if asset_cache is None else Path(asset_cache) / asset['cacheName']
    if asset_cache is not None and (Path(asset_cache).is_symlink() or not Path(asset_cache).is_dir()):
        raise RuntimeError('The asset cache must be a regular directory.')
    stream_context = regular_input(source) if source is not None else opener(asset['url'], timeout=30)
    digest = hashlib.sha256()
    size = 0
    created = False
    try:
        with stream_context as stream:
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            created = True
            with os.fdopen(descriptor, 'wb') as output:
                os.fchmod(output.fileno(), 0o600)
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    size += len(chunk)
                    if size > asset['size']:
                        raise RuntimeError('A model asset exceeds its pinned size.')
                    digest.update(chunk)
                    output.write(chunk)
        if size != asset['size'] or digest.hexdigest() != asset['sha256']:
            raise RuntimeError('A model asset does not match its pinned size and SHA256.')
    except Exception:
        # This destination is inside the exclusively created private runtime.
        # Never delete an existing cache or a symlink presented as a source.
        if created and target.exists() and not target.is_symlink():
            target.unlink()
        raise


def private_input(path, read=True):
    with regular_input(path) as stream:
        metadata = os.fstat(stream.fileno())
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise RuntimeError('Existing runtime files must be private and owned by the current user.')
        return stream.read() if read else None


def existing_runtime(home):
    """Validate an existing path without creating or repairing any directory."""
    home = Path(home).absolute()
    cursor = home
    components = [()] + [(part,) for part in (SUPPORT / 'kokoro').parts]
    for parts in components:
        cursor = cursor.joinpath(*parts)
        metadata = cursor.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022):
            raise RuntimeError('An existing runtime directory is symlinked, unowned, or writable by others.')
        if cursor in (home / SUPPORT, home / SUPPORT / 'kokoro') and metadata.st_mode & 0o077:
            raise RuntimeError('The existing Read Aloud runtime must remain private (mode0700).')
    return cursor


def regular_runtime_directories(runtime, relative):
    cursor = runtime
    for component in Path(relative).parts:
        cursor /= component
        metadata = cursor.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022):
            raise RuntimeError('An existing runtime subdirectory is symlinked, unowned, or writable by others.')


def publish_worker_upgrade(runtime, worker_bytes, metadata_bytes, runtime_identity):
    """Publish prepared private files exclusively through an anchored directory."""
    descriptor = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary, published = {}, {}
    contents = ((WORKER_MIGRATION_NAME, metadata_bytes), (WORKER_NAME, worker_bytes))

    def same_identity(metadata, identity):
        return (metadata.st_dev, metadata.st_ino) == identity

    def remove_owned(name, identity):
        try:
            metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISREG(metadata.st_mode) and same_identity(metadata, identity):
                os.unlink(name, dir_fd=descriptor)
        except FileNotFoundError:
            pass

    try:
        if not same_identity(os.fstat(descriptor), runtime_identity):
            raise RuntimeError('The runtime directory changed during worker verification.')
        for target, content in contents:
            name = '.worker-v2-' + uuid.uuid4().hex
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            identity = os.fstat(fd)
            temporary[name] = (identity.st_dev, identity.st_ino)
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            # Both files are fully written before either becomes visible.
        if not same_identity(runtime.lstat(), runtime_identity):
            raise RuntimeError('The runtime directory changed during worker preparation.')
        for (target, _), (name, identity) in zip(contents, temporary.items()):
            os.link(name, target, src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
            published[target] = identity
        if not same_identity(runtime.lstat(), runtime_identity):
            raise RuntimeError('The runtime directory changed during worker publication.')
    except BaseException:
        for name, identity in published.items():
            remove_owned(name, identity)
        raise
    finally:
        for name, identity in temporary.items():
            remove_owned(name, identity)
        os.close(descriptor)


def upgrade_worker(home=None, expected_worker_hash=None, manifest_path=ROOT / 'runtime/assets.json',
                   requirements=ROOT / 'runtime/requirements.lock', worker_source=ROOT / 'kokoro_worker.py'):
    """Add protocol v2 only to a completed, recorded and unchanged pinned runtime."""
    require_platform()
    if not isinstance(expected_worker_hash, str) or re.fullmatch('[0-9a-f]{64}', expected_worker_hash) is None:
        raise RuntimeError('Worker upgrade requires --worker-sha256 with the reviewed candidate SHA256.')
    runtime = existing_runtime(Path.home() if home is None else home)
    identity = runtime.lstat()
    runtime_identity = (identity.st_dev, identity.st_ino)
    manifest = load_manifest(manifest_path)
    _, requirements_hash = file_digest(requirements)
    with regular_input(worker_source) as stream:
        worker_bytes = stream.read(1024 * 1024 + 1)
    worker_hash = hashlib.sha256(worker_bytes).hexdigest()
    if not worker_bytes or len(worker_bytes) > 1024 * 1024 or worker_hash != expected_worker_hash:
        raise RuntimeError('The worker source does not match the reviewed candidate SHA256.')
    installation_bytes = private_input(runtime / 'installation.json')
    installation = json.loads(installation_bytes)
    if (not isinstance(installation, dict) or type(installation.get('version')) is not int or installation['version'] != 1
            or installation.get('assets') != manifest['assets'] or installation.get('requirementsHash') != requirements_hash
            or not isinstance(installation.get('workerHash'), str)
            or re.fullmatch('[0-9a-f]{64}', installation['workerHash']) is None):
        raise RuntimeError('The recorded installation does not match the pinned requirements and model assets.')
    old_name = installation.get('workerName', 'worker-sentences-v1.py')
    if (old_name not in ('worker-sentences-v1.py', WORKER_NAME)
            or (old_name == WORKER_NAME and (type(installation.get('protocolVersion')) is not int
                                            or installation['protocolVersion'] != WORKER_PROTOCOL_VERSION))):
        raise RuntimeError('The recorded worker identity or protocol is unsupported.')
    old_bytes = private_input(runtime / old_name)
    if hashlib.sha256(old_bytes).hexdigest() != installation['workerHash']:
        raise RuntimeError('The recorded original worker hash does not match the installed file.')
    if json.loads(private_input(runtime / 'engine.json')) != {'engine': 'mlx', 'dtype': 'float32'}:
        raise RuntimeError('The existing runtime must use the pinned MLX float32 engine.')
    settings = json.loads(private_input(runtime / 'settings.json'))
    if (not isinstance(settings, dict) or type(settings.get('version')) is not int or settings['version'] != 1
            or 'selectedVoice' not in settings or (settings['selectedVoice'] is not None
            and (not isinstance(settings['selectedVoice'], str)
                 or re.fullmatch(r'(?:af|am|bf|bm)_[a-z0-9]+', settings['selectedVoice']) is None))):
        raise RuntimeError('Unexpected saved reading voice; no settings were changed.')
    regular_runtime_directories(runtime, '.venv/bin')
    interpreter = runtime / '.venv/bin/python'
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise RuntimeError('The existing isolated interpreter is missing.')
    for asset in manifest['assets']:
        regular_runtime_directories(runtime, Path(asset['path']).parent)
        target = runtime / asset['path']
        private_input(target, read=False)
        if file_digest(target) != (asset['size'], asset['sha256']):
            raise RuntimeError('An existing model asset failed pinned size and SHA256 verification.')
    installed_lock = runtime / 'requirements.lock'
    if installed_lock.exists() or installed_lock.is_symlink():
        if hashlib.sha256(private_input(installed_lock)).hexdigest() != requirements_hash:
            raise RuntimeError('The installed requirements snapshot does not match the pinned source.')
    target = runtime / WORKER_NAME
    if target.exists() or target.is_symlink():
        if hashlib.sha256(private_input(target)).hexdigest() != worker_hash:
            raise RuntimeError('A different v2 worker already exists; refusing to overwrite it.')
        return runtime  # Matching v2 is an intentional no-write no-op.
    migration = runtime / WORKER_MIGRATION_NAME
    if migration.exists() or migration.is_symlink():
        raise RuntimeError('Worker migration metadata already exists without its worker; refusing to overwrite it.')
    # Retain the exact reviewed snapshot, and reject a source/lock change while
    # validating large assets. Old files and installed packages are never run.
    if file_digest(worker_source)[1] != worker_hash or file_digest(requirements)[1] != requirements_hash:
        raise RuntimeError('A pinned source changed during worker upgrade verification.')
    if (private_input(runtime / 'installation.json') != installation_bytes
            or hashlib.sha256(private_input(runtime / old_name)).hexdigest() != installation['workerHash']):
        raise RuntimeError('The original runtime record or worker changed during upgrade verification.')
    metadata = {'version': 1, 'workerName': WORKER_NAME, 'protocolVersion': WORKER_PROTOCOL_VERSION,
                'workerHash': worker_hash, 'previousWorkerName': old_name,
                'previousWorkerHash': installation['workerHash'], 'requirementsHash': requirements_hash,
                'assets': manifest['assets']}
    publish_worker_upgrade(runtime, worker_bytes, (json.dumps(metadata, indent=2) + '\n').encode(), runtime_identity)
    return runtime


def setup_runtime(home=None, python=None, asset_cache=None, runner=subprocess.run, opener=urlopen,
                  manifest_path=ROOT / 'runtime/assets.json', requirements=ROOT / 'runtime/requirements.lock',
                  worker_source=ROOT / 'kokoro_worker.py'):
    require_platform()
    home = Path.home() if home is None else Path(home)
    runtime = home / SUPPORT / 'kokoro'
    if runtime.exists() or runtime.is_symlink():
        raise RuntimeError('The speech runtime already exists; refusing to overwrite it or its voice settings.')
    manifest = load_manifest(manifest_path)
    # Validate regular sources before creating a runtime or running package code.
    with regular_input(requirements) as stream:
        requirements_bytes = stream.read()
    requirements_hash = hashlib.sha256(requirements_bytes).hexdigest()
    _, worker_hash = file_digest(worker_source)
    python = python or (sys.executable if sys.version_info[:2] == (3, 13) else shutil.which('python3.13'))
    if not python:
        raise RuntimeError('Install native Python3.13 first, or pass --python /path/to/python3.13.')
    verify_python(python, runner)
    ensure_home_directory(home, SUPPORT, private=True)
    runtime.mkdir(mode=0o700)  # Exclusive; a racing installation cannot be overwritten.
    identity = runtime.stat()
    try:
        print('Creating isolated Python3.13 environment...', flush=True)
        checked_run([python, '-m', 'venv', runtime / '.venv'], runner)
        interpreter = runtime / '.venv/bin/python'
        locked_requirements = runtime / 'requirements.lock'
        write_private(locked_requirements, requirements_bytes)
        checked_run([interpreter, '-m', 'pip', '--isolated', 'install', '--require-hashes', '--no-deps',
                     '--only-binary=:all:', '-r', locked_requirements], runner)
        for asset in manifest['assets']:
            print('Verifying local asset: ' + asset['cacheName'] if asset_cache else 'Downloading pinned asset: ' + asset['cacheName'], flush=True)
            install_asset(asset, runtime, asset_cache, opener)
        with regular_input(worker_source) as stream:
            worker_bytes = stream.read()
        if hashlib.sha256(worker_bytes).hexdigest() != worker_hash:
            raise RuntimeError('The worker source changed during setup.')
        write_private(runtime / WORKER_NAME, worker_bytes)
        write_private(runtime / 'engine.json', b'{"engine":"mlx","dtype":"float32"}\n')
        write_private(runtime / 'settings.json', b'{"version":1,"selectedVoice":null}\n')
        # Check imports and the local voice bank without loading a model or
        # generating audio. No worker process or GPU inference is started here.
        checked_run([interpreter, '-c', 'import numpy as np;import mlx.core as mx;from kokoro_onnx.tokenizer import Tokenizer;from mlx_audio.tts.models.kokoro.kokoro import Model,ModelConfig;bank=np.load("models/voices-v1.0.bin",allow_pickle=False)\nif "af_aoede" not in bank.files or not mx.metal.is_available(): raise RuntimeError("Pinned voice bank or Metal GPU is unavailable")'],
                    lambda arguments, **kwargs: runner(arguments, cwd=str(runtime), **kwargs))
        write_private(runtime / 'installation.json', (json.dumps({'version': 1, 'assets': manifest['assets'],
                      'requirementsHash': requirements_hash, 'workerHash': worker_hash,
                      'workerName': WORKER_NAME, 'protocolVersion': WORKER_PROTOCOL_VERSION}, indent=2) + '\n').encode())
        return runtime
    except BaseException:
        # Clean only this setup's directory if its identity still matches.
        try:
            current = runtime.lstat()
            if stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                shutil.rmtree(runtime)
        except OSError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', help='Native arm64 Python3.13 interpreter (default: current3.13 or python3.13 in PATH)')
    parser.add_argument('--asset-cache', type=Path, help='Read-only directory with all three pinned files; no asset downloads')
    parser.add_argument('--upgrade-worker', action='store_true', help='Add the reviewed v2 worker to a recorded existing runtime; do not recreate dependencies or change voice settings')
    parser.add_argument('--worker-sha256', help='Required with --upgrade-worker: reviewed candidate kokoro_worker.py SHA256')
    args = parser.parse_args()
    if args.upgrade_worker and (args.python is not None or args.asset_cache is not None):
        parser.error('--upgrade-worker does not accept --python or --asset-cache; it uses and preserves the existing runtime.')
    if args.worker_sha256 is not None and not args.upgrade_worker:
        parser.error('--worker-sha256 is only used with --upgrade-worker.')
    try:
        runtime = (upgrade_worker(expected_worker_hash=args.worker_sha256) if args.upgrade_worker
                   else setup_runtime(python=args.python, asset_cache=args.asset_cache))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
    print('Private speech runtime ready: ' + str(runtime))
    print('Existing runtime and voice settings preserved; no app was restarted.' if args.upgrade_worker
          else 'No reading voice is selected. Choose one with previews in the installed app.')


if __name__ == '__main__':
    main()
