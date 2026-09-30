"""Reviewed speech integration for the supported desktop host's response renderer.

Keep this adapter separate from the speech engine. An upstream renderer change
must be reviewed, including its completed-response and transcript boundaries.
"""
import hashlib
from pathlib import Path
import re

ADAPTER_VERSION = 4
TOOLBAR_ASSET = 'webview/assets/sites-end-resource-ac1aa5fe0447.js'
TOOLBAR_SHA256 = 'b812c93a6dc37c0d4069658d858a20f5430219ca916b65abdfde72a013a4a32b'
VOICE_TIMELINE_ASSET = 'webview/assets/local-conversation-thread-b33b65c9da1e.js'
VOICE_TIMELINE_SHA256 = 'f4ad55b38043b7f179c199e7657dbca5e33abdfe77612f41bdc87b0ed37ba261'
PAYLOAD_START = '\n/* BEGIN CODEX LOCAL SPEECH PAYLOAD */\n'
PAYLOAD_END = '\n/* END CODEX LOCAL SPEECH PAYLOAD */\n'

# Legacy transcript entries and canonical voice history are different render
# paths. Opt in their assistant roots while preserving the native action gates.
TRANSCRIPT_ANCHOR = ('completed:!0,content:i,phase:null,sentAtMs:null,structuredOutput:void 0},'
                     'showActionRow:!1},`${e.role}-${String(t)}`)')
TRANSCRIPT_REPLACEMENT = TRANSCRIPT_ANCHOR.replace('showActionRow:!1', 'showActionRow:!1,readAloudStandalone:!0')
ROOT_ROUTING = 'getRoot:()=>ye.current?.querySelector(`[data-selected-text-overlay-target]`)'
RESPONSE_RETURN = ('let Ht;return t[245]!==jt||t[246]!==Nt||t[247]!==Pt||t[248]!==Ft||'
                   't[249]!==It||t[250]!==Lt||t[251]!==Bt||t[252]!==Vt?'
                   '(Ht=(0,Y.jsxs)(`div`,{ref:jt,...Nt,className:Pt,title:Ft,children:[It,Lt,Bt,Vt]}),'
                   't[245]=jt,t[246]=Nt,t[247]=Pt,t[248]=Ft,t[249]=It,t[250]=Lt,t[251]=Bt,t[252]=Vt,t[253]=Ht):Ht=t[253],Ht}')
READ_CONTROL = ('(W||codexReadAloudStandalone===!0)&&n.completed===!0&&Le.trim().length>0?'
                '(0,Y.jsx)(CodexLocalReadAloudButton,{getText:()=>Sr(Ie()),'
                'getHtml:We,' + ROOT_ROUTING + '}):null')
NATIVE_ACTION_PROPS = ('alwaysShowActions:W&&(V||(w?.length??0)>0),turnId:W?i:void 0,'
                       'copyText:W&&Re?Le:void 0,getCopyText:W?Ie:void 0,getCopyHtml:W?We:void 0,'
                       'sentAtMs:ae?null:n.sentAtMs,threadId:f,reportEntityType:ie,'
                       'autoReviewStats:W?a:null,hookStats:W?o:null,memoryCitationEntries:W?Ke:cx,'
                       'completedThreadGoal:W&&n.completed?x:null,hasArtifacts:re,'
                       'onFork:W&&n.completed?b:void 0,showTimestampWithoutActions:oe,'
                       'timestampHoverOnly:se,additionalActions:S,trailingActions:T,persistentAdditionalActions:w')
NATIVE_ACTION_ROW = 'Je?(0,Y.jsx)(Xb,{' + NATIVE_ACTION_PROPS + '}):null'
SHARED_ACTION_ROW = ('!Et&&Je?(0,Y.jsx)(Xb,{' + NATIVE_ACTION_PROPS + ',readAloudControl:codexReadAloudControl}):'
                     'codexReadAloudControl==null?null:(0,Y.jsx)(`div`,{'
                     'className:`mt-1.5 flex min-h-5 items-center gap-0.5`,'
                     '"data-codex-local-read-aloud":"response-controls",children:codexReadAloudControl})')
