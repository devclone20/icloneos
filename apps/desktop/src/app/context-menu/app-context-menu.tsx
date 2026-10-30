import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { terminalMenuHandleFor } from '@/app/right-sidebar/terminal/terminal-context-menu'
import { type Translations, useI18n } from '@/i18n'
import { hostPathLabel, normalizeExternalUrl, openExternalLink } from '@/lib/external-link'
import {
  AppWindow,
  Bookmark,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileImage,
  Globe,
  Pencil,
  Plus,
  Search,
  Settings,
  Square
} from '@/lib/icons'
import { isRemoteGateway } from '@/lib/media'
import { reachablePreviewUrl } from '@/lib/preview-reach'
import { openCommandPalette } from '@/store/command-palette'
import { openPreview } from '@/store/preview'
import { requestActiveUpdate } from '@/store/updates'
import { canOpenNewWindow, openNewWindow } from '@/store/windows'

import { navigateToWorkspacePage, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../routes'

import { writeClipboardText } from './clipboard'
import { ContextMenuSurface, Item } from './menu'
import {
  $contextMenu,
  augmentSpellcheck,
  closeContextMenu,
  type OpenContextMenu,
  openDomContextMenu,
  openTerminalContextMenu
} from './store'
import { isWebUrl, resolveDomTarget } from './target'

/**
 * Surfaces that still bring their own context menu stamp this attribute on
 * their trigger (`components/ui/context-menu.tsx` writes it; the status bar
 * footer is one). The literal lives here because the menu must not import the
 * component library it replaced — LEAD: when that file is rebuilt or deleted,
 * the attribute name gets one home and this const goes.
 */
const HERMES_CONTEXT_MENU_TRIGGER_ATTR = 'data-hermes-context-menu-trigger'

/** Marks a surface that owns PLAIN right-clicks itself (the user-message
 *  reaction bubble). Owned targets inside it — links, images, editables,
 *  selections — still get the app menu. */
const CONTEXT_MENU_SKIP_ATTR = 'data-context-menu-skip'

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i

// Accelerators shown beside the edit verbs. Display only — Chromium's
// before-input-event handling already executes the chords; the menu just
// advertises them the way the native menu did. Canonical combos, not formatted
// strings: `PaletteKeys` splits them into our key caps, so the menu and the
// keybind panel can never disagree about what ⌘ looks like.
const EDIT_SHORTCUTS = {
  copy: 'mod+c',
  cut: 'mod+x',
  paste: 'mod+v',
  selectAll: 'mod+a'
} as const

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOST_RE.test(new URL(url).hostname)
  } catch {
    return false
  }
}

type ShellVerbs = {
  navigate: ReturnType<typeof useNavigate>
  t: Translations
}

function terminalSections(open: Extract<OpenContextMenu, { kind: 'terminal' }>, t: Translations): ReactNode[][] {
  const { terminal } = open
  const selection = terminal.getSelection()

  return [
    [
      selection ? (
        <Item
          icon={Copy}
          key="terminal-copy"
          label={t.common.copy}
          onSelect={() => void writeClipboardText(selection)}
        />
      ) : null,
      terminal.paste ? (
        <Item
          disabled={!open.clipboardHasText}
          icon={Clipboard}
          key="terminal-paste"
          label={t.contextMenu.edit.paste}
          onSelect={() =>
            void window.hermesDesktop?.readClipboard().then(text => (text ? terminal.paste?.(text) : undefined))
          }
        />
      ) : null,
      <Item
        icon={Square}
        key="terminal-select-all"
        label={t.contextMenu.edit.selectAll}
        onSelect={() => terminal.selectAll()}
      />
    ].filter(Boolean)
  ]
}

/** Open in the app (web links only), open externally, copy — the link verbs
 *  shared by the dom and guest menus. */
