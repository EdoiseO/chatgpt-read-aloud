"""Reviewed speech integration for the supported desktop host's response renderer.

Keep this adapter separate from the speech engine. An upstream renderer change
must be reviewed, including its completed-response and transcript boundaries.
"""
import hashlib

ADAPTER_VERSION = 2
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
                '(0,Y.jsx)(`div`,{className:`mt-1.5 flex min-h-5 items-center gap-0.5`,'
                '"data-codex-local-read-aloud":"response-controls",'
                'children:(0,Y.jsx)(CodexLocalReadAloudButton,{getText:()=>Sr(Ie()),'
                'getHtml:We,' + ROOT_ROUTING + '})}):null')
# This root slot is independent of native toolbar visibility, copying and
# compact-thread mode. Only the reviewed assistant entry points opt in when
# showActionRow is false. Render the small outer root afresh: its original
# compiler cache does not track the added prop, and must not retain stale speech
# eligibility when a reused component switches between historical/live views.
VISIBLE_RESPONSE_RETURN = ('return(0,Y.jsxs)(`div`,{ref:jt,...Nt,className:Pt,title:Ft,'
                           'children:[It,Lt,Bt,Vt,' + READ_CONTROL + ']})}')
PATCHES = (
    ('Response speech eligibility', 'allowCopyWhileStreaming:z}=e,B=',
     'allowCopyWhileStreaming:z,readAloudStandalone:codexReadAloudStandalone}=e,B='),
    ('Visible completed-response speech slot', RESPONSE_RETURN, VISIBLE_RESPONSE_RETURN),
    ('Legacy transcript assistant speech', TRANSCRIPT_ANCHOR, TRANSCRIPT_REPLACEMENT),
)
VOICE_TIMELINE_PATCHES = (
    ('Canonical transcript assistant speech',
     'item:{type:`assistant-message`,completed:l?.completed??a.completed,content:u,phase:null,sentAtMs:null,structuredOutput:void 0},showActionRow:!1}',
     'item:{type:`assistant-message`,completed:l?.completed??a.completed,content:u,phase:null,sentAtMs:null,structuredOutput:void 0},showActionRow:!1,readAloudStandalone:!0}'),
    ('Promoted voice research speech',
     'item:v,markdownMediaCacheKey:o.presentationId,showActionRow:!1,turnId:o.turnId}',
     'item:v,markdownMediaCacheKey:o.presentationId,showActionRow:!1,readAloudStandalone:!0,turnId:o.turnId}'),
)


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
    return text


def validate_patched_voice_timeline(text):
    for description, before, after in reversed(VOICE_TIMELINE_PATCHES):
        text = replace_once(text, after, before, description)
    if hashlib.sha256(text.encode()).hexdigest() != VOICE_TIMELINE_SHA256:
        raise ValueError('Voice history renderer differs from the reviewed adapter')
    return {'historicalVoiceWorkControls': True, 'voiceTimelineSha256': VOICE_TIMELINE_SHA256}


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
            'speechControlsAlwaysVisible': True, 'hostRendererSha256': TOOLBAR_SHA256}