TOOLBAR_RETURN = ('let me;return t[44]!==M||t[45]!==ue||t[46]!==de||t[47]!==fe||t[48]!==pe?'
                  '(me=(0,Y.jsxs)(`div`,{ref:M,className:ue,children:[de,fe,pe]}),'
                  't[44]=M,t[45]=ue,t[46]=de,t[47]=fe,t[48]=pe,t[49]=me):me=t[49],me}')
SHARED_TOOLBAR_RETURN = ('return(0,Y.jsxs)(`div`,{ref:M,className:ue,'
                         '"data-codex-local-read-aloud":codexReadAloudControl!=null?"response-controls":void 0,'
                         'children:[de,codexReadAloudControl,fe,pe]})}')
# Compute speech once, then place it beside the native controls when their row
# is available, otherwise in a speech-only row. Moving the action-row call out
# of the cached content fragment keeps eligibility/root props fresh. The host's
# native controls retain their placeholder guard, hover/focus opacity, and top margin;
# speech is a sibling, so it stays visible without creating another row.
VISIBLE_RESPONSE_RETURN = ('let codexReadAloudControl=' + READ_CONTROL + ';'
                           'return(0,Y.jsxs)(`div`,{ref:jt,...Nt,className:Pt,title:Ft,'
                           'children:[It,Lt,Bt,Vt,' + SHARED_ACTION_ROW + ']})}')
