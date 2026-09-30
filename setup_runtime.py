#!/usr/bin/env python3
"""Create a new private, pinned Apple Silicon speech runtime; never overwrite one."""
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
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SUPPORT = Path('Library/Application Support/ChatGPT Read Aloud')
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
    _, requirements_hash = file_digest(requirements)
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
        checked_run([interpreter, '-m', 'pip', '--isolated', 'install', '--require-hashes', '--no-deps',
                     '--only-binary=:all:', '-r', requirements], runner)
        for asset in manifest['assets']:
            print('Verifying local asset: ' + asset['cacheName'] if asset_cache else 'Downloading pinned asset: ' + asset['cacheName'], flush=True)
            install_asset(asset, runtime, asset_cache, opener)
        with regular_input(worker_source) as stream:
            worker_bytes = stream.read()
        if hashlib.sha256(worker_bytes).hexdigest() != worker_hash:
            raise RuntimeError('The worker source changed during setup.')
        write_private(runtime / 'worker-sentences-v1.py', worker_bytes)
        write_private(runtime / 'engine.json', b'{"engine":"mlx","dtype":"float32"}\n')
        write_private(runtime / 'settings.json', b'{"version":1,"selectedVoice":null}\n')
        # Check imports and the local voice bank without loading a model or
        # generating audio. No worker process or GPU inference is started here.
        checked_run([interpreter, '-c', 'import numpy as np;import mlx.core as mx;from kokoro_onnx.tokenizer import Tokenizer;from mlx_audio.tts.models.kokoro.kokoro import Model,ModelConfig;bank=np.load("models/voices-v1.0.bin",allow_pickle=False);assert "af_aoede" in bank.files;assert mx.metal.is_available()'],
                    lambda arguments, **kwargs: runner(arguments, cwd=str(runtime), **kwargs))
        write_private(runtime / 'installation.json', (json.dumps({'version': 1, 'assets': manifest['assets'],
                      'requirementsHash': requirements_hash, 'workerHash': worker_hash}, indent=2) + '\n').encode())
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
    args = parser.parse_args()
    try:
        runtime = setup_runtime(python=args.python, asset_cache=args.asset_cache)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
    print('Private speech runtime ready: ' + str(runtime))
    print('No reading voice is selected. Choose one with previews in the installed app.')


if __name__ == '__main__':
    main()
