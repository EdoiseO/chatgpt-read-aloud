"""Narrow selection-menu adapter for the pinned desktop host.

The registry owns speech eligibility. Its optional global
``codexResolveReadAloudSelection(range)`` returns ``{root}`` only for a range
wholly owned by one registered logical answer. This adapter never infers an
answer from DOM ancestry. Native actions retain the host's original target and
clipping; speech receives the original range. A registry-approved selection
across native targets has speech actions only.

No app, archive, or filesystem mutation happens in this module. The builder
calls patch_selection_menu once on the original asset text.
"""

import hashlib

HOST_ASSET = "webview/assets/app-primary-92c16ff2fe4e.js"
HOST_SHA256 = "4ecf05d89f80080ce52ee7f99d80b8c2fddcdc66744684649369c65683e09f17"

SELECTION_BUTTON = '''globalThis.codexCanReadSelectionAloud?.(codexSelectionRoot,codexSelectionRange)?(0,UG.jsx)(HT,{"aria-label":"Read aloud","data-codex-local-read-aloud":"selection",onMouseDown:event=>event.preventDefault(),onClick:event=>{event.stopPropagation();globalThis.codexReadSelectionAloud(codexSelectionRoot,codexSelectionRange)},children:"Read aloud"}):null'''

_J4E = '''function J4e(e,t,n){let r=Y4e(e.anchorNode,e.anchorOffset,n),i=Y4e(e.focusNode,e.focusOffset,n);if(r!=null&&i!=null&&r.target!==i.target)return null;let a=r??i;return a==null||a.element.closest(`[contenteditable="true"]`)!=null?null:{...a,range:X4e(t,a.target)}}'''

_OWNER = '''function codexReadAloudSelectionOwner(range){try{let owner=globalThis.codexResolveReadAloudSelection?.(range),root=owner?.root;return root instanceof HTMLElement&&root.isConnected&&!range.collapsed&&root.contains(range.startContainer)&&root.contains(range.endContainer)?owner:null}catch{return null}}'''

_PATCHED_J4E = _OWNER + '''function J4e(e,t,n){let r=Y4e(e.anchorNode,e.anchorOffset,n),i=Y4e(e.focusNode,e.focusOffset,n);if(r?.element.closest(`[contenteditable="true"]`)!=null||i?.element.closest(`[contenteditable="true"]`)!=null)return null;let a=r??i;if(a==null)return null;let owner=codexReadAloudSelectionOwner(t),speechRoot=typeof globalThis.codexResolveReadAloudSelection===`function`?owner?.root??null:a.target;if(r!=null&&i!=null&&r.target!==i.target)return owner==null?null:{element:a.element,target:owner.root,range:t.cloneRange(),codexReadAloudRoot:owner.root,codexReadAloudRange:t.cloneRange(),codexReadAloudOnly:!0};return{...a,range:X4e(t,a.target),codexReadAloudRoot:speechRoot,codexReadAloudRange:t.cloneRange(),codexReadAloudOnly:!1}}'''

_SNAPSHOT = 'selectionRange:o.range.cloneRange(),selectedText:s,target:o.target,targetId:o.target.getAttribute(bTe),viewportHorizontalBounds:m}'
_PATCHED_SNAPSHOT = 'selectionRange:o.range.cloneRange(),selectedText:s,target:o.target,targetId:o.target.getAttribute(bTe),viewportHorizontalBounds:m,codexReadAloudRoot:o.codexReadAloudRoot,codexReadAloudRange:o.codexReadAloudRange,codexReadAloudOnly:o.codexReadAloudOnly}'
_EQUALITY = 'function q4e(e,t){return e!=null&&t!=null&&e.direction===t.direction'
_PATCHED_EQUALITY = 'function q4e(e,t){return e!=null&&t!=null&&e.codexReadAloudRoot===t.codexReadAloudRoot&&e.codexReadAloudOnly===t.codexReadAloudOnly&&e.codexReadAloudRange?.startContainer===t.codexReadAloudRange?.startContainer&&e.codexReadAloudRange?.startOffset===t.codexReadAloudRange?.startOffset&&e.codexReadAloudRange?.endContainer===t.codexReadAloudRange?.endContainer&&e.codexReadAloudRange?.endOffset===t.codexReadAloudRange?.endOffset&&e.direction===t.direction'
_GATE = 's=Gm();if(n==null&&r==null&&i==null)return null;'
_PATCHED_GATE = 's=Gm();if(n==null&&r==null&&i==null&&typeof globalThis.codexResolveReadAloudSelection!==`function`)return null;'
_CALLBACK = 'let{portalTarget:a,rect:o,selectedText:c,selectionRange:l,target:u}=e,d=WCe(u,l,c);'
_PATCHED_CALLBACK = 'let{portalTarget:a,rect:o,selectedText:c,selectionRange:l,target:u,codexReadAloudRoot,codexReadAloudRange,codexReadAloudOnly}=e;if((codexReadAloudOnly||n==null&&r==null&&i==null)&&!globalThis.codexCanReadSelectionAloud?.(codexReadAloudRoot,codexReadAloudRange))return null;let d=codexReadAloudOnly?null:WCe(u,l,c);'
_DETAILS = 'onMoreDetails:r==null?void 0:e=>r(e,u),onOpenSideChat:i})})},t[0]=n,t[1]=r,t[2]=i,t[3]=s'
_PATCHED_DETAILS = 'onMoreDetails:codexReadAloudOnly||r==null?void 0:e=>r(e,u),onOpenSideChat:codexReadAloudOnly?void 0:i,readAloudRoot:codexReadAloudRoot,readAloudRange:codexReadAloudRange})})},t[0]=n,t[1]=r,t[2]=i,t[3]=s'
_PROPS = 'resume:l,selectedText:u}=e,d=n===void 0?'
_PATCHED_PROPS = 'resume:l,selectedText:u,readAloudRoot:codexSelectionRoot,readAloudRange:codexSelectionRange}=e,d=n===void 0?'
_RETURN = 'let S;return t[41]!==_||t[42]!==v||t[43]!==y||t[44]!==b||t[45]!==x?(S=(0,UG.jsxs)(lje,{children:[_,v,y,b,x]}),t[41]=_,t[42]=v,t[43]=y,t[44]=b,t[45]=x,t[46]=S):S=t[46],S}var a3e,HG,UG;'
_PATCHED_RETURN = 'return(0,UG.jsxs)(lje,{children:[_,v,y,b,x,' + SELECTION_BUTTON + ']})}var a3e,HG,UG;'