PATCHES = (
    ('Export shared speech control', 'export{cv as $,wE as A,',
     'export{CodexLocalReadAloudButton};export{cv as $,wE as A,'),
    ('Response speech eligibility', 'allowCopyWhileStreaming:z}=e,B=',
     'allowCopyWhileStreaming:z,readAloudStandalone:codexReadAloudStandalone}=e,B='),
    ('Move native actions beside speech', NATIVE_ACTION_ROW, 'null/* CODEX RESPONSE ACTIONS MOVED */'),
    ('Shared response toolbar prop', 'actionRowRef:M}=e,N=',
     'actionRowRef:M,readAloudControl:codexReadAloudControl}=e,N='),
    ('Speech keeps shared toolbar present', 'if(!(oe||O!=null||te&&b!=null))return null;',
     'if(!(oe||O!=null||te&&b!=null||codexReadAloudControl!=null))return null;'),
    ('Persistent speech beside native controls', TOOLBAR_RETURN, SHARED_TOOLBAR_RETURN),
    ('Visible completed-response speech slot', RESPONSE_RETURN, VISIBLE_RESPONSE_RETURN),
    ('Legacy transcript assistant speech', TRANSCRIPT_ANCHOR, TRANSCRIPT_REPLACEMENT),
)
VOICE_TIMELINE_PATCHES = (
    ('Canonical transcript assistant speech',
     'item:{type:`assistant-message`,completed:l?.completed??a.completed,content:u,phase:null,sentAtMs:null,structuredOutput:void 0},showActionRow:!1}',
     'item:{type:`assistant-message`,completed:l?.completed??a.completed,content:u,phase:null,sentAtMs:null,structuredOutput:void 0},showActionRow:!1,readAloudStandalone:!a.codexReadAloudGrouped}'),
    ('Promoted voice research speech',
     'item:v,markdownMediaCacheKey:o.presentationId,showActionRow:!1,turnId:o.turnId}',
     'item:v,markdownMediaCacheKey:o.presentationId,showActionRow:!1,readAloudStandalone:!o.codexReadAloudGrouped,turnId:o.turnId}'),
    ('Transcript grouping memo slot', 'function Ik(e){let t=(0,Lk.c)(19),', 'function Ik(e){let t=(0,Lk.c)(20),'),
    ('Transcript grouping memo dependency', 't[13]!==l?.completed||t[14]!==u?',
     't[13]!==l?.completed||t[14]!==u||t[19]!==a.codexReadAloudGrouped?'),
    ('Transcript grouping memo value', 't[13]=l?.completed,t[14]=u,t[15]=f)',
     't[13]=l?.completed,t[14]=u,t[15]=f,t[19]=a.codexReadAloudGrouped)'),
    ('Exact transcript speech root', '{"data-content-search-unit-key":d,children:f}',
     '{"data-content-search-unit-key":d,"data-codex-read-aloud-part":a.role===`assistant`&&u.trim()?`transcript:${a.id}`:void 0,'
     '"data-codex-read-aloud-owner":a.codexReadAloudGrouped,'
     '"data-codex-read-aloud-part-state":(l?.completed??a.completed)===!0?`complete`:`pending`,children:f}'),
    ('Research grouping memo slot', 'function Ek(e){let t=(0,Mk.c)(27),', 'function Ek(e){let t=(0,Mk.c)(28),'),
    ('Research grouping memo dependency', 't[20]!==o.turnId||t[21]!==v?',
     't[20]!==o.turnId||t[21]!==v||t[27]!==o.codexReadAloudGrouped?'),
    ('Research grouping memo value', 't[20]=o.turnId,t[21]=v,t[22]=y)',
     't[20]=o.turnId,t[21]=v,t[22]=y,t[27]=o.codexReadAloudGrouped)'),
    ('Exact research speech root', '{"data-content-search-turn-key":s,"data-content-search-unit-key":g,children:y}',
     '{"data-content-search-turn-key":s,"data-content-search-unit-key":g,'
     '"data-codex-read-aloud-part":h.trim()?`presentation:${o.presentationId}`:void 0,'
     '"data-codex-read-aloud-owner":o.codexReadAloudGrouped,'
     '"data-codex-read-aloud-part-state":_===!0?`complete`:`pending`,children:y}'),
    ('Render canonical speech group', 'function Fk(e){let t=(0,Lk.c)(19),',
     'function Fk(e){let t=(0,Lk.c)(19);if(e.block.codexReadAloudGroup)return(0,Rk.jsx)(CodexVoiceReadGroup,{entry:{...e,turnKey:e.turnSearchKey},latestTurnFooter:e.readAloudLatestTurnFooter,latestTurnFollowContentRef:e.readAloudLatestTurnFollowContentRef});let '),
    ('Voice group footer memo slots', 'function iA(e){let t=(0,uA.c)(39),',
     'function iA(e){let t=(0,uA.c)(41),'),
    ('Voice group footer memo dependencies', 't[9]!==n.hostId||t[10]!==n.turnKey?',
     't[9]!==n.hostId||t[10]!==n.turnKey||t[39]!==r||t[40]!==i?'),
    ('Voice group footer forwarding', 'hostId:n.hostId,turnSearchKey:n.turnKey}),t[6]=n.block',
     'hostId:n.hostId,turnSearchKey:n.turnKey,readAloudLatestTurnFooter:r,readAloudLatestTurnFollowContentRef:i}),t[6]=n.block'),
    ('Voice group footer memo values', 't[9]=n.hostId,t[10]=n.turnKey,t[11]=e)',
     't[9]=n.hostId,t[10]=n.turnKey,t[11]=e,t[39]=r,t[40]=i)'),
    ('Group canonical projected responses', 'return KD(XD({entries:h,projectedEntries:x,projectedTurnIds:b}))}',
     'return codexGroupVoiceResponses(KD(XD({entries:h,projectedEntries:x,projectedTurnIds:b})),r.timeline)}'),
    ('Search grouped response children', 'function fk(e,t=Ea){let n=new Set;',
     'function fk(e,t=Ea){e=codexVoiceGroupEntries(e);let n=new Set;'),
    ('Bookmark grouped response children', 'function LA({entries:e,isConversationHistoryComplete:t}){if(!t)return BA;',
     'function LA({entries:e,isConversationHistoryComplete:t}){if(!t)return BA;e=codexVoiceGroupEntries(e);'),
    ('Resolve grouped navigation keys',
     'let e=new Map;for(let t of Yt)Sg(t)&&(e.has(t.turnKey)||e.set(t.turnKey,t.turnKey),e.has(t.turnSearchKey)||e.set(t.turnSearchKey,t.turnKey),t.sourceTurnSearchKey!=null&&!e.has(t.sourceTurnSearchKey)&&e.set(t.sourceTurnSearchKey,t.turnKey));return e',
     'let e=new Map;for(let[t,n]of codexVoiceNavigationEntries(Yt)){t.turnKey!=null&&!e.has(t.turnKey)&&e.set(t.turnKey,n);Sg(t)&&(e.has(t.turnSearchKey)||e.set(t.turnSearchKey,n),t.sourceTurnSearchKey!=null&&!e.has(t.sourceTurnSearchKey)&&e.set(t.sourceTurnSearchKey,n))}return e'),
)

