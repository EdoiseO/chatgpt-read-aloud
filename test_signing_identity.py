"""Signing policy tests use inert fixture bundles and fake command results only."""
from contextlib import contextmanager
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

import signing_identity as signing

PIN = 'A1' * 20
OTHER_PIN = 'B2' * 20


def fixture_report(pin=None):
    report = {'mode': 'certificate' if pin else 'adhoc', 'certificateSha1': pin}
    for role, identifier in [('app', signing.APP_IDENTIFIER), ('native', signing.NATIVE_IDENTIFIER)]:
        report[role] = {'identifier': identifier, 'adHoc': pin is None,
                        'designatedRequirement': ('identifier "' + identifier + '" and certificate leaf = H"' + pin + '"'
                                                  if pin else 'cdhash H"' + 'c' * 40 + '"')}
    return report


def signature_output(path, pin=None, *, identifier=None, requirement=None):
    identifier = identifier or (signing.NATIVE_IDENTIFIER if str(path).endswith('/ChatGPT-native')
                                else signing.APP_IDENTIFIER)
    requirement = requirement or ('identifier "' + identifier + '" and certificate leaf = H"' + pin + '"'
                                  if pin else 'cdhash H"' + 'c' * 40 + '"')
    return ('Identifier=' + identifier + '\n' + ('Signature size=2048' if pin else 'Signature=adhoc')
            + '\n' + ('' if pin else '# ') + 'designated => ' + requirement + '\n')


def fake_runner(pin=None, *, commands=None, fail=None, display=None, available=True):
    commands = [] if commands is None else commands
    def runner(arguments, **kwargs):
        commands.append(arguments)
        if fail and fail(arguments):
            raise subprocess.CalledProcessError(1, arguments)
        if '--display' in arguments:
            output = display(arguments[-1]) if display else signature_output(arguments[-1], pin)
        elif arguments[:2] == ['/usr/bin/security', 'find-identity']:
            output = '  1) ' + (pin or PIN) + ' "Local test certificate"\n' if available else '0 valid identities found\n'
        else:
            output = ''
        return SimpleNamespace(returncode=0, stdout=output, stderr='')
    return runner


@contextmanager
def fixture(pin=None, native=True):
    with tempfile.TemporaryDirectory() as directory:
        app = Path(directory) / 'Fixture.app'
        (app / 'Contents/MacOS').mkdir(parents=True)
        info = {'CFBundleIdentifier': signing.APP_IDENTIFIER, 'CFBundleExecutable': 'ChatGPT'}
        signing.record_signing_identity(info, pin)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        (app / 'Contents/MacOS/ChatGPT').write_bytes(b'not executable')
        if native:
            (app / 'Contents/MacOS/ChatGPT-native').write_bytes(b'not executable')
        yield app, info