function linkItems(linkUrl: string, copy: Translations['contextMenu'], keyPrefix: string): ReactNode[] {
  return [
    isWebUrl(linkUrl) ? (
      <Item
        icon={Globe}
        key={`${keyPrefix}-open-app`}
        label={copy.link.openInApp}
        onSelect={() =>
          openPreview({ kind: 'url', label: hostPathLabel(linkUrl), source: linkUrl, url: linkUrl }, 'explicit-link')
        }
      />
    ) : null,
    <Item
      icon={ExternalLink}
      key={`${keyPrefix}-open-external`}
      label={copy.link.openExternal}
      onSelect={() => openExternalLink(linkUrl)}
    />,
    <Item
      icon={Copy}
      key={`${keyPrefix}-copy`}
      label={copy.link.copyUrl}
      onSelect={() => void writeClipboardText(linkUrl)}
    />
  ]
}

function domSections(open: Extract<OpenContextMenu, { kind: 'dom' }>, t: Translations): ReactNode[][] {
  const copy = t.contextMenu
  const { spellcheck, target } = open
  const sections: ReactNode[][] = []
  const linkUrl = target.linkUrl ? normalizeExternalUrl(target.linkUrl) : ''
  const imageIsWeb = isWebUrl(target.imageUrl)
  const showResolvedCopy = isWebUrl(linkUrl) && isRemoteGateway() && isLoopbackUrl(linkUrl)

  // The edit verbs and spell-check actions act on the sender's FOCUSED
  // element in main, and OUR menu holds focus while it is open (menu.tsx):
  // dispatching with the menu up runs the command against the menu card, so
  // select-all grabs the WHOLE transcript instead of the field. Close first,
  // then focus the editable and dispatch on the NEXT FRAME: the close is a
  // store write, so the menu is still mounted for the rest of this handler
  // and its own focus restore has not run yet. One frame later it has, and
  // this focus() is the last word.
  const withEditableFocus = (action: () => void) => {
    const editable = target.editable

    closeContextMenu()
    requestAnimationFrame(() => {
      editable?.focus()
      action()
    })
  }

  const editableCommand = (command: 'copy' | 'cut' | 'paste') => {
    withEditableFocus(() => void window.hermesDesktop?.contextMenuEdit?.(command))
  }

  // Select all runs entirely in the renderer, scoped to the editable itself.
  // Main's selectAll acts on whatever the FOCUSED FRAME considers "all" and
  // has no notion of the field the menu was opened on — with any focus slip
  // (the edit composer re-parents focus on blur) it selected the whole
  // transcript. A renderer range cannot escape the field.
  const selectAllInEditable = () => {
    withEditableFocus(() => {
      const editable = target.editable

      if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
        editable.select()

        return
      }

      if (editable) {
        const range = document.createRange()

        range.selectNodeContents(editable)

        const selection = window.getSelection()

        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    })
  }

  const spellcheckAction = (action: { kind: 'add' | 'replace'; word: string }) => {
    withEditableFocus(() => void window.hermesDesktop?.contextMenuSpellcheck?.(action))
  }

  if (linkUrl) {
    sections.push(
      [
        ...linkItems(linkUrl, copy, 'link'),
        showResolvedCopy ? (
          <Item
            icon={Copy}
            key="link-copy-resolved"
            label={copy.link.copyResolvedUrl}
            onSelect={() => void reachablePreviewUrl(linkUrl).then(writeClipboardText)}
          />
        ) : null
      ].filter(Boolean)
    )
  }

  if (target.onImage) {
    sections.push(
      [
        imageIsWeb ? (
          <Item
            icon={Globe}
            key="image-open-app"
            label={copy.link.openInApp}
            onSelect={() =>
              openPreview(
                { kind: 'url', label: hostPathLabel(target.imageUrl), source: target.imageUrl, url: target.imageUrl },
                'explicit-link'
              )
            }
          />
        ) : null,
        imageIsWeb ? (
          <Item
            icon={ExternalLink}
            key="image-open-external"
            label={copy.link.openExternal}
            onSelect={() => openExternalLink(target.imageUrl)}
          />
        ) : null,
        <Item
          icon={FileImage}
          key="image-copy"
          label={copy.image.copyImage}
          onSelect={() => void window.hermesDesktop?.contextMenuCopyImage?.()}
        />,
        target.imageUrl ? (
          <Item
            icon={Copy}
            key="image-copy-address"
            label={copy.image.copyImageAddress}
            onSelect={() => void writeClipboardText(target.imageUrl)}
          />
        ) : null,
        target.imageUrl ? (
          <Item
            icon={Download}
            key="image-save"
            label={copy.image.saveImageAs}
            onSelect={() => void window.hermesDesktop?.saveImageFromUrl?.(target.imageUrl)}
          />
        ) : null
      ].filter(Boolean)
    )
  }

  if (target.editable) {
    if (spellcheck) {
      sections.push([
        ...spellcheck.suggestions
          .slice(0, 5)
          .map(suggestion => (
            <Item
              icon={Pencil}
              key={`spell-${suggestion}`}
              label={suggestion}
              onSelect={() => spellcheckAction({ kind: 'replace', word: suggestion })}
            />
          )),
        <Item
          icon={Bookmark}
          key="spell-add"
          label={copy.edit.addToDictionary}
          onSelect={() => spellcheckAction({ kind: 'add', word: spellcheck.misspelledWord })}
        />
      ])
    }

    // Verb availability mirrors the native menu: cut/copy act on the
    // SELECTION, so they need selected text — not just field content.
    // Inputs and textareas carry their selection on the element (Chrome
    // never reflects it into window.getSelection()); contenteditable uses
    // the document selection the resolver captured. Select all needs the
    // field to hold anything. Paste is intentionally NOT gated on a
    // clipboard probe: its action is webContents.paste() in main — the
    // same path Ctrl+V takes — which resolves the system clipboard itself,
    // while the renderer-side readClipboard probe can report empty on
    // Windows even when that path succeeds (#91553). Pasting with an
    // empty clipboard is a harmless no-op, so the item fails open.
    const formField =
      target.editable instanceof HTMLInputElement || target.editable instanceof HTMLTextAreaElement
        ? target.editable
        : null

    const fieldText = formField ? formField.value : (target.editable?.textContent ?? '')

    const hasFieldText = fieldText.length > 0

    const canCutCopy = formField
      ? (formField.selectionStart ?? 0) !== (formField.selectionEnd ?? 0)
      : target.selectionText.length > 0

    sections.push([
      <Item
        disabled={!canCutCopy}
        key="edit-cut"
        label={copy.edit.cut}
        onSelect={() => editableCommand('cut')}
        shortcut={EDIT_SHORTCUTS.cut}
      />,
      <Item
        disabled={!canCutCopy}
        key="edit-copy"
        label={t.common.copy}
        onSelect={() => editableCommand('copy')}
        shortcut={EDIT_SHORTCUTS.copy}
      />,
      <Item
        key="edit-paste"
        label={copy.edit.paste}
        onSelect={() => editableCommand('paste')}
        shortcut={EDIT_SHORTCUTS.paste}
      />
    ])
    sections.push([
      <Item
        disabled={!hasFieldText}
        key="edit-select-all"
        label={copy.edit.selectAll}
        onSelect={selectAllInEditable}
        shortcut={EDIT_SHORTCUTS.selectAll}
      />
    ])
  } else if (target.selectionText) {
    sections.push([
      <Item
        icon={Copy}
        key="selection-copy"
        label={t.common.copy}
        onSelect={() => void writeClipboardText(target.selectionText)}
      />
    ])
  }

  return sections
}

