"""Pure adapter validation; no application or archive writes."""
import hashlib
import unittest

import selection_host_adapter as adapter


class SelectionHostAdapterTests(unittest.TestCase):
    def setUp(self):
        self.original = "\n".join(original for original, _, _ in
                                  adapter._HOST_REPLACEMENTS + adapter._MENU_REPLACEMENTS)
        self.sha = hashlib.sha256(self.original.encode()).hexdigest()

    def test_full_patch_roundtrip_is_exact(self):
        patched = adapter.patch_selection_menu(self.original, expected_sha=self.sha)
        adapter.validate_patched_selection_menu(patched, expected_sha=self.sha)
        self.assertEqual(adapter.restore_selection_menu(patched, expected_sha=self.sha), self.original)

    def test_unrelated_source_change_fails_the_whole_asset_pin(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            adapter.patch_selection_menu(self.original + "/* host changed */", expected_sha=self.sha)

    def test_changed_and_duplicated_anchors_fail_even_under_a_new_fixture_pin(self):
        for changed in [self.original.replace("function J4e", "function Other"),
                        self.original + adapter._J4E]:
            with self.assertRaisesRegex(ValueError, "selection target resolver"):
                adapter.patch_selection_menu(changed, expected_sha=hashlib.sha256(changed.encode()).hexdigest())

    def test_double_patch_is_rejected(self):
        patched = adapter.patch_selection_menu(self.original, expected_sha=self.sha)
        with self.assertRaises(ValueError):
            adapter.patch_selection_menu(patched, expected_sha=self.sha)

    def test_patched_code_and_unrelated_mutations_fail_verification(self):
        patched = adapter.patch_selection_menu(self.original, expected_sha=self.sha)
        for changed in [patched.replace('children:"Read aloud"', 'children:"Other"'),
                        patched + "/* unreviewed extra */"]:
            with self.assertRaises(ValueError):
                adapter.validate_patched_selection_menu(changed, expected_sha=self.sha)


if __name__ == "__main__":
    unittest.main()