class SigningIdentityTests(unittest.TestCase):
    def test_exact_fingerprint_only_no_names_dash_prefix_or_whitespace(self):
        self.assertEqual(signing.certificate_hash(PIN.lower()), PIN)
        for value in ('-', '', 'Local test certificate', PIN[:10], ' ' + PIN, PIN + '\n', None, 12):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'exact 40-digit'):
                signing.certificate_hash(value)

    def test_missing_marker_is_legacy_but_malformed_marker_is_never_legacy(self):
        self.assertIsNone(signing.signing_pin({}))
        for value in (None, PIN, {}, {'version': True, 'certificateSha1': PIN},
                      {'version': 2, 'certificateSha1': PIN}, {'version': 1, 'certificateSha1': '-'},
                      {'version': 1, 'certificateSha1': PIN, 'extra': True}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                signing.signing_pin({signing.SIGNING_MARKER: value})

    def test_signer_pin_cannot_be_removed_or_replaced(self):
        info = {}
        signing.record_signing_identity(info, PIN.lower())
        self.assertEqual(signing.signing_pin(info), PIN)
        for replacement in (None, OTHER_PIN):
            with self.assertRaisesRegex(RuntimeError, 'replace or remove'):
                signing.record_signing_identity(info, replacement)

    def test_existing_valid_identity_required_without_creation_or_import(self):
        commands = []
        self.assertEqual(signing.require_available_identity(PIN, fake_runner(PIN, commands=commands)), PIN)
        self.assertEqual(commands, [['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning']])
        for pin, available in ((OTHER_PIN, True), (PIN, False)):
            with self.assertRaisesRegex(RuntimeError, 'not an available valid'):
                signing.require_available_identity(PIN, fake_runner(pin, available=available))

    def test_default_adhoc_and_explicit_first_certificate_migration(self):
        with fixture() as (app, info):
            self.assertIsNone(signing.resolve_signing_identity(info=info, app=app, runner=fake_runner()))
            self.assertEqual(signing.resolve_signing_identity(PIN, info=info, app=app, runner=fake_runner()), PIN)

    def test_signed_stage_inherits_pin_and_rejects_mismatched_override(self):
        with fixture(PIN) as (app, info):
            self.assertEqual(signing.resolve_signing_identity(info=info, app=app, runner=fake_runner(PIN)), PIN)
            commands = []
            with self.assertRaisesRegex(RuntimeError, 'differs from'):
                signing.resolve_signing_identity(OTHER_PIN, info=info, app=app,
                                                 runner=fake_runner(PIN, commands=commands))
            self.assertEqual(commands, [])

    def test_unmarked_certificate_cannot_silently_downgrade_or_enroll(self):
        with fixture() as (app, info):
            for requested in (None, PIN):
                with self.assertRaisesRegex(RuntimeError, 'missing its pinned'):
                    signing.resolve_signing_identity(requested, info=info, app=app, runner=fake_runner(PIN))

    def test_actual_leaf_requirement_checked_for_root_and_native(self):
        with fixture(PIN) as (app, info):
            commands = []
            report = signing.verify_signing_identity(app, runner=fake_runner(PIN, commands=commands))
            self.assertEqual(report['certificateSha1'], PIN)
            self.assertEqual(report['native']['identifier'], signing.NATIVE_IDENTIFIER)
            checks = [args for args in commands if '-R' in args]
            self.assertEqual(len(checks), 2)
            self.assertTrue(all(args[args.index('-R') + 1] == '=certificate leaf = H"' + PIN + '"' for args in checks))
            with self.assertRaises(subprocess.CalledProcessError):
                signing.verify_signing_identity(app, runner=fake_runner(PIN, fail=lambda args: '-R' in args))

    def test_persistent_identity_rejects_adhoc_cdhash_or_unstable_native_identifier(self):
        with fixture(PIN) as (app, info):
            for bad in ('adhoc', 'cdhash', 'identifier'):
                def display(path):
                    if bad == 'adhoc':
                        return signature_output(path)
                    if bad == 'cdhash':
                        return signature_output(path, PIN, requirement='cdhash H"' + 'c' * 40 + '"')
                    return signature_output(path, PIN, identifier='ChatGPT-native-UUID' if path.endswith('/ChatGPT-native') else None)
                with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                    signing.verify_signing_identity(app, runner=fake_runner(PIN, display=display))

    def test_empty_or_ambiguous_display_output_fails_closed(self):
        with fixture() as (app, info):
            for output in ('', signature_output(app) + signature_output(app), 'Identifier=x\nSignature=adhoc\n'):
                with self.subTest(output=output), self.assertRaisesRegex(RuntimeError, 'Unable to read'):
                    signing.verify_signing_identity(app, runner=fake_runner(display=lambda path: output))

    def test_current_leaf_signature_cannot_hide_a_weak_or_wrong_designated_requirement(self):
        for role, identifier in [('app', signing.APP_IDENTIFIER), ('native', signing.NATIVE_IDENTIFIER)]:
            exact = 'identifier "' + identifier + '" and certificate leaf = H"' + PIN + '"'
            weak = ['always', 'identifier "' + identifier + '"', 'certificate leaf = H"' + PIN + '"',
                    exact.replace(' and ', ' or '), exact + ' or always',
                    exact.replace(PIN, OTHER_PIN), exact.replace(identifier, identifier + '.other'),
                    'identifier "' + identifier + '" and (certificate leaf = H"' + PIN + '" or always)']
            with fixture(PIN) as (app, info):
                for requirement in weak:
                    def display(path):
                        current_role = 'native' if path.endswith('/ChatGPT-native') else 'app'
                        return signature_output(path, PIN, requirement=requirement if current_role == role else None)
                    with self.subTest(role=role, requirement=requirement), self.assertRaisesRegex(RuntimeError, 'does not bind'):
                        signing.verify_signing_identity(app, runner=fake_runner(PIN, display=display))

    def test_exact_requirement_accepts_printer_hash_case_whitespace_and_clause_order(self):
        for identifier in (signing.APP_IDENTIFIER, signing.NATIVE_IDENTIFIER):
            for requirement in [
                'identifier "' + identifier + '" and certificate leaf = H"' + PIN.lower() + '"',
                ' certificate leaf=H"' + PIN + '"  and\tidentifier "' + identifier + '" ',
            ]:
                signing.require_pinned_requirement(requirement, identifier, PIN)

    @unittest.skipUnless(shutil.which('csreq'), 'macOS requirement compiler is unavailable')
    def test_native_requirement_printer_is_accepted_without_signing_or_credentials(self):
        for identifier in (signing.APP_IDENTIFIER, signing.NATIVE_IDENTIFIER):
            result = subprocess.run(['/usr/bin/csreq', '-r', '=' + signing.pinned_requirement(identifier, PIN), '-t'],
                                    check=True, capture_output=True, text=True, timeout=5)
            signing.require_pinned_requirement(result.stdout.strip(), identifier, PIN)
            self.assertIn(PIN.lower(), result.stdout)

    def test_one_signer_for_every_pass_and_native_identifier_survives_final_seal(self):
        for pin in (None, PIN):
            with self.subTest(pin=pin), fixture(pin) as (app, info):
                commands = []
                report = signing.sign_bundle(app, 'fixture-entitlements.plist', pin,
                                             runner=fake_runner(pin, commands=commands))
                signs = [args for args in commands if '--sign' in args]
                self.assertEqual(len(signs), 3)
                self.assertTrue(all(args[args.index('--sign') + 1] == (pin or '-') for args in signs))
                self.assertIn('--deep', signs[0])
                self.assertNotIn('--identifier', signs[0])
                self.assertNotIn('--requirements', signs[0])
                self.assertEqual(signs[1][-1], str(app / 'Contents/MacOS/ChatGPT-native'))
                self.assertNotIn('--deep', signs[-1])
                self.assertEqual(signs[-1][-1], str(app))
                if pin:
                    self.assertEqual(signs[1][signs[1].index('--identifier') + 1], signing.NATIVE_IDENTIFIER)
                    for command, identifier in ((signs[1], signing.NATIVE_IDENTIFIER), (signs[-1], signing.APP_IDENTIFIER)):
                        self.assertEqual(command[command.index('--requirements') + 1],
                                         '=designated => identifier "' + identifier + '" and certificate leaf = H"' + PIN + '"')
                else:
                    self.assertTrue(all('--requirements' not in command for command in signs))
                self.assertEqual(report['mode'], 'certificate' if pin else 'adhoc')

    def test_signing_failure_has_no_adhoc_retry(self):
        with fixture(PIN) as (app, info):
            commands = []
            with self.assertRaises(subprocess.CalledProcessError):
                signing.sign_bundle(app, 'fixture-entitlements.plist', PIN,
                                    runner=fake_runner(PIN, commands=commands, fail=lambda args: '--sign' in args))
            self.assertEqual(len([args for args in commands if '--sign' in args]), 1)
            self.assertFalse(any('--sign' in args and args[args.index('--sign') + 1] == '-' for args in commands))

    def test_bundle_pin_mismatch_rejected_before_any_signing(self):
        with fixture(PIN) as (app, info):
            commands = []
            with self.assertRaisesRegex(RuntimeError, 'disagrees'):
                signing.sign_bundle(app, 'fixture-entitlements.plist', None, runner=fake_runner(commands=commands))
            self.assertEqual(commands, [])

    def test_upgrade_same_pin_requires_mutual_root_and_native_requirements(self):
        with fixture(PIN) as (app, info):
            report = signing.verify_signing_identity(app, runner=fake_runner(PIN))
            commands = []
            transition = signing.verify_signing_transition(app, app, report, report,
                                                          runner=fake_runner(PIN, commands=commands))
            self.assertTrue(transition['mutuallyCompatibleRequirements'])
            self.assertEqual(len(commands), 4)
            self.assertTrue(all('-R' in args for args in commands))
            with self.assertRaises(subprocess.CalledProcessError):
                signing.verify_signing_transition(app, app, report, report,
                                                  runner=fake_runner(PIN, fail=lambda args: True))

    def test_upgrade_downgrade_and_signer_change_are_rejected(self):
        for pin in (None, OTHER_PIN):
            with self.subTest(pin=pin), self.assertRaisesRegex(RuntimeError, 'changes or removes'):
                signing.verify_signing_transition('/previous', '/staged', {'certificateSha1': PIN},
                                                  {'certificateSha1': pin}, runner=fake_runner())
        migration = signing.verify_signing_transition('/previous', '/staged', {'certificateSha1': None},
                                                       {'certificateSha1': PIN}, runner=fake_runner())
        self.assertEqual(migration['kind'], 'adhoc-to-certificate')
        self.assertTrue(migration['permissionsMayNeedApproval'])


if __name__ == '__main__':
    unittest.main()
