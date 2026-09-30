"""Reviewed speech integration for the supported desktop host's response renderer.

Keep this adapter separate from the speech engine. An upstream renderer change
must be reviewed, including its completed-response and transcript boundaries.
"""
import hashlib

TOOLBAR_ASSET = 'webview/assets/sites-end-resource-ac1aa5fe0447.js'
TOOLBAR_SHA256 = 'b812c93a6dc37c0d4069658d858a20f5430219ca916b65abdfde72a013a4a32b'
PAYLOAD_START = '\n/* BEGIN CODEX LOCAL SPEECH PAYLOAD */\n'
PAYLOAD_END = '\n/* END CODEX LOCAL SPEECH PAYLOAD */\n'

# Match the assistant entry inside the realtime transcript renderer. The host
# also hides action rows for silent automation completions; leave those alone.
TRANSCRIPT_ANCHOR = ('completed:!0,content:i,phase:null,sentAtMs:null,structuredOutput:void 0},'
                     'showActionRow:!1},`${e.role}-${String(t)}`)')
TRANSCRIPT_REPLACEMENT = TRANSCRIPT_ANCHOR.replace('showActionRow:!1', 'showActionRow:!0')
TOOLBAR_RETURN = ('let me;return t[44]!==M||t[45]!==ue||t[46]!==de||t[47]!==fe||t[48]!==pe?'
                  '(me=(0,Y.jsxs)(`div`,{ref:M,className:ue,children:[de,fe,pe]}),'
                  't[44]=M,t[45]=ue,t[46]=de,t[47]=fe,t[48]=pe,t[49]=me):me=t[49],me}')
READ_CONTROL = ('codexReadAloudCompleted===!0&&re!=null?'
                '(0,Y.jsx)(CodexLocalReadAloudButton,{getText:()=>Sr(f?.()??re),'
                'getHtml:()=>h?.(),getRoot:codexResponseRootGetter}):null')
# The speech controls are siblings of the host's hover-only controls. Render
# this small outer row afresh: its original compiler cache does not know about
# the new completed/root props, particularly when copying is allowed mid-stream.
VISIBLE_TOOLBAR_RETURN = ('return(0,Y.jsxs)(`div`,{ref:M,className:ue,children:['
                          + READ_CONTROL + ',de,fe,pe]})}')
PATCHES = (
    ('Response toolbar props', 'actionRowRef:M}=e,N=',
     'actionRowRef:M,readAloudCompleted:codexReadAloudCompleted,getReadAloudRoot:codexResponseRootGetter}=e,N='),
    ('Completed response routing', 'getCopyHtml:W?We:void 0,',
     'getCopyHtml:W?We:void 0,readAloudCompleted:n.completed===!0,'
     'getReadAloudRoot:()=>ye.current?.querySelector(`[data-selected-text-overlay-target]`),'),
    ('Visible speech controls', TOOLBAR_RETURN, VISIBLE_TOOLBAR_RETURN),
    ('Realtime assistant actions', TRANSCRIPT_ANCHOR, TRANSCRIPT_REPLACEMENT),
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
    return {'completedResponsesOnly': True, 'realtimeAssistantControls': True,
            'speechControlsAlwaysVisible': True, 'hostRendererSha256': TOOLBAR_SHA256}
