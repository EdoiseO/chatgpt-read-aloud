"""Optional, pinned local signing identities; never create or import credentials."""
from pathlib import Path
import plistlib
import re
import subprocess

APP_IDENTIFIER = 'local.edoise.codex.readaloud'
NATIVE_IDENTIFIER = APP_IDENTIFIER + '.native'
SIGNING_MARKER = 'CodexReadAloudSigningIdentity'


def certificate_hash(value):
    if not isinstance(value, str) or re.fullmatch(r'[0-9A-Fa-f]{40}', value) is None:
        raise RuntimeError('Signing identity must be an exact 40-digit certificate SHA-1 fingerprint.')
    return value.upper()


def signing_pin(info):
    if SIGNING_MARKER not in info:
        return None
    marker = info[SIGNING_MARKER]
    if (not isinstance(marker, dict) or set(marker) != {'version', 'certificateSha1'}
            or type(marker['version']) is not int or marker['version'] != 1):
        raise RuntimeError('The persistent signing identity marker is invalid.')
    return certificate_hash(marker['certificateSha1'])


def record_signing_identity(info, identity):
    previous = signing_pin(info)
    identity = certificate_hash(identity) if identity is not None else None
    if previous is not None and previous != identity:
        raise RuntimeError('Refusing to replace or remove the pinned signing identity.')
    if identity is not None:
        info[SIGNING_MARKER] = {'version': 1, 'certificateSha1': identity}


def run(arguments, runner):
    result = runner(arguments, check=True, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Code-signing verification failed.')
    return result


def require_available_identity(identity, runner=subprocess.run):
    identity = certificate_hash(identity)
    result = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], runner)
    found = re.findall(r'^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"', result.stdout, re.MULTILINE)
    if identity not in {value.upper() for value in found}:
        raise RuntimeError('The pinned certificate and private key are not an available valid code-signing identity.')
    return identity


def signature_details(path, runner):
    result = run(['/usr/bin/codesign', '--display', '--verbose=4', '-r-', str(path)], runner)
    output = result.stdout + '\n' + result.stderr
    identifiers = re.findall(r'^Identifier=(.+)$', output, re.MULTILINE)
    requirements = re.findall(r'^#?\s*designated => (.+)$', output, re.MULTILINE)
    signatures = re.findall(r'^Signature(?:=(adhoc)| size=([1-9][0-9]*))$', output, re.MULTILINE)
    if len(identifiers) != 1 or len(requirements) != 1 or len(signatures) != 1:
        raise RuntimeError('Unable to read the actual code-signing identity and designated requirement.')
    return {'identifier': identifiers[0], 'designatedRequirement': requirements[0],
            'adHoc': signatures[0][0] == 'adhoc'}


def pinned_requirement(identifier, identity):
    if identifier not in (APP_IDENTIFIER, NATIVE_IDENTIFIER):
        raise RuntimeError('Unexpected persistent code-signing identifier.')
    return 'identifier "' + identifier + '" and certificate leaf = H"' + certificate_hash(identity) + '"'


def require_pinned_requirement(requirement, identifier, identity):
    """Accept only the two intended predicates joined by a conjunction.

    A valid current leaf signature does not establish a safe DR: an identifier-
    only DR would let unrelated signers claim future permissions. The codesign
    printer lowercases certificate hashes, so compare their values separately.
    """
    identifier_term = r'identifier\s+"' + re.escape(identifier) + '"'
    certificate_term = r'certificate\s+leaf\s*=\s*H"([0-9A-Fa-f]{40})"'
    for first, second in ((identifier_term, certificate_term), (certificate_term, identifier_term)):
        match = re.fullmatch(r'\s*' + first + r'\s+and\s+' + second + r'\s*', requirement)
        if match and certificate_hash(match[1]) == certificate_hash(identity):
            return
    raise RuntimeError('The designated requirement does not bind the expected identifier to the pinned certificate.')


