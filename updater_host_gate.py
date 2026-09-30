"""Verify the inspected host updater opt-out in ChatGPT 26.928.20755.

The native launcher must set CODEX_SPARKLE_ENABLED=false before Electron starts.
These byte hashes bind that setting to the host's startup and lazy-init guards;
they are deliberately not a best-effort match against an unknown app version.
"""
import hashlib
from pathlib import Path

HOST_GATE_ENV = 'CODEX_SPARKLE_ENABLED'
HOST_GATE_DISABLED_VALUE = 'false'
HOST_GATE_ASSETS = {
    '.vite/build/build-flavor-IWwoo-v9.js': 'a23029482b1a5b16b6e049bce139f02b9ce038b1f1f58af4730ffdf2c26bef58',
    '.vite/build/bootstrap-ClH9X4Aa.js': 'd152df26e2ec31fb745335b9684c577d1c592a65611fb45c2be4a37682284944',
}
MAX_HOST_GATE_ASSET_BYTES = 4 * 1024 * 1024
HOST_GATE_ANCHORS = {
    '.vite/build/build-flavor-IWwoo-v9.js': (
        b'u=e=>e.CODEX_SPARKLE_ENABLED===`false`,d=(e,t,n,r)=>!u(r)&&c.includes(e)&&t===n',
        b'shouldIncludeSparkle(e,t,n=process.env){return d(e,t,`darwin`,n)}',
        b'shouldIncludeUpdater(e,t,n=process.env){return m.shouldIncludeSparkle(e,t,n)||m.shouldIncludeWindowsUpdater(e,t,n)||m.shouldIncludeLinuxPackageUpdater(e,t,n)}',
    ),
    '.vite/build/bootstrap-ClH9X4Aa.js': (
        b'enableUpdater:u.t.shouldIncludeUpdater(f,process.platform,process.env)',
        b'async initialize(){if(!this.options.enableUpdater){this.lastUnavailableReason=process.platform!==`darwin`&&process.platform!==`win32`?`unsupported platform`:`disabled for build flavor (${this.options.buildFlavor})`,this.inAppUpdatesLaunchPolicyResolution.resolve(void 0);return}',
        b'initializeUpdater(){return this.options.enableUpdater?(this.updaterInitialization??=this.initializeUpdaterOnce(),this.updaterInitialization):Promise.resolve()}',
    ),
}


def validate_host_gate_assets(assets):
    """Validate path->bytes and return a JSON-safe host-gate evidence dictionary.

    Keys: environmentVariable, requiredValue, assetHashes, startupGateVerified,
    lazyInitializationGateVerified. This verifies support in the bundle, not the
    environment or loaded state of an already-running process.
    """
    if not isinstance(assets, dict):
        raise RuntimeError('Host updater gate assets must be a dictionary.')
    for path, expected in HOST_GATE_ASSETS.items():
        content = assets.get(path)
        if not isinstance(content, bytes) or not 0 < len(content) <= MAX_HOST_GATE_ASSET_BYTES:
            raise RuntimeError(f'Host updater gate asset is missing or oversized: {path}')
        if hashlib.sha256(content).hexdigest() != expected:
            raise RuntimeError(f'Host updater gate asset differs from the inspected app version: {path}')
        if any(content.count(anchor) != 1 for anchor in HOST_GATE_ANCHORS[path]):
            raise RuntimeError(f'Host updater gate wiring is missing or ambiguous: {path}')
    return {
        'environmentVariable': HOST_GATE_ENV,
        'requiredValue': HOST_GATE_DISABLED_VALUE,
        'assetHashes': dict(HOST_GATE_ASSETS),
        'startupGateVerified': True,
        'lazyInitializationGateVerified': True,
    }


def verify_host_gate(app):
    """Read only the bounded gate assets from a bundle's ASAR and validate them."""
    # Local import keeps the shared validator usable by build_copy and by the
    # full verifier without an import cycle through build_copy/updater_policy.
    from verify_voice_build import read_header, packed_entries

    original = Path(app)
    if original.is_symlink():
        raise RuntimeError('Host updater gate bundle must not be symlinked.')
    root = original.resolve(strict=True)
    archive = root / 'Contents/Resources/app.asar'
    if not archive.resolve(strict=True).is_relative_to(root) or not archive.is_file():
        raise RuntimeError('Host updater gate archive must be a regular file inside the bundle.')
    assets = {}
    with archive.open('rb') as stream:
        size = archive.stat().st_size
        tree, _raw, body = read_header(stream, size)
        for path, entry in packed_entries(tree):
            if path not in HOST_GATE_ASSETS:
                continue
            offset, length = int(entry['offset']), entry['size']
            if not 0 < length <= MAX_HOST_GATE_ASSET_BYTES or offset + length > size - body:
                raise RuntimeError(f'Host updater gate asset is oversized or truncated: {path}')
            stream.seek(body + offset)
            content = stream.read(length)
            if len(content) != length:
                raise RuntimeError(f'Host updater gate asset is truncated: {path}')
            assets[path] = content
    return validate_host_gate_assets(assets)
