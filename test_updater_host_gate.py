"""Host updater gate tests; fixtures only, with optional read-only official input."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import updater_host_gate as gate


def fixture_assets():
    # Keep proprietary bundles out of the repository. These are only the short
    # wiring anchors; a test-only hash patch never changes production pins.
    return {path: b'\n'.join(anchors) for path, anchors in gate.HOST_GATE_ANCHORS.items()}


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as folder:
        app = Path(folder).resolve() / 'Fixture.app'
        (app / 'Contents/Resources').mkdir(parents=True)
        assets = fixture_assets()
        pins = {path: hashlib.sha256(content).hexdigest() for path, content in assets.items()}
        with patch.object(gate, 'HOST_GATE_ASSETS', pins):
            yield app, assets


def archive(app, assets, mutate=None):
    tree, payload = {'files': {}}, b''
    for path, content in assets.items():
        directory = tree
        parts = path.split('/')
        for part in parts[:-1]:
            directory = directory['files'].setdefault(part, {'files': {}})
        digest = hashlib.sha256(content).hexdigest()
        directory['files'][parts[-1]] = {
            'offset': str(len(payload)), 'size': len(content),
            'integrity': {'algorithm': 'SHA256', 'hash': digest,
                          'blockSize': 4194304, 'blocks': [digest]},
        }
        payload += content
    if mutate:
        mutate(tree)
    raw = json.dumps(tree, separators=(',', ':')).encode()
    padding = bytes((-len(raw)) % 4)
    header = struct.pack('<II', 4 + len(raw) + len(padding), len(raw)) + raw + padding
    target = app / 'Contents/Resources/app.asar'
    target.write_bytes(struct.pack('<II', 4, len(header)) + header + payload)
    return target


class HostGateTests(unittest.TestCase):
    def test_validated_evidence_and_archive_are_read_only(self):
        with fixture() as (app, assets):
            target = archive(app, assets)
            before = target.read_bytes()
            direct = gate.validate_host_gate_assets(assets)
            self.assertEqual(gate.verify_host_gate(app), direct)
            self.assertEqual(direct['environmentVariable'], 'CODEX_SPARKLE_ENABLED')
            self.assertEqual(direct['requiredValue'], 'false')
            self.assertTrue(direct['startupGateVerified'])
            self.assertTrue(direct['lazyInitializationGateVerified'])
            self.assertEqual(target.read_bytes(), before)

    def test_missing_changed_nonbytes_and_oversized_assets_fail_closed(self):
        with fixture() as (_app, assets):
            key = next(iter(assets))
            for changed in ({}, {**assets, key: assets[key] + b' '},
                            {**assets, key: assets[key].decode()},
                            {**assets, key: b'x' * (gate.MAX_HOST_GATE_ASSET_BYTES + 1)}):
                with self.subTest(value_type=type(changed.get(key)).__name__):
                    with self.assertRaises(RuntimeError):
                        gate.validate_host_gate_assets(changed)
            with self.assertRaises(RuntimeError):
                gate.validate_host_gate_assets(None)

    def test_missing_or_duplicated_wiring_is_rejected_even_with_matching_hash(self):
        with fixture() as (_app, assets):
            for key, anchors in gate.HOST_GATE_ANCHORS.items():
                for content in (assets[key].replace(anchors[0], b'', 1), assets[key] + anchors[0]):
                    pins = {**gate.HOST_GATE_ASSETS, key: hashlib.sha256(content).hexdigest()}
                    with patch.object(gate, 'HOST_GATE_ASSETS', pins):
                        with self.assertRaisesRegex(RuntimeError, 'wiring'):
                            gate.validate_host_gate_assets({**assets, key: content})

    def test_missing_unpacked_linked_truncated_and_oversized_entries_fail(self):
        with fixture() as (app, assets):
            name = Path(next(iter(assets))).name
            for change in ('missing', 'unpacked', 'link', 'truncated', 'oversized'):
                def mutate(tree):
                    files = tree['files']['.vite']['files']['build']['files']
                    entry = files[name]
                    if change == 'missing': del files[name]
                    elif change == 'unpacked': entry['unpacked'] = True
                    elif change == 'link': entry['link'] = 'elsewhere'
                    elif change == 'oversized': entry['size'] = gate.MAX_HOST_GATE_ASSET_BYTES + 1
                target = archive(app, assets, mutate)
                if change == 'truncated': target.write_bytes(target.read_bytes()[:-1])
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    gate.verify_host_gate(app)

    def test_unknown_production_bytes_cannot_be_accepted_by_anchor_match(self):
        with self.assertRaisesRegex(RuntimeError, 'inspected app version'):
            gate.validate_host_gate_assets(fixture_assets())

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the exact host module probe')
    def test_exact_pinned_official_module_disables_every_supported_release_flavor(self):
        official = Path('/Applications/ChatGPT.app')
        info = official / 'Contents/Info.plist'
        if not info.is_file() or plistlib.loads(info.read_bytes()).get('CFBundleShortVersionString') != '26.928.20755':
            self.skipTest('Pinned official app is not available; no proprietary source fixture is bundled')
        gate.verify_host_gate(official)
        from build_copy import read_header, leaf
        key = next(iter(gate.HOST_GATE_ASSETS))
        with (official / 'Contents/Resources/app.asar').open('rb') as stream:
            tree, _raw, body = read_header(stream)
            item = leaf(tree, key)
            stream.seek(body + int(item['offset']))
            source = stream.read(item['size']).decode()
        # Only the exact pinned small module is evaluated. Every dependency is
        # inert or node:path; Electron, native addons, fs and network are absent.
        probe = r'''
const vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
let source='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>source+=s);
process.stdin.on('end',()=>{
 const out={},flavors={Nightly:'nightly',InternalAlpha:'internal-alpha',PublicBeta:'public-beta',Prod:'prod'};
 const deps={'./rolldown-runtime-CPUxUITh.js':{a:v=>({default:v})},'./src-ghAWefM3.js':{Mi:flavors},
 './logger-CUwSCKgw.js':{i:()=>()=>({debug(){},warning(){},info(){}})},'node:fs':{},'node:path':path};
 vm.runInNewContext(source,{exports:out,process:{env:{},cwd:()=>'/unused'},require:n=>{
   if(!(n in deps))throw Error('Unexpected dependency');return deps[n]}},{timeout:1000});
 for(const flavor of Object.values(flavors)){
   assert.equal(out.t.shouldIncludeSparkle(flavor,'darwin',{}),true);
   assert.equal(out.t.shouldIncludeUpdater(flavor,'darwin',{}),true);
   for(const platform of ['darwin','win32','linux']){
     const env={CODEX_SPARKLE_ENABLED:'false'};
     assert.equal(out.t.shouldIncludeSparkle(flavor,platform,env),false);
     assert.equal(out.t.shouldIncludeUpdater(flavor,platform,env),false);
   }
 }
 assert.equal(out.t.shouldIncludeUpdater('dev','darwin',{}),false);
 for(const value of ['true','False','0']) assert.equal(out.t.shouldIncludeUpdater('prod','darwin',{CODEX_SPARKLE_ENABLED:value}),true);
 console.log('Exact pinned host gate verified across all four release flavors');
});'''
        result = subprocess.run(['node', '-e', probe], input=source, capture_output=True,
                                text=True, timeout=5, check=True)
        self.assertIn('all four release flavors', result.stdout)


if __name__ == '__main__':
    unittest.main()