/** The guest (in-app browser) menu: link/image/selection/editable sections
 *  from the Chromium params, plus select all for the page, closed by
 *  Inspect element. The page-level verbs (copy URL, open externally,
 *  console) live on the browser bar, not here. */
function guestSections(open: Extract<OpenContextMenu, { kind: 'guest' }>, t: Translations): ReactNode[][] {
  const copy = t.contextMenu
  const { guest, params } = open
  const sections: ReactNode[][] = []
  const linkUrl = params.linkURL
  const imageUrl = params.srcURL

  // Same timing rule as the dom side, and the webview makes it stricter: the
  // guest only answers an edit command while it has focus, and the menu card
  // holds focus until it unmounts — so the dispatch waits a frame for the
  // close to land and for the menu to hand focus back.
  const guestEdit = (command: 'copy' | 'cut' | 'paste' | 'selectAll') => {
    closeContextMenu()
    requestAnimationFrame(() => guest.editCommand(command))
  }

  if (linkUrl) {
    sections.push(linkItems(linkUrl, copy, 'guest-link').filter(Boolean))
  }

  if (params.hasImageContents || imageUrl) {
    sections.push(
      [
        isWebUrl(imageUrl) ? (
          <Item
            icon={ExternalLink}
            key="guest-image-open-external"
            label={copy.link.openExternal}
            onSelect={() => openExternalLink(imageUrl)}
          />
        ) : null,
        params.hasImageContents ? (
          <Item icon={FileImage} key="guest-image-copy" label={copy.image.copyImage} onSelect={guest.copyImage} />
        ) : null,
        imageUrl ? (
          <Item
            icon={Copy}
            key="guest-image-copy-address"
            label={copy.image.copyImageAddress}
            onSelect={() => void writeClipboardText(imageUrl)}
          />
        ) : null,
        imageUrl ? (
          <Item
            icon={Download}
            key="guest-image-save"
            label={copy.image.saveImageAs}
            onSelect={() => void window.hermesDesktop?.saveImageFromUrl?.(imageUrl)}
          />
        ) : null
      ].filter(Boolean)
    )
  }

  if (params.isEditable) {
    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      sections.push([
        ...params.dictionarySuggestions
          .slice(0, 5)
          .map(suggestion => (
            <Item
              icon={Pencil}
              key={`guest-spell-${suggestion}`}
              label={suggestion}
              onSelect={() => guest.replaceMisspelling(suggestion)}
            />
          )),
        <Item
          icon={Bookmark}
          key="guest-spell-add"
          label={copy.edit.addToDictionary}
          onSelect={() => guest.addToDictionary(params.misspelledWord)}
        />
      ])
    }

    // Chromium's editFlags gate the verbs — the same availability verdict
    // the native menu showed (empty field → no cut/copy/select-all, empty
    // clipboard → no paste).
    sections.push([
      <Item
        disabled={!params.editFlags.canCut}
        key="guest-edit-cut"
        label={copy.edit.cut}
        onSelect={() => guestEdit('cut')}
        shortcut={EDIT_SHORTCUTS.cut}
      />,
      <Item
        disabled={!params.editFlags.canCopy}
        key="guest-edit-copy"
        label={t.common.copy}
        onSelect={() => guestEdit('copy')}
        shortcut={EDIT_SHORTCUTS.copy}
      />,
      <Item
        disabled={!params.editFlags.canPaste}
        key="guest-edit-paste"
        label={copy.edit.paste}
        onSelect={() => guestEdit('paste')}
        shortcut={EDIT_SHORTCUTS.paste}
      />
    ])
    sections.push([
      <Item
        disabled={!params.editFlags.canSelectAll}
        key="guest-edit-select-all"
        label={copy.edit.selectAll}
        onSelect={() => guestEdit('selectAll')}
        shortcut={EDIT_SHORTCUTS.selectAll}
      />
    ])
  } else if (params.selectionText.trim()) {
    sections.push([
      <Item icon={Copy} key="guest-selection-copy" label={t.common.copy} onSelect={() => guestEdit('copy')} />
    ])
  }

  // Text tool for the page itself: select all works everywhere Chromium
  // says it can (a bare page has no field to scope to, so it selects the
  // page content).
  if (!params.isEditable) {
    sections.push([
      <Item
        disabled={!params.editFlags.canSelectAll}
        key="guest-select-all"
        label={copy.edit.selectAll}
        onSelect={() => guestEdit('selectAll')}
        shortcut={EDIT_SHORTCUTS.selectAll}
      />
    ])
  }

  // Inspect element closes every guest menu — the one page tool that earns
  // its place on any click. The other page verbs (copy URL, open
  // externally, console) live on the browser bar only.
  sections.push([
    <Item icon={Eye} key="guest-inspect" label={copy.page.inspectElement} onSelect={guest.inspectElement} />
  ])

  return sections
}

