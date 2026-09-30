#!/usr/bin/env python3
"""Build a locally signed copy with per-response speech and a local voice picker."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess

from asar_integrity import patch_integrity_slot, rewrite_embedded_integrity

ROOT = Path(__file__).resolve().parent
SOURCE = Path('/Applications/ChatGPT.app')
TARGET = ROOT / 'build/ChatGPT Read Aloud.app'
RESOURCE = Path('Contents/Resources/app.asar')
FRAMEWORK = Path('Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework')
ASSET = 'webview/assets/sites-end-resource-ac1aa5fe0447.js'
SELECTION_ASSET = 'webview/assets/app-primary-92c16ff2fe4e.js'
VERSION = '26.928.20755'
ANCHOR = '}}),E,A,r===void 0?ae:'
INSERT = '}}),re==null?null:(0,Y.jsx)(CodexLocalReadAloudButton,{getText:()=>Sr(f?.()??re),getHtml:()=>h?.(),getRoot:codexResponseRootGetter}),E,A,r===void 0?ae:'
EARLY = '.vite/build/early-bootstrap.js'
PRELOAD = '.vite/build/preload.js'
MAIN = '.vite/build/local-read-aloud-main.cjs'
EARLY_ANCHOR = 'require("./rolldown-runtime-CPUxUITh.js");'
PRELOAD_ANCHOR = 'e.contextBridge.exposeInMainWorld(`electronBridge`,z)'
BRIDGE = '''e.contextBridge.exposeInMainWorld("codexLocalReadAloud",{
start:(requestId,text,options)=>e.ipcRenderer.invoke("codex-local-read-aloud",{action:"start",requestId,text,...(options?.voice?{voice:options.voice}:{}),...(options?.sentenceRanges?{sentenceRanges:options.sentenceRanges}:{})}),
next:requestId=>e.ipcRenderer.invoke("codex-local-read-aloud",{action:"next",requestId}),
cancel:requestId=>e.ipcRenderer.invoke("codex-local-read-aloud",{action:"cancel",requestId}),
getVoices:()=>e.ipcRenderer.invoke("codex-local-read-aloud",{action:"voices"}),
setVoice:voice=>e.ipcRenderer.invoke("codex-local-read-aloud",{action:"set_voice",voice}),
onInterrupted:callback=>{const listener=(_event,payload)=>callback(payload);e.ipcRenderer.on("codex-local-read-aloud:interrupt",listener);return()=>e.ipcRenderer.removeListener("codex-local-read-aloud:interrupt",listener)}
})'''

SELECTION_BUTTON = '''globalThis.codexCanReadSelectionAloud?.(codexSelectionRoot,codexSelectionRange)?(0,UG.jsx)(HT,{
"aria-label":"Read aloud","data-codex-local-read-aloud":"selection",
onMouseDown:event=>event.preventDefault(),
onClick:event=>{event.stopPropagation();globalThis.codexReadSelectionAloud(codexSelectionRoot,codexSelectionRange)},
children:"Read aloud"
}):null'''
SELECTION_RETURN = 'let S;return t[41]!==_||t[42]!==v||t[43]!==y||t[44]!==b||t[45]!==x?(S=(0,UG.jsxs)(lje,{children:[_,v,y,b,x]}),t[41]=_,t[42]=v,t[43]=y,t[44]=b,t[45]=x,t[46]=S):S=t[46],S}var a3e,HG,UG;'

def patch_selection_menu(text):
    text = exact_replace(text, 'resume:l,selectedText:u}=e,d=n===void 0?',
                         'resume:l,selectedText:u,readAloudRoot:codexSelectionRoot,readAloudRange:codexSelectionRange}=e,d=n===void 0?', 'Selection menu props')
    text = exact_replace(text, 'onOpenSideChat:i})})},t[0]=n,t[1]=r,t[2]=i,t[3]=s',
                         'onOpenSideChat:i,readAloudRoot:u,readAloudRange:l})})},t[0]=n,t[1]=r,t[2]=i,t[3]=s', 'Selection range routing')
    # Render fresh range props even when another response contains identical text.
    return exact_replace(text, SELECTION_RETURN,
                         'return(0,UG.jsxs)(lje,{children:[_,v,y,b,x,' + SELECTION_BUTTON + ']})}var a3e,HG,UG;', 'Selection action menu')

def leaf(tree, key):
    for part in key.split('/'):
        tree = tree['files'][part]
    return tree

def entries(tree):
    for item in tree.get('files', {}).values():
        if 'files' in item:
            yield from entries(item)
        elif 'offset' in item and not item.get('unpacked'):
            yield item

def named_entries(tree, prefix=''):
    for name, item in tree.get('files', {}).items():
        key = prefix + name
        if 'files' in item:
            yield from named_entries(item, key + '/')
        elif 'offset' in item and not item.get('unpacked'):
            yield key, item

def integrity(data, block_size=4194304):
    return {
        'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(),
        'blockSize': block_size,
        'blocks': [hashlib.sha256(data[i:i+block_size]).hexdigest()
                   for i in range(0, len(data), block_size)],
    }

def exact_replace(text, anchor, replacement, description):
    if text.count(anchor) != 1:
        raise SystemExit(f'{description} does not match expected source; no changes made')
    return text.replace(anchor, replacement, 1)

def running_bundle(target):
    prefix = str(target.absolute()) + '/Contents/'
    rows = subprocess.run(['ps', '-axo', 'args='], capture_output=True,
                          text=True, check=True).stdout.splitlines()
    return any(row.strip().startswith(prefix) for row in rows)

def read_header(stream):
    values = struct.unpack('<4I', stream.read(16))
    raw = stream.read(values[3])
    return json.loads(raw), raw, 8 + values[1]

def copy_bytes(source, output, count):
    while count:
        data = source.read(min(count, 8 * 1024 * 1024))
        if not data:
            raise RuntimeError('Unexpected end of archive')
        output.write(data)
        count -= len(data)

def validate_copy_paths():
    if TARGET.is_symlink():
        raise SystemExit('Refusing to modify a symlinked experimental bundle')
    target_root = TARGET.resolve(strict=True)
    if target_root == SOURCE.resolve(strict=True):
        raise SystemExit('The experimental copy resolves to the installed app')
    for relative in (Path('Contents/Info.plist'), RESOURCE, FRAMEWORK):
        resolved = (TARGET / relative).resolve(strict=True)
        if not resolved.is_relative_to(target_root):
            raise SystemExit(f'Refusing to modify a path outside the experimental copy: {relative}')
    return (TARGET / FRAMEWORK).resolve(strict=True)

def main():
    global TARGET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh-copy', action='store_true',
                        help='Regenerate only the existing guarded experimental copy')
    parser.add_argument('--target', type=Path,
                        help='Explicit experimental bundle path, including an installed local copy')
    args = parser.parse_args()
    if args.target:
        TARGET = args.target.expanduser().absolute()
    target_root, official_root = TARGET.resolve(), SOURCE.resolve()
    if TARGET.is_symlink() or target_root.is_relative_to(official_root) or official_root.is_relative_to(target_root):
        raise SystemExit('Refusing a symlink or a target that overlaps the official app')
    if TARGET.exists() and not args.refresh_copy:
        raise SystemExit(f'Refusing to overwrite existing copy: {TARGET}')
    if args.refresh_copy and not TARGET.exists():
        raise SystemExit(f'No experimental copy to refresh: {TARGET}')
    if TARGET.exists() and running_bundle(TARGET):
        raise SystemExit('Quit this target before rebuilding it, or build a staged copy')
    info = plistlib.loads((SOURCE / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleShortVersionString') != VERSION:
        raise SystemExit('App version changed. Re-inspect the toolbar before patching.')
    original_integrity = copy.deepcopy(info['ElectronAsarIntegrity'])
    # Check the original framework before making any copy changes.
    patch_integrity_slot((SOURCE / FRAMEWORK).read_bytes(), original_integrity, original_integrity)
    previous_integrity = original_integrity
    if args.refresh_copy:
        validate_copy_paths()
        previous_info = plistlib.loads((TARGET / 'Contents/Info.plist').read_bytes())
        if previous_info.get('CFBundleIdentifier') != 'local.edoise.codex.readaloud':
            raise SystemExit('Refusing to refresh a bundle with an unexpected identity')
        if previous_info.get('CFBundleShortVersionString') != VERSION:
            raise SystemExit('Refusing to refresh a copy with an unexpected version')
        previous_integrity = copy.deepcopy(previous_info['ElectronAsarIntegrity'])
        # Keep the installed copy bound to its permanent profile after a refresh.
        profile = previous_info.get('LSEnvironment', {}).get('CODEX_ELECTRON_USER_DATA_PATH')
        if profile:
            info.setdefault('LSEnvironment', {})['CODEX_ELECTRON_USER_DATA_PATH'] = profile
        if previous_info.get('CodexReadAloudLauncherVersion'):
            info['CodexReadAloudLauncherVersion'] = previous_info['CodexReadAloudLauncherVersion']
        patch_integrity_slot((TARGET / FRAMEWORK).read_bytes(), previous_integrity, previous_integrity)
    original = SOURCE / RESOURCE
    with original.open('rb') as stream:
        tree, raw, body = read_header(stream)
        recorded = info['ElectronAsarIntegrity']['Resources/app.asar']['hash']
        if hashlib.sha256(raw).hexdigest() != recorded:
            raise SystemExit('Original archive integrity check failed')
        original_entries = sorted(
            [(key, int(item['offset']), item['size']) for key, item in named_entries(tree)],
            key=lambda item: item[1])
        if body + max(offset + size for _, offset, size in original_entries) != original.stat().st_size:
            raise SystemExit('Unexpected archive body layout')
        source_js = {}
        for key in (ASSET, SELECTION_ASSET, EARLY, PRELOAD):
            item = leaf(tree, key)
            stream.seek(body + int(item['offset']))
            data = stream.read(item['size'])
            if hashlib.sha256(data).hexdigest() != item['integrity']['hash']:
                raise SystemExit(f'Original asset hash disagrees: {key}')
            source_js[key] = data.decode('utf-8')
    manager = (ROOT / 'speech-controller.mjs').read_text().replace('export function createResponseSpeaker', 'function createResponseSpeaker', 1)
    kokoro = (ROOT / 'kokoro-response-speaker.mjs').read_text().replace('export function createKokoroResponseSpeaker', 'function createKokoroResponseSpeaker', 1)
    picker = (ROOT / 'voice-picker.js').read_text()
    component = (ROOT / 'response-button.js').read_text()
    highlighting = (ROOT / 'response-highlight.mjs').read_text().replace('export ', '')
    javascript = exact_replace(source_js[ASSET], ANCHOR, INSERT, 'Toolbar')
    javascript = exact_replace(javascript, 'actionRowRef:M}=e,N=',
                               'actionRowRef:M,getReadAloudRoot:codexResponseRootGetter}=e,N=', 'Response root props')
    javascript = exact_replace(javascript, 'getCopyHtml:W?We:void 0,',
                               'getCopyHtml:W?We:void 0,getReadAloudRoot:()=>ye.current?.querySelector(`[data-selected-text-overlay-target]`),', 'Scoped response root')
    marker = javascript.rfind('export{')
    if marker < 0:
        raise SystemExit('Expected export boundary missing')
    javascript = javascript[:marker] + '\n' + manager + '\n' + kokoro + '\n' + highlighting + '\n' + picker + '\n' + component + '\n' + javascript[marker:]
    replacement = javascript.encode('utf-8')
    (ROOT / 'patched-toolbar.mjs').write_bytes(replacement)
    subprocess.run(['node', '--check', str(ROOT / 'patched-toolbar.mjs')], check=True)
    replacements = {
        ASSET: replacement,
        SELECTION_ASSET: patch_selection_menu(source_js[SELECTION_ASSET]).encode(),
        EARLY: exact_replace(source_js[EARLY], EARLY_ANCHOR,
                             EARLY_ANCHOR + 'require("./local-read-aloud-main.cjs");',
                             'Main bootstrap').encode(),
        PRELOAD: exact_replace(source_js[PRELOAD], PRELOAD_ANCHOR,
                               BRIDGE + ',' + PRELOAD_ANCHOR, 'Preload').encode(),
        MAIN: (ROOT / 'kokoro-main.cjs').read_bytes(),
    }
    for key in (SELECTION_ASSET, EARLY, PRELOAD, MAIN):
        syntax_file = ROOT / ('patched-' + Path(key).name)
        syntax_file.write_bytes(replacements[key])
        subprocess.run(['node', '--check', str(syntax_file)], check=True)
    offset = 0
    for key, _, old_size in original_entries:
        item = leaf(tree, key)
        item['offset'] = str(offset)
        if key in replacements:
            item['size'] = len(replacements[key])
            item['integrity'] = integrity(replacements[key], item.get('integrity', {}).get('blockSize', 4194304))
        offset += item['size']
    new_leaf = {'size': len(replacements[MAIN]), 'offset': str(offset),
                'integrity': integrity(replacements[MAIN])}
    build_files = leaf(tree, '.vite/build')['files']
    if Path(MAIN).name in build_files:
        raise SystemExit('Local main bridge already exists in the source archive')
    build_files[Path(MAIN).name] = new_leaf
    raw = json.dumps(tree, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    padding = (-len(raw)) % 4
    header = struct.pack('<II', 4 + len(raw) + padding, len(raw)) + raw + bytes(padding)
    if not args.refresh_copy:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['cp', '-cR', str(SOURCE), str(TARGET)], check=True)
    copy_framework = validate_copy_paths()
    staged = TARGET / (str(RESOURCE) + '.new')
    with original.open('rb') as source, staged.open('wb') as output:
        output.write(struct.pack('<II', 4, len(header)))
        output.write(header)
        for key, old_offset, old_size in original_entries:
            if key in replacements:
                output.write(replacements[key])
            else:
                source.seek(body + old_offset)
                copy_bytes(source, output, old_size)
        output.write(replacements[MAIN])
    staged.replace(TARGET / RESOURCE)
    info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] = hashlib.sha256(raw).hexdigest()
    info['CFBundleDisplayName'] = 'ChatGPT Read Aloud'
    info['CFBundleIdentifier'] = 'local.edoise.codex.readaloud'
    info['CodexReadAloudVoicePickerVersion'] = 1
    info['CodexReadAloudSelectionHighlightVersion'] = 1
    info['CodexReadAloudSkipCodeBlocksVersion'] = 1
    # Avoid registering the experimental copy for the official app's deep links.
    info.pop('CFBundleURLTypes', None)
    info['SUEnableAutomaticChecks'] = False
    info['SUAutomaticallyUpdate'] = False
    (TARGET / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    # Keep Electron's embedded dictionary digest consistent with the changed
    # archive header hash. ASAR validation remains enabled in the copied app.
    rewrite_embedded_integrity(copy_framework, previous_integrity, info['ElectronAsarIntegrity'])
    original_entitlements = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(SOURCE)], capture_output=True, check=True).stdout
    entitlements = plistlib.loads(original_entitlements)
    # A local signature cannot claim OpenAI's developer identity or private groups.
    for key in ('com.apple.application-identifier', 'com.apple.developer.team-identifier',
                'com.apple.developer.aps-environment', 'com.apple.security.application-groups',
                'keychain-access-groups'):
        entitlements.pop(key, None)
    # Locally signed Electron hosts must be able to load their bundled framework.
    entitlements['com.apple.security.cs.disable-library-validation'] = True
    entitlement_file = ROOT / 'local-entitlements.plist'
    entitlement_file.write_bytes(plistlib.dumps(entitlements))
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--preserve-metadata=flags', '--entitlements', str(entitlement_file), str(TARGET)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(TARGET)], check=True)
    print(f'Built experimental copy: {TARGET}')
    print('Official app unchanged. Use the experimental copy with its dedicated profile launcher.')

if __name__ == '__main__':
    main()
