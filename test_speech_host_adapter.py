"""Speech host boundary checks; no proprietary generated asset is committed."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

import speech_host_adapter as adapter


def fixture_host():
    # Short patch anchors exercise integrity checks on every CI platform. The
    # optional local probe below evaluates the actual pinned host functions.
    return '\n'.join(before for _label, before, _after in adapter.PATCHES) + '\nexport{}'


class SpeechHostTests(unittest.TestCase):
    def test_patch_roundtrip_proves_every_host_byte_and_no_global_action_change(self):
        source = fixture_host() + '\n/* other showActionRow:!1 remains untouched */'
        with patch.object(adapter, 'TOOLBAR_SHA256', hashlib.sha256(source.encode()).hexdigest()):
            result = adapter.append_payload(adapter.patch_toolbar(source), 'function speech() {}')
            report = adapter.validate_patched_toolbar(result)
            self.assertTrue(report['completedResponsesOnly'])
            self.assertTrue(report['realtimeAssistantControls'])
            self.assertTrue(report['speechControlsAlwaysVisible'])
            self.assertIn('/* other showActionRow:!1 remains untouched */', result)

    def test_changed_source_cannot_pass_by_retaining_matching_anchors(self):
        with self.assertRaisesRegex(ValueError, 'renderer changed'):
            adapter.patch_toolbar(fixture_host())

    def test_missing_duplicate_and_changed_boundaries_fail_even_with_matching_pin(self):
        for _label, anchor, _replacement in adapter.PATCHES:
            for source in (fixture_host().replace(anchor, '', 1), fixture_host() + anchor):
                with self.subTest(anchor=anchor[:35]), \
                        patch.object(adapter, 'TOOLBAR_SHA256', hashlib.sha256(source.encode()).hexdigest()), \
                        self.assertRaisesRegex(ValueError, 'reviewed speech host'):
                    adapter.patch_toolbar(source)

    def test_verification_rejects_removed_moved_or_tampered_integration(self):
        source = fixture_host()
        with patch.object(adapter, 'TOOLBAR_SHA256', hashlib.sha256(source.encode()).hexdigest()):
            result = adapter.append_payload(adapter.patch_toolbar(source), 'function speech() {}')
            changes = [result + ' ', result.replace(adapter.PAYLOAD_START, ''),
                       result.replace(adapter.PAYLOAD_END, adapter.PAYLOAD_END + ' '),
                       result.replace(adapter.READ_CONTROL, 'null'),
                       result.replace(adapter.TRANSCRIPT_REPLACEMENT, adapter.TRANSCRIPT_ANCHOR),
                       result + adapter.PAYLOAD_START]
            for changed in changes:
                with self.subTest(change=changed[-60:]), self.assertRaises(ValueError):
                    adapter.validate_patched_toolbar(changed)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the host renderer probe')
    def test_actual_pinned_host_renderer_completed_transcript_and_streaming_boundaries(self):
        official = Path('/Applications/ChatGPT.app/Contents/Resources/app.asar')
        if not official.is_file():
            self.skipTest('Official host unavailable; proprietary source is not bundled')
        from build_copy import read_header, leaf
        with official.open('rb') as stream:
            tree, _raw, body = read_header(stream)
            item = leaf(tree, adapter.TOOLBAR_ASSET)
            stream.seek(body + int(item['offset']))
            source = stream.read(item['size']).decode()
        patched = adapter.patch_toolbar(source)
        functions = {}
        for name, following in [('Vb', 'Hb'), ('Xb', 'Zb'), ('fx', '_x')]:
            start, end = patched.index('function ' + name + '('), patched.index('function ' + following + '(')
            # fx is followed by its lazy initializer; only extract the renderer.
            if name == 'fx':
                end = patched.index('var px,mx,hx;', start)
            functions[name] = patched[start:end]
        result = subprocess.run(['node', 'test-support/host-renderer-probe.cjs'],
                                input=json.dumps(functions), capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        self.assertIn('Host renderer boundaries verified', result.stdout)


if __name__ == '__main__':
    unittest.main()
