"""Pinned host menu integration for manual, read-only update discovery."""
import hashlib

HOST_MENU_ASSET = '.vite/build/main-DPn4U9E8.js'
HOST_MENU_SHA256 = 'a4f5c2a3370c1b50f1a1c371fe2ebe6d196152e6c245be0dcdf04b02e7cac172'
UPDATE_MAIN = '.vite/build/local-read-aloud-update-checker.cjs'

ORIGINAL_MENU_ITEM = 'wt={label:S.formatMessage({messageId:`electron.appMenu.app.checkForUpdates`,defaultMessage:`Check for Updates…`}),enabled:!0,click:()=>{_7().info(`Check for updates requested via menu.`),u.checkForUpdates().then(()=>{if(u.hasUpdater())return;let e=u.getUnavailableReason()??`unknown`;_7().warning(`Desktop updater unavailable; init likely skipped.`,{safe:{reason:e},sensitive:{}}),g.dialog.showMessageBox({type:`info`,title:`Updates Unavailable`,message:`Automatic updates are unavailable right now.`,detail:`Updater initialization skipped: ${e}`})})}},Tt='
PATCHED_MENU_ITEM = 'wt=require("./local-read-aloud-update-checker.cjs").installUpdateChecker(g).menuItemOptions(S.formatMessage({messageId:`electron.appMenu.app.checkForUpdates`,defaultMessage:`Check for Updates…`})),Tt='
ORIGINAL_MENU_LIST = 'Et=[Ae,{type:`separator`},ee,...c?[wt]:[],ce'
PATCHED_MENU_LIST = 'Et=[Ae,{type:`separator`},ee,wt,ce'


def _replace_once(source, old, new):
    if source.count(old) != 1 or new in source:
        raise RuntimeError('The update menu does not match the reviewed host.')
    return source.replace(old, new, 1)


def patch_update_menu(source):
    if hashlib.sha256(source.encode('utf-8')).hexdigest() != HOST_MENU_SHA256:
        raise RuntimeError('The host update menu changed; compatibility review is required.')
    source = _replace_once(source, ORIGINAL_MENU_ITEM, PATCHED_MENU_ITEM)
    return _replace_once(source, ORIGINAL_MENU_LIST, PATCHED_MENU_LIST)


def validate_update_menu(source):
    original = _replace_once(source, PATCHED_MENU_ITEM, ORIGINAL_MENU_ITEM)
    original = _replace_once(original, PATCHED_MENU_LIST, ORIGINAL_MENU_LIST)
    if hashlib.sha256(original.encode('utf-8')).hexdigest() != HOST_MENU_SHA256:
        raise RuntimeError('The bundled update menu differs from the reviewed adapter.')

