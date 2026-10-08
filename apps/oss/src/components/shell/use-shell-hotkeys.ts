import { useEffect } from 'react'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.getAttribute('role') === 'textbox'
}

/**
 * What counts as holding the keyboard: a dialog, a menu, or a popup list such as an open Select
 * (focus sits on one of its options and typing selects by letter). A closing overlay lingers for
 * its exit animation and no longer holds it.
 */
const OPEN_OVERLAY = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="option"]',
]
  .map((selector) => `${selector}:not([data-state="closed"])`)
  // Any other Radix popup (popover, combobox list, tooltip-like content) while it is open.
  .concat('[data-radix-popper-content-wrapper] [data-state="open"]')
  .join(', ')

/** An open overlay owns the keyboard: single-key shortcuts must not reach past it. */
function overlayIsOpen(): boolean {
  return document.querySelector(OPEN_OVERLAY) !== null
}

type Handlers = {
  togglePalette: () => void
  openPalette: () => void
  openNewMenu: () => void
}

/**
 * The shell's keyboard shortcuts: ⌘K / Ctrl+K toggles the palette from anywhere (even while
 * typing), and `/` opens it and `N` opens the "+ Ny" menu when no field or overlay has the
 * keyboard. Modified presses other than ⌘K / Ctrl+K are left to the browser. `/` may need Shift
 * on some keyboards (Danish), so only `N` ignores it.
 */
export function useShellHotkeys({ togglePalette, openPalette, openNewMenu }: Handlers): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return
      const key = event.key.toLowerCase()

      if (key === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        togglePalette()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target) || overlayIsOpen()) return

      if (key === '/') {
        event.preventDefault()
        openPalette()
      } else if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        openNewMenu()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePalette, openPalette, openNewMenu])
}
