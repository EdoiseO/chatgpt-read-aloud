// Explicit acceptance gate for this UI-only experiment. This does not build,
// install, sign, register, or launch a desktop app. Browser suites use fresh
// offline contexts, synthetic text/audio, and reviewed host functions only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('.', import.meta.url));
const baseline = 'e63c9824105662301604bc5eed36f2783069beb5';
const protectedFiles = [
  'apply_voice_upgrade.py', 'configure_launcher.py', 'install_fresh.py',
  'profile-launcher.c', 'updater_policy.py', 'updater_host_gate.py',
  'asar_integrity.py', 'setup_runtime.py', 'runtime_voices.py',
  'runtime/assets.json', 'runtime/requirements.lock',
  'kokoro-main.cjs', 'kokoro_worker.py', 'speech-controller.mjs',
  'kokoro-response-speaker.mjs',
];
const fromBaseline = name => execFileSync('git', ['show', `${baseline}:${name}`],
  { cwd: root, maxBuffer: 2 * 1024 * 1024 });

test('experiment preserves baseline installation, updater, signing, and speech runtime', () => {
  for (const name of protectedFiles) {
    assert.deepEqual(readFileSync(new URL(name, import.meta.url)), fromBaseline(name),
      `${name} is outside this UI experiment`);
  }
  for (const name of ['signing_identity.py', 'update-checker.cjs', 'update_menu_adapter.py', 'launch_registration.py']) {
    assert.equal(existsSync(new URL(name, import.meta.url)), false,
      `${name} belongs to a separate experiment`);
  }
  // The builder needs UI hooks, but its bootstrap bridge, host-update gate,
  // path safeguards, archive primitives, and signing calls retain the baseline.
  // Parse source only: importing or executing the builder is unnecessary.
  const inspect = String.raw`
import ast,json,sys
sources=json.load(sys.stdin)
constants={'SOURCE','RESOURCE','FRAMEWORK','VERSION','EARLY','PRELOAD','MAIN',
           'EARLY_ANCHOR','PRELOAD_ANCHOR','BRIDGE'}
functions={'leaf','entries','named_entries','integrity','exact_replace',
           'running_bundle','read_header','copy_bytes','validate_copy_paths'}
def inspect(source):
    tree=ast.parse(source)
    result={}
    for node in tree.body:
        if isinstance(node,ast.Assign):
            for target in node.targets:
                if isinstance(target,ast.Name) and target.id in constants:
                    result[target.id]=ast.dump(node.value,include_attributes=False)
        elif isinstance(node,ast.FunctionDef) and node.name in functions:
            result[node.name]=ast.dump(node,include_attributes=False)
    calls=[]
    for node in ast.walk(tree):
        if not isinstance(node,ast.Call): continue
        if isinstance(node.func,ast.Name) and node.func.id=='validate_host_gate_assets':
            calls.append(ast.dump(node,include_attributes=False))
        elif (isinstance(node.func,ast.Attribute) and node.func.attr=='run'
              and isinstance(node.func.value,ast.Name) and node.func.value.id=='subprocess'
              and node.args and isinstance(node.args[0],ast.List)
              and node.args[0].elts and isinstance(node.args[0].elts[0],ast.Constant)
              and node.args[0].elts[0].value=='codesign'):
            calls.append(ast.dump(node,include_attributes=False))
    result['guarded_calls']=calls
    return result
print(json.dumps([inspect(source) for source in sources]))
`;
  const [original, current] = JSON.parse(execFileSync('python3', ['-B', '-c', inspect], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([
      fromBaseline('build_copy.py').toString(), readFileSync(new URL('build_copy.py', import.meta.url), 'utf8'),
    ]),
  }));
  assert.deepEqual(current, original, 'The UI builder must retain its non-UI baseline behavior');
  const inspectVerifier = String.raw`
import ast,json,sys
def dump(node): return ast.dump(node,include_attributes=False)
def inspect(source):
    functions={node.name:node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef)}
    result={name:dump(functions[name]) for name in ('require','read_header','packed_entries',
            'private_file','verify_voice_settings','verification_scope')}
    archive=functions['verify_archive']
    for node in ast.walk(archive):
        if isinstance(node,ast.Tuple):
            node.elts=[part for part in node.elts if not (isinstance(part,ast.Name) and part.id=='VOICE_TIMELINE_ASSET')]
    result['archive_integrity']=dump(archive)
    body=functions['verify_build'].body
    hook_index=next(i for i,node in enumerate(body) if isinstance(node,ast.Assign)
                    and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name)
                    and node.value.func.id=='verify_archive')
    result['identity_signature_profile_updater']=[dump(node) for node in body[:hook_index]]
    runtime_index=next(i for i,node in enumerate(body) if isinstance(node,ast.Assign)
                       and any(isinstance(target,ast.Name) and target.id=='main_hash' for target in node.targets))
    result['runtime_and_worker']=[dump(node) for node in body[runtime_index:-1]]
    report=body[-1].value
    result['report']={key.value:dump(value) for key,value in zip(report.keys,report.values)}
    return result
print(json.dumps([inspect(source) for source in json.load(sys.stdin)]))
`;
  const [oldVerifier, newVerifier] = JSON.parse(execFileSync('python3', ['-B', '-c', inspectVerifier], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([
      fromBaseline('verify_voice_build.py').toString(), readFileSync(new URL('verify_voice_build.py', import.meta.url), 'utf8'),
    ]),
  }));
  for (const key of Object.keys(oldVerifier.report)) {
    assert.equal(newVerifier.report[key], oldVerifier.report[key], `Existing verifier report field changed: ${key}`);
  }
  delete oldVerifier.report;
  delete newVerifier.report;
  assert.deepEqual(newVerifier, oldVerifier, 'UI verifier changes must preserve baseline integrity, identity, updater, and runtime checks');
});

function run(command, args, milliseconds = 120000) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
    // The acceptance runner creates a separate test process. Carrying Node's
    // internal child-test marker would make that process silently skip files.
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(command, args, {
      cwd: root, env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false;
    const append = chunk => { output = (output + chunk).slice(-300000); };
    child.stdout.setEncoding('utf8').on('data', append);
    child.stderr.setEncoding('utf8').on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, milliseconds);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) {
        reject(new Error(`${command} ${args.join(' ')} failed (${timedOut ? 'timeout' : signal ?? code})\n${output}`));
      } else resolve(output);
    });
  });
}

test('reviewed host renderer, saved-answer grouping, and native row geometry pass without skips', async () => {
  assert.ok(existsSync('/Applications/ChatGPT.app/Contents/Resources/app.asar'),
    'This local acceptance gate requires the reviewed official host; a skipped fixture is not acceptance');
  const result = await run('python3', ['-B', '-m', 'unittest', '-v',
    'test_speech_host_adapter', 'test_selection_host_adapter', 'test_verify_voice_build']);
  assert.match(result, /Ran [1-9]\d* tests?\b/);
  assert.match(result, /\bOK\s*$/);
  assert.doesNotMatch(result, /\bskipped\b/i);
});

test('actual native selection routing and real reading-controller integration pass without skips', async () => {
  const result = await run(process.execPath, ['--test', '--test-reporter=tap',
    'test-native-selection-host.mjs', 'test-selection-integration.mjs',
    'test-response-highlight.mjs', 'test-voice-response-groups.mjs']);
  assert.match(result, /# tests [1-9]\d*\b/);
  assert.match(result, /# fail 0\b/);
  assert.match(result, /# cancelled 0\b/);
  assert.match(result, /# skipped 0\b/);
});
