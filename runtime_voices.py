"""Read pinned local voice names and the current private choice without inference."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parent


def supported_voice_ids(runtime, manifest=None):
    manifest = ROOT / 'runtime/assets.json' if manifest is None else Path(manifest)
    assets = json.loads(manifest.read_text())['assets']
    banks = [a for a in assets if a.get('path') == 'models/voices-v1.0.bin']
    if len(banks) != 1:
        raise RuntimeError('The pinned voice bank identity is unavailable.')
    bank = Path(runtime) / 'models/voices-v1.0.bin'
    descriptor = os.open(bank, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise RuntimeError('The voice bank must be an owned regular file.')
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        if metadata.st_size != banks[0]['size'] or digest.hexdigest() != banks[0]['sha256']:
            raise RuntimeError('The voice bank does not match the pinned assets.')
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            names = archive.namelist()
    voices = {name[:-4] for name in names if re.fullmatch(r'(?:af|am|bf|bm)_[a-z0-9]+\.npy', name)}
    if not voices:
        raise RuntimeError('The pinned voice bank contains no supported voices.')
    return frozenset(voices)


def read_saved_voice(runtime, voices=None):
    """Absent/null is a deliberate no-choice state; malformed settings fail closed."""
    path = Path(runtime) / 'settings.json'
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o077):
            raise RuntimeError('The reading-voice settings must be private, owned and regular.')
        if metadata.st_size > 4096:
            raise RuntimeError('The reading-voice settings are unexpectedly large.')
        try:
            settings = json.load(stream)
        except (ValueError, UnicodeError):
            raise RuntimeError('The reading-voice settings are invalid.') from None
    if (not isinstance(settings, dict) or type(settings.get('version')) is not int
            or settings['version'] != 1 or 'selectedVoice' not in settings):
        raise RuntimeError('The reading-voice settings are invalid.')
    voice = settings['selectedVoice']
    if voice is None:
        return None
    voices = supported_voice_ids(runtime) if voices is None else voices
    if not isinstance(voice, str) or voice not in voices:
        raise RuntimeError('The saved reading voice is not supported by the pinned voice bank.')
    return voice