/** Bare right-click on app chrome: the window verbs (the old shell fallback). */
function shellSections({ navigate, t }: ShellVerbs): ReactNode[][] {
  return [
    [
      <Item
        icon={Plus}
        key="shell-new-chat"
        label={t.commandCenter.nav.newChat.title}
        onSelect={() => navigateToWorkspacePage(navigate, NEW_CHAT_ROUTE)}
      />,
      canOpenNewWindow() ? (
        <Item
          icon={AppWindow}
          key="shell-new-window"
          label={t.keybinds.actions['session.newWindow']}
          onSelect={() => void openNewWindow()}
        />
      ) : null,
      <Item icon={Search} key="shell-palette" label={t.commandCenter.paletteTitle} onSelect={openCommandPalette} />
    ].filter(Boolean),
    [
      <Item
        icon={Settings}
        key="shell-settings"
        label={t.commandCenter.settings}
        onSelect={() => navigateToWorkspacePage(navigate, SETTINGS_ROUTE)}
      />
    ],
    [<Item icon={Download} key="shell-update" label={t.commandCenter.updateHermes} onSelect={requestActiveUpdate} />]
  ]
}

/**
 * THE app context menu: one capture-phase listener, one store, one menu.
 *
 * Every right-click in the app resolves here first. Radix-owned surfaces
 * (session rows and other `context-menu-trigger` wrappers) keep their own
 * menus; the reaction bubble keeps plain right-clicks; terminals answer
 * through their registered xterm handles; everything else gets a menu
 * assembled from what the click landed on — link, image, editable,
 * selection — with the window verbs as the empty-target fallback. Replaced
 * both the native Electron menu and the shell fallback wrapper, so labels
 * come from the locale files like every other surface.
 */
