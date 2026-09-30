"""Maintain Electron's embedded ASAR integrity dictionary digest.

Electron stores a digest of ElectronAsarIntegrity in its framework binary. Updating
the plist alone leaves that digest stale. This helper updates the existing v1
slot and preserves its enabled flag; it refuses an unexpected binary or plist.

Reference: electron/shell/common/asar/integrity_digest.mm.
"""

import hashlib
import hmac
import os
from pathlib import Path
import stat
import tempfile


SENTINEL = b"AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A"
DIGEST_SIZE = 32
SLOT_SIZE = len(SENTINEL) + 2 + DIGEST_SIZE


def integrity_dictionary_digest(integrity):
    """Hash sorted path, algorithm, and hash UTF-8 bytes exactly as Electron does.

    The installed app uses ASCII relative paths. Reject other path encodings so
    Python's ordering cannot diverge from NSString's NSLiteralSearch ordering.
    """
    if not isinstance(integrity, dict) or not integrity:
        raise ValueError("Expected a nonempty ElectronAsarIntegrity dictionary")
    for path, entry in integrity.items():
        if not isinstance(path, str) or not path.isascii():
            raise ValueError("Expected ASCII ASAR relative paths")
        if not isinstance(entry, dict):
            raise ValueError("Expected an ASAR integrity entry dictionary")
        for key in ("algorithm", "hash"):
            if not isinstance(entry.get(key), str):
                raise ValueError(f"Expected an ASAR integrity {key} string")
    digest = hashlib.sha256()
    for path in sorted(integrity):
        entry = integrity[path]
        for value in (path, entry["algorithm"], entry["hash"]):
            digest.update(value.encode("utf-8"))
    return digest.digest()


def patch_integrity_slot(binary, original_integrity, updated_integrity):
    """Return patched binary bytes after validating the original enabled v1 slot."""
    if binary.count(SENTINEL) != 1:
        raise ValueError("Expected exactly one Electron ASAR integrity sentinel")
    start = binary.index(SENTINEL)
    if start + SLOT_SIZE > len(binary):
        raise ValueError("Truncated Electron ASAR integrity slot")
    flags = start + len(SENTINEL)
    if binary[flags:flags + 2] != b"\x01\x01":
        raise ValueError("Expected an enabled version 1 ASAR integrity slot")
    digest_start = flags + 2
    digest_end = digest_start + DIGEST_SIZE
    original_digest = integrity_dictionary_digest(original_integrity)
    if not hmac.compare_digest(binary[digest_start:digest_end], original_digest):
        raise ValueError("Original plist and embedded ASAR integrity digest disagree")
    updated_digest = integrity_dictionary_digest(updated_integrity)
    return binary[:digest_start] + updated_digest + binary[digest_end:]


def rewrite_embedded_integrity(binary_path, original_integrity, updated_integrity):
    """Atomically update a copied framework binary, preserving executable mode."""
    binary_path = Path(binary_path).resolve(strict=True)
    original_stat = binary_path.stat()
    if not stat.S_ISREG(original_stat.st_mode):
        raise ValueError("Expected a regular framework binary")
    patched = patch_integrity_slot(
        binary_path.read_bytes(), original_integrity, updated_integrity
    )
    descriptor, staged_path = tempfile.mkstemp(
        prefix=f".{binary_path.name}.integrity-", dir=binary_path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(patched)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(staged_path, stat.S_IMODE(original_stat.st_mode))
        os.replace(staged_path, binary_path)
    finally:
        if os.path.exists(staged_path):
            os.unlink(staged_path)