def verify_signing_identity(app, info=None, runner=subprocess.run):
    """Verify actual signatures against their signed pin, without a keychain lookup."""
    app = Path(app)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes()) if info is None else info
    pin = signing_pin(info)
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], runner)
    paths = {'app': app}
    native = app / 'Contents/MacOS/ChatGPT-native'
    if native.exists() or native.is_symlink():
        if native.is_symlink() or not native.is_file():
            raise RuntimeError('The native signing target must be a regular file.')
        paths['native'] = native
    report = {'mode': 'certificate' if pin else 'adhoc', 'certificateSha1': pin}
    for role, path in paths.items():
        details = signature_details(path, runner)
        expected_identifier = APP_IDENTIFIER if role == 'app' else NATIVE_IDENTIFIER
        if role == 'app' or pin is not None:
            if details['identifier'] != expected_identifier:
                raise RuntimeError('The app or native helper has an unexpected code-signing identifier.')
        if pin is None:
            if not details['adHoc']:
                raise RuntimeError('Certificate-signed input is missing its pinned signing identity.')
        else:
            if details['adHoc'] or re.search(r'\bcdhash\b', details['designatedRequirement']):
                raise RuntimeError('Persistent signing unexpectedly produced an ad-hoc or build-specific identity.')
            require_pinned_requirement(details['designatedRequirement'], expected_identifier, pin)
            run(['/usr/bin/codesign', '--verify', '--strict', '-R',
                 '=certificate leaf = H"' + pin + '"', str(path)], runner)
        report[role] = details
    return report


def resolve_signing_identity(requested=None, *, info=None, app=None, runner=subprocess.run):
    """Only an explicit fingerprint can opt an existing ad-hoc build into signing."""
    pin = signing_pin(info or {})
    requested = certificate_hash(requested) if requested is not None else None
    if pin is not None and requested is not None and pin != requested:
        raise RuntimeError('Requested certificate differs from the existing pinned signing identity.')
    if app is not None:
        verify_signing_identity(app, info=info, runner=runner)
    identity = pin or requested
    if identity is not None:
        require_available_identity(identity, runner)
    return identity


def sign_bundle(app, entitlements, identity=None, runner=subprocess.run):
    """Use one signer throughout; seal the outer app after fixing helper identity."""
    app, entitlements = Path(app), str(entitlements)
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    identity = certificate_hash(identity) if identity is not None else None
    if signing_pin(info) != identity:
        raise RuntimeError('Signing request disagrees with the bundle signing pin.')
    native = app / 'Contents/MacOS/ChatGPT-native'
    has_native = native.exists() or native.is_symlink()
    if has_native and (native.is_symlink() or not native.is_file()):
        raise RuntimeError('The native signing target must be a regular file.')
    if identity is not None:
        require_available_identity(identity, runner)
    signer = identity or '-'
    # Retain the existing nested-code signing policy. Explicit identifiers must
    # not be passed to --deep: it would give every nested item the same identity.
    run(['/usr/bin/codesign', '--force', '--deep', '--sign', signer,
         '--preserve-metadata=flags', '--entitlements', entitlements, str(app)], runner)
    if has_native:
        arguments = ['/usr/bin/codesign', '--force', '--sign', signer, '--options', 'runtime',
                     '--entitlements', entitlements]
        if identity is not None:
            arguments += ['--identifier', NATIVE_IDENTIFIER, '--requirements',
                          '=designated => ' + pinned_requirement(NATIVE_IDENTIFIER, identity)]
        run([*arguments, str(native)], runner)
    # The bundle operation signs its main executable (the wrapper, if present).
    # This final nonrecursive pass cannot overwrite the native helper identifier.
    arguments = ['/usr/bin/codesign', '--force', '--sign', signer, '--identifier', APP_IDENTIFIER,
                 '--options', 'runtime', '--entitlements', entitlements]
    if identity is not None:
        arguments += ['--requirements', '=designated => ' + pinned_requirement(APP_IDENTIFIER, identity)]
    run([*arguments, str(app)], runner)
    return verify_signing_identity(app, info=info, runner=runner)


def verify_signing_transition(previous_app, staged_app, previous, staged, runner=subprocess.run):
    """A pinned installation cannot silently change signer or lose its DR."""
    old_pin, new_pin = previous['certificateSha1'], staged['certificateSha1']
    if old_pin is not None:
        if old_pin != new_pin:
            raise RuntimeError('The staged app changes or removes the installed signing identity.')
        for role, relative in [('app', Path('.')), ('native', Path('Contents/MacOS/ChatGPT-native'))]:
            if role not in previous or role not in staged:
                raise RuntimeError('The pinned app or native helper signing report is missing.')
            for source, target in ((previous, Path(staged_app)), (staged, Path(previous_app))):
                requirement = source[role]['designatedRequirement']
                run(['/usr/bin/codesign', '--verify', '--strict', '-R', '=' + requirement,
                     str(target / relative)], runner)
        return {'kind': 'same-certificate', 'mutuallyCompatibleRequirements': True}
    if new_pin is not None:
        return {'kind': 'adhoc-to-certificate', 'mutuallyCompatibleRequirements': False,
                'permissionsMayNeedApproval': True}
    return {'kind': 'adhoc', 'mutuallyCompatibleRequirements': False}