export function AppContextMenu() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const open = useStore($contextMenu)

  useEffect(() => {
    // stopPropagation beats other renderer handlers; preventDefault is never
    // called because Chromium emits the main-process context-menu event (the
    // spellcheck + image-coordinate source) only for unprevented gestures —
    // and with no Menu.popup anywhere, "default" means no menu at all.
    const onContextMenu = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null

      // Surfaces with their own Radix context menu keep the whole gesture.
      // Guard the dedicated marker first: Radix `asChild` Slot merges
      // `mergeProps(slotProps, childProps)` so the child's `data-slot` wins
      // (status bar footer is `data-slot="statusbar"`). The marker is stamped
      // after `{...props}` on ContextMenuTrigger and is not overwritten.
      if (element?.closest(`[${HERMES_CONTEXT_MENU_TRIGGER_ATTR}], [data-slot="context-menu-trigger"]`)) {
        return
      }

      // A terminal's canvas has no DOM to resolve; its registered handle
      // carries the xterm selection and paste path instead.
      const terminal = terminalMenuHandleFor(element)

      if (terminal) {
        event.stopPropagation()
        openTerminalContextMenu(event.clientX, event.clientY, terminal)

        return
      }

      const target = resolveDomTarget(element)
      const owned = Boolean(target.linkUrl || target.onImage || target.editable || target.selectionText)

      // The reaction bubble owns bare right-clicks; a link inside it still
      // opens the link menu.
      if (!owned && element?.closest(`[${CONTEXT_MENU_SKIP_ATTR}]`)) {
        return
      }

      event.stopPropagation()
      openDomContextMenu(event.clientX, event.clientY, target)
    }

    window.addEventListener('contextmenu', onContextMenu, true)

    return () => window.removeEventListener('contextmenu', onContextMenu, true)
  }, [])

  // Spell-check facts arrive from main after the menu opens (Chromium reports
  // them on its own context-menu event); attach them to the open menu.
  useEffect(() => window.hermesDesktop?.onContextMenuSpellcheck?.(augmentSpellcheck), [])

  if (!open) {
    return null
  }

  const sections =
    open.kind === 'terminal'
      ? terminalSections(open, t)
      : open.kind === 'guest'
        ? guestSections(open, t)
        : (list => (list.length ? list : shellSections({ navigate, t })))(domSections(open, t))

  return (
    <ContextMenuSurface
      container={open.kind === 'dom' ? open.target.dialogPortalContainer : undefined}
      onClose={closeContextMenu}
      sections={sections}
      x={open.x}
      y={open.y}
    />
  )
}
