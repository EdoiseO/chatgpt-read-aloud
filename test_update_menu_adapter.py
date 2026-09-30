"""Exercise menu rebuilds and reject unreviewed host edits without running Electron."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import update_menu_adapter as adapter


def fixture():
    return ('function build(c){let S={formatMessage:()=>"Check for Updates…"},'
            'Ae={role:"about"},ee={label:"Settings"},ce={role:"close"},'
            + adapter.ORIGINAL_MENU_ITEM + '{role:"quit"},'
            + adapter.ORIGINAL_MENU_LIST + '];return Et;}')


class UpdateMenuTests(unittest.TestCase):
    def test_rebuilt_menu_retains_one_manual_checker_with_native_updater_disabled(self):
        source = fixture()
        with patch.object(adapter, 'HOST_MENU_SHA256', hashlib.sha256(source.encode()).hexdigest()):
            updated = adapter.patch_update_menu(source)
            adapter.validate_update_menu(updated)
        script = '''const assert=require('node:assert/strict');
let checks=0, installs=0;
const g={app:{}};
const localRequire=name=>{assert.equal(name,'./local-read-aloud-update-checker.cjs');return {
 installUpdateChecker:electron=>{assert.equal(electron,g);installs++;return {
 menuItemOptions:label=>({id:'read-aloud-check-for-updates',label,click:()=>{checks++;}})}}}};
const build=new Function('require','g',SOURCE+';return build;')(localRequire,g);
for(const enabled of [false,true,false]){
 const entries=build(enabled).filter(item=>item.id==='read-aloud-check-for-updates');
 assert.equal(entries.length,1);assert.equal(entries[0].label,'Check for Updates…');entries[0].click();
}
assert.equal(checks,3);assert.equal(installs,3);
'''.replace('SOURCE', json.dumps(updated))
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_unknown_host_and_duplicate_hooks_fail_closed(self):
        source = fixture()
        with self.assertRaises(RuntimeError):
            adapter.patch_update_menu(source)
        with patch.object(adapter, 'HOST_MENU_SHA256', hashlib.sha256(source.encode()).hexdigest()):
            updated = adapter.patch_update_menu(source)
            for changed in (updated + '// different host', updated + adapter.PATCHED_MENU_ITEM,
                            updated.replace(adapter.PATCHED_MENU_LIST, adapter.ORIGINAL_MENU_LIST),
                            source):
                with self.assertRaises(RuntimeError):
                    adapter.validate_update_menu(changed)

    def test_installed_official_host_matches_reviewed_adapter(self):
        archive = Path('/Applications/ChatGPT.app/Contents/Resources/app.asar')
        if not archive.is_file():
            self.skipTest('Pinned official host is not installed on this test machine')
        from build_copy import read_header, leaf
        with archive.open('rb') as stream:
            tree, _, body = read_header(stream)
            try:
                item = leaf(tree, adapter.HOST_MENU_ASSET)
            except KeyError:
                self.skipTest('Installed official release has another menu asset')
            stream.seek(body + int(item['offset']))
            source = stream.read(item['size']).decode()
        updated = adapter.patch_update_menu(source)
        adapter.validate_update_menu(updated)


if __name__ == '__main__':
    unittest.main()