GROUP_IMPORT = 'import{CodexLocalReadAloudButton}from"./sites-end-resource-ac1aa5fe0447.js";\n'
GROUP_START = '\n/* BEGIN CODEX VOICE RESPONSE GROUPS */\n'
GROUP_END = '\n/* END CODEX VOICE RESPONSE GROUPS */\n'


def group_payload():
    root = Path(__file__).resolve().parent
    return '\n'.join(re.sub(r'^export ', '', (root / name).read_text(), flags=re.M)
                     for name in ('voice-response-groups.mjs', 'voice-response-group-host.js'))


def replace_once(text, before, after, description):
    if text.count(before) != 1:
        raise ValueError(f'{description} does not match the reviewed speech host')
    return text.replace(before, after, 1)


def validate_original_toolbar(text):
    if hashlib.sha256(text.encode()).hexdigest() != TOOLBAR_SHA256:
        raise ValueError('Speech host renderer changed; review compatibility before rebuilding')


def patch_toolbar(text):
    validate_original_toolbar(text)
    for description, before, after in PATCHES:
        text = replace_once(text, before, after, description)
    return text


def patch_voice_timeline(text):
    if hashlib.sha256(text.encode()).hexdigest() != VOICE_TIMELINE_SHA256:
        raise ValueError('Voice history renderer changed; review compatibility before rebuilding')
    for description, before, after in VOICE_TIMELINE_PATCHES:
        text = replace_once(text, before, after, description)
    marker = text.rfind('export{')
    if marker < 0:
        raise ValueError('Voice history export boundary is missing')
    return GROUP_IMPORT + text[:marker] + GROUP_START + group_payload() + GROUP_END + text[marker:]


def validate_patched_voice_timeline(text):
    text = replace_once(text, GROUP_IMPORT, '', 'Voice group component import')
    text = replace_once(text, GROUP_START + group_payload() + GROUP_END, '', 'Voice grouping helper')
    for description, before, after in reversed(VOICE_TIMELINE_PATCHES):
        text = replace_once(text, after, before, description)
    if hashlib.sha256(text.encode()).hexdigest() != VOICE_TIMELINE_SHA256:
        raise ValueError('Voice history renderer differs from the reviewed adapter')
    return {'historicalVoiceWorkControls': True, 'canonicalVoiceResponseGrouping': True,
            'voiceTimelineSha256': VOICE_TIMELINE_SHA256}


def append_payload(text, payload):
    marker = text.rfind('export{')
    if marker < 0 or PAYLOAD_START in text or PAYLOAD_END in text:
        raise ValueError('Speech host export or payload boundary is invalid')
    return text[:marker] + PAYLOAD_START + payload + PAYLOAD_END + text[marker:]


def validate_patched_toolbar(text):
    """Reverse the reviewed edits and verify every remaining host byte."""
    if text.count(PAYLOAD_START) != 1 or text.count(PAYLOAD_END) != 1:
        raise ValueError('Speech payload boundaries are missing or duplicated')
    before, remainder = text.split(PAYLOAD_START)
    payload, after = remainder.split(PAYLOAD_END)
    if not payload.strip() or not after.startswith('export{'):
        raise ValueError('Speech payload boundary moved outside the host export')
    restored = before + after
    for description, original, replacement in reversed(PATCHES):
        restored = replace_once(restored, replacement, original, description)
    validate_original_toolbar(restored)
    return {'adapterVersion': ADAPTER_VERSION, 'completedResponsesOnly': True, 'realtimeAssistantControls': True,
            'speechControlsAlwaysVisible': True, 'sharedResponseActionRow': True,
            'hostRendererSha256': TOOLBAR_SHA256}
