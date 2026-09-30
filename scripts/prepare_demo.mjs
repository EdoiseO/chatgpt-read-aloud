// Render source-only feature demonstrations; never connect to the installed app.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'output/playwright');
mkdirSync(out, { recursive: true });
const highlight = readFileSync(path.join(root, 'response-highlight.mjs'), 'utf8').replace(/^export /gm, '');
const picker = readFileSync(path.join(root, 'voice-picker.js'), 'utf8');
const safeScript = source => source.replace(/<\/script/gi, '<\\/script');
const speakerIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>';
const settingsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="10" cy="17" r="2" fill="currentColor" stroke="none"/></svg>';
const variants = {
  selection: { title: 'Read the part you need', description: 'Select a passage, then choose Read aloud.', state: 'Selected passage', footer: 'Only the selected passage is read.' },
  playback: { title: 'Follow one sentence at a time', description: 'A soft highlight follows the sentence being spoken.', state: 'Playing with Aoede', footer: 'Click the active speaker to stop. Choose another response to switch.' },
  voice: { title: 'Choose a voice you like', description: 'Preview a voice, then save your choice for future responses.', state: 'Voice picker', footer: 'Aoede (af_aoede) is the voice used in this project’s example setup.' },
};
for (const [kind, item] of Object.entries(variants)) {
  const script = `
${highlight}
const response = document.querySelector('#response');
const sentence = 'Break the work into small steps, and finish one step before moving to the next.';
const paragraph = response.querySelector('#passage');
if (${JSON.stringify(kind)} === 'selection') {
  const range = document.createRange(); range.selectNodeContents(paragraph);
  getSelection().removeAllRanges(); getSelection().addRange(range);
}
if (${JSON.stringify(kind)} === 'playback') {
  const map = buildResponseTextMap(response);
  const start = map.text.indexOf(sentence);
  const style = document.createElement('style'); style.textContent = RESPONSE_HIGHLIGHT_CSS; document.head.append(style);
  const highlighter = createResponseHighlighter(map); highlighter.onProgress({start, end:start+sentence.length});
}
if (${JSON.stringify(kind)} === 'voice') {
  // Actual picker rendering with illustrative metadata. No runtime or audio is used.
  const voices = [{id:'af_aoede',name:'Aoede',lang:'en-US'},{id:'af_bella',name:'Bella',lang:'en-US'},{id:'bm_george',name:'George',lang:'en-GB'}];
  let slot=0, id=0;
  const initial = [voices,'af_aoede',false,false,'',false];
  const React = {useState:()=>[initial[slot++],()=>{}],useRef:value=>({current:value}),useEffect:()=>{},useId:()=> 'demo-'+(++id)};
  const Fo=()=>React;
  const Y={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
${picker}
  function render(tree) {
    if(tree==null||typeof tree==='boolean') return document.createTextNode('');
    if(typeof tree!=='object') return document.createTextNode(String(tree));
    const node=document.createElement(tree.type);
    const props=tree.props||{};
    for(const [key,value] of Object.entries(props)) {
      if(key==='children'||key.startsWith('on')) continue;
      if(key==='ref') { value.current=node; continue; }
      if(key==='style') { Object.assign(node.style, Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='number'&&!['zIndex','fontWeight','lineHeight','opacity'].includes(k)?v+'px':v]))); continue; }
      if(key==='value') { node.dataset.selectedValue=value; continue; }
      if(key==='disabled') { node.disabled=!!value; continue; }
      if(value!=null) node.setAttribute(key==='htmlFor'?'for':key,String(value));
    }
    for(const child of Array.isArray(props.children)?props.children:[props.children]) node.append(render(child));
    if(node.dataset.selectedValue) node.value=node.dataset.selectedValue;
    return node;
  }
  document.body.append(render(CodexReadAloudVoicePicker({bridge:{},speaker:{},onClose:()=>{}})));
  document.querySelector('dialog')?.showModal();
}
`;
  const selectionMenu = kind==='selection' ? '<div class="selection-menu"><span>Add to chat</span><span>More details</span><span>Ask in side chat</span><button>Read aloud</button></div>' : '';
  const readIcon = kind==='playback' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>' : speakerIcon;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${item.title} · ChatGPT Read Aloud demo</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#131615;color:#f0f2ef;font:19px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{max-width:1040px;margin:54px auto}.header{display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{font-size:18px;font-weight:600;letter-spacing:-.2px}.badge,.state{font-size:13px;border:1px solid #3c4942;border-radius:20px;padding:5px 13px;color:#c3d4c8}.eyebrow{margin:32px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#9bada0}h1{font-size:34px;letter-spacing:-1px;margin:0;font-weight:600}.description{margin:8px 0 24px;color:#aab4ad;font-size:17px}.card{background:#1c211e;border:1px solid #343d37;border-radius:16px;padding:27px 32px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.assistant{font-size:14px;font-weight:600;color:#d3dbd5}.state{color:#d3cf9f;border-color:#514f3b;font-size:12px}p{margin:12px 0}#response strong{font-weight:650}#passage{margin:18px 0}.selection-menu{display:flex;width:max-content;align-items:center;gap:0;border:1px solid #535951;border-radius:10px;background:#30362f;margin-bottom:9px;box-shadow:0 7px 20px #0004;font-size:13px;line-height:1.3}.selection-menu>*{padding:10px 12px}.selection-menu>*+*{border-left:1px solid #484f46}.selection-menu button{background:#495645;color:white;border:0;border-left:1px solid #596554;border-radius:0 9px 9px 0;font:inherit;font-weight:600}.toolbar{display:flex;align-items:center;gap:8px;margin-top:23px;color:#a4afa6}.toolbar button{width:34px;height:34px;padding:5px;background:none;border:0;color:inherit}.toolbar svg{width:24px;height:24px}.toolbar .active{border-radius:9px;background:#3c493a;color:#e0ebda}.voice-tag{font-size:13px;margin-left:8px}.footer{margin:17px 4px;color:#9dab9f;font-size:14px}.note{display:flex;justify-content:space-between;gap:18px;margin-top:30px;font-size:12px;color:#7f9084}::selection{background:#375d91;color:#fff}dialog::backdrop{background:transparent}
</style><main><div class="header"><span class="brand">ChatGPT Read Aloud</span><span class="badge">Local reading aid</span></div><p class="eyebrow">Listen · Follow · Focus</p><h1>${item.title}</h1><p class="description">${item.description}</p><section class="card"><div class="top"><span class="assistant">Example response</span><span class="state">${item.state}</span></div>${selectionMenu}<div id="response"><p>A simple way to work through a long response is to give yourself <strong>one small task at a time.</strong></p><p id="passage">${'Break the work into small steps, and finish one step before moving to the next.'} You can return to the remaining details when you are ready.</p><p>Reading and listening together can be a useful personal preference. Choose the pace and voice that feel comfortable to you.</p></div><div class="toolbar"><button aria-label="Copy response"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="7" y="3" width="13" height="14" rx="3"/><rect x="3" y="7" width="13" height="14" rx="3"/></svg></button><button class="${kind==='playback'?'active':''}" aria-label="${kind==='playback'?'Stop reading aloud':'Read aloud'}">${readIcon}</button><button aria-label="Choose reading voice">${settingsIcon}</button><span class="voice-tag">Kokoro-82M · Aoede</span></div></section><p class="footer">${item.footer}</p><div class="note"><span>Standalone feature demonstration · sample text</span><span>Speech stays on your Mac after setup</span></div></main><script>${safeScript(script)}</script></html>`;
  writeFileSync(path.join(out, `demo-${kind}.html`), html);
}
console.log('Prepared three standalone feature pages in output/playwright/. No installed app or personal data used.');