_HOST_REPLACEMENTS = (
    (_J4E, _PATCHED_J4E, "selection target resolver"),
    (_SNAPSHOT, _PATCHED_SNAPSHOT, "exact selection snapshot"),
    (_EQUALITY, _PATCHED_EQUALITY, "selection snapshot equality"),
    (_GATE, _PATCHED_GATE, "speech-only menu availability"),
    (_CALLBACK, _PATCHED_CALLBACK, "native annotation boundary"),
    (_DETAILS, _PATCHED_DETAILS, "native action boundary and speech routing"),
)
_MENU_REPLACEMENTS = (
    (_PROPS, _PATCHED_PROPS, "selection menu props"),
    (_RETURN, _PATCHED_RETURN, "selection menu action"),
)


def _validate(text, replacements):
    for original, patched, label in replacements:
        if text.count(original) != 1 or patched in text:
            raise ValueError(f"Unsupported host: expected one original {label}")


def _validate_hash(text, expected_sha):
    if expected_sha is None:
        expected_sha = HOST_SHA256
    actual = hashlib.sha256(text.encode()).hexdigest()
    if actual != expected_sha:
        raise ValueError(f"Unsupported selection host SHA-256: {actual}")


def validate_selection_host(text, *, expected_sha=None):
    """Fail closed before any edit if the host selection anchors have changed."""
    _validate_hash(text, expected_sha)
    _validate(text, _HOST_REPLACEMENTS)
    if "function codexReadAloudSelectionOwner(" in text:
        raise ValueError("Selection host adapter is already present")


def validate_selection_menu(text, *, expected_sha=None):
    """Validate the original host pipeline and original native menu together."""
    validate_selection_host(text, expected_sha=expected_sha)
    _validate(text, _MENU_REPLACEMENTS)


def _replace(text, replacements):
    for original, patched, _ in replacements:
        text = text.replace(original, patched, 1)
    return text


def patch_selection_host(text, *, expected_sha=None):
    """Patch ownership/range routing without inserting the speech menu button."""
    validate_selection_host(text, expected_sha=expected_sha)
    return _replace(text, _HOST_REPLACEMENTS)


def patch_selection_menu(text, *, expected_sha=None):
    """One builder entry point: original asset in, full selection adapter out."""
    validate_selection_menu(text, expected_sha=expected_sha)
    return _replace(patch_selection_host(text, expected_sha=expected_sha), _MENU_REPLACEMENTS)


def restore_selection_menu(text, *, expected_sha=None):
    """Verify every patched anchor and reconstruct the exact original asset."""
    for original, patched, label in reversed(_HOST_REPLACEMENTS + _MENU_REPLACEMENTS):
        if text.count(patched) != 1:
            raise ValueError(f"Invalid patched selection host: {label}")
        text = text.replace(patched, original, 1)
    validate_selection_menu(text, expected_sha=expected_sha)
    return text


def verify_patched_selection_menu(text, *, expected_sha=None):
    """Reject modified adapter code or unrelated changes to the pinned asset."""
    original = restore_selection_menu(text, expected_sha=expected_sha)
    return {"hostSelectionSha256": hashlib.sha256(original.encode()).hexdigest(),
            "exactSelectionRouting": True}


validate_patched_selection_menu = verify_patched_selection_menu
