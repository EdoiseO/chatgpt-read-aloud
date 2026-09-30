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
            self.assertTrue(report['sharedResponseActionRow'])
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

    def test_voice_timeline_is_pinned_and_only_assistant_routes_opt_in(self):
        source = '\n'.join(before for _label, before, _after in adapter.VOICE_TIMELINE_PATCHES)
        source += '\n/* unrelated showActionRow:!1 and user hideActions:!0 */\nexport{}'
        with self.assertRaisesRegex(ValueError, 'renderer changed'):
            adapter.patch_voice_timeline(source)
        with patch.object(adapter, 'VOICE_TIMELINE_SHA256', hashlib.sha256(source.encode()).hexdigest()):
            result = adapter.patch_voice_timeline(source)
            self.assertEqual(result.count('readAloudStandalone:!a.codexReadAloudGrouped'), 1)
            self.assertEqual(result.count('readAloudStandalone:!o.codexReadAloudGrouped'), 1)
            self.assertEqual(result.count('showActionRow:!1'), source.count('showActionRow:!1'))
            self.assertTrue(adapter.validate_patched_voice_timeline(result)['historicalVoiceWorkControls'])
            for changed in (result + ' ', result.replace('readAloudStandalone:!a.codexReadAloudGrouped', 'readAloudStandalone:!1', 1),
                            result.replace(adapter.GROUP_START, '')):
                with self.assertRaises(ValueError):
                    adapter.validate_patched_voice_timeline(changed)

    def test_voice_timeline_missing_or_duplicated_route_rejected_even_with_matching_pin(self):
        source = '\n'.join(before for _label, before, _after in adapter.VOICE_TIMELINE_PATCHES)
        for _label, before, _after in adapter.VOICE_TIMELINE_PATCHES:
            for changed in (source.replace(before, '', 1), source + before):
                with patch.object(adapter, 'VOICE_TIMELINE_SHA256', hashlib.sha256(changed.encode()).hexdigest()), \
                        self.assertRaisesRegex(ValueError, 'reviewed speech host'):
                    adapter.patch_voice_timeline(changed)

    def actual_host_inputs(self, include_groups=False):
        official = Path('/Applications/ChatGPT.app/Contents/Resources/app.asar')
        if not official.is_file():
            self.skipTest('Official host unavailable; proprietary source is not bundled')
        from build_copy import read_header, leaf
        with official.open('rb') as stream:
            tree, _raw, body = read_header(stream)
            item = leaf(tree, adapter.TOOLBAR_ASSET)
            stream.seek(body + int(item['offset']))
            source = stream.read(item['size']).decode()
            item = leaf(tree, adapter.VOICE_TIMELINE_ASSET)
            stream.seek(body + int(item['offset']))
            voice_source = stream.read(item['size']).decode()
            item = leaf(tree, 'webview/assets/app-shared-b42a855b3317.css')
            stream.seek(body + int(item['offset']))
            css = stream.read(item['size']).decode()
        self.assertEqual(hashlib.sha256(css.encode()).hexdigest(),
                         '47b83c45c6b351ab2e80c4c1ca4d9b8d97a67bccf723ca609db108915fd9277d',
                         'Reviewed host layout CSS changed')
        patched = adapter.patch_toolbar(source)
        patched_voice = adapter.patch_voice_timeline(voice_source)
        functions = {}
        for name, following in [('Vb', 'Hb'), ('Xb', 'Zb'), ('fx', '_x')]:
            start, end = patched.index('function ' + name + '('), patched.index('function ' + following + '(')
            # fx is followed by its lazy initializer; only extract the renderer.
            if name == 'fx':
                end = patched.index('var px,mx,hx;', start)
            functions[name] = patched[start:end]
        for name, boundary in [('Ik', 'var Lk,Rk;'), ('Ek', 'function Dk('), ('Dk', 'function Ok(')]:
            start = patched_voice.index('function ' + name + '(')
            functions[name] = patched_voice[start:patched_voice.index(boundary, start)]
        if include_groups:
            for name, following in [('BD', 'VD'), ('eO', 'tO'), ('aO', 'oO'), ('oO', 'sO'),
                                    ('lO', 'uO'), ('Fk', 'Ik'), ('iA', 'aA'), ('Tk', 'Ek'),
                                    ('fk', 'pk'), ('LA', 'RA'), ('ij', 'aj')]:
                start = patched_voice.index('function ' + name + '(')
                functions[name] = patched_voice[start:patched_voice.index('function ' + following + '(', start)]
            functions['group_payload'] = adapter.group_payload()
            navigation = next(after for label, _before, after in adapter.VOICE_TIMELINE_PATCHES
                              if label == 'Resolve grouped navigation keys')
            functions['navigation'] = 'function actualNavigationAliases(Yt){' + navigation + '}'
            start = patched_voice.index('D=S!=null&&`type`in S&&')
            phase = patched_voice[start:patched_voice.index(',t[2]=E', start)]
            functions['phase'] = 'function actualLatestPhase(S,E){let D;' + phase + ';return D}'
        return functions, css

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the host renderer probe')
    def test_actual_pinned_host_renderer_completed_transcript_and_streaming_boundaries(self):
        functions, _css = self.actual_host_inputs()
        result = subprocess.run(['node', 'test-support/host-renderer-probe.cjs'],
                                input=json.dumps(functions), capture_output=True,
                                text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        self.assertIn('Host renderer boundaries verified', result.stdout)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the host layout probe')
    def test_actual_host_action_row_geometry_and_hover_focus_visibility(self):
        functions, css = self.actual_host_inputs()
        fixture = subprocess.run(['node', 'test-support/host-renderer-probe.cjs', '--layout-fixture'],
                                 input=json.dumps(functions), capture_output=True,
                                 text=True, timeout=10)
        self.assertEqual(fixture.returncode, 0, fixture.stderr[-4000:])
        result = subprocess.run(['node', 'test-support/host-action-layout.mjs'],
                                input=json.dumps({'layouts': json.loads(fixture.stdout), 'css': css}),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        self.assertIn('Host action layout verified in an offline browser', result.stdout)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the host voice grouping probe')
    def test_actual_canonical_projection_group_rendering_and_navigation(self):
        functions, _css = self.actual_host_inputs(include_groups=True)
        result = subprocess.run(['node', 'test-support/voice-group-host-probe.cjs'],
                                input=json.dumps(functions), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr[-5000:])
        self.assertIn('Canonical grouped host routes verified', result.stdout)


if __name__ == '__main__':
    unittest.main()
