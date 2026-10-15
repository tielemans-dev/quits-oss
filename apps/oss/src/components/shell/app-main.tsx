import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { useRuntimeDistribution } from '../../lib/runtime-distribution'
import { SidebarTrigger, useSidebar } from '../ui/sidebar'
import { NewMenu } from './new-menu'
import { CommandPalette } from './palette'
import { createActions } from './palette/builtin-providers'
import { SearchField } from './search-field'
import { useShellHotkeys } from './use-shell-hotkeys'
import { useShellPermissions } from './use-shell-permissions'
import { isReadOnly, useTrialAccess } from '../billing/trial-access'

/**
 * Everything to the right of the sidebar: the top bar (menu, search, "+ Ny"), the command
 * palette, and the one content container every page renders in. Pages bring their own markup;
 * the container sets the width and the padding (see `[data-slot='app-content']` in styles.css).
 */
export function AppMain({ banner, children, sidebar = true }: { banner?: ReactNode; children: ReactNode; sidebar?: boolean }) {
  const { billingEnabled } = useRuntimeDistribution()
  const trial = useTrialAccess()
  const readOnly = isReadOnly(trial?.subscription ?? null)
  const { can, ready } = useShellPermissions()
  const { setOpenMobile } = useSidebar()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)

  const openPalette = useCallback(() => {
    setNewMenuOpen(false)
    setPaletteOpen(true)
  }, [])
  const togglePalette = useCallback(() => {
    setNewMenuOpen(false)
    setPaletteOpen((open) => !open)
  }, [])
  // The menu exists once the role is known and lets the member create something. Until then an
  // `N` must not be remembered: the menu would open by itself the moment it becomes available.
  const newMenuAvailable = ready && !readOnly && createActions.some((action) => can(action.capability))
  const openNewMenu = useCallback(() => {
    if (newMenuAvailable) {
      const invoiceCreate = document.querySelector<HTMLButtonElement>("[data-invoice-create]")
      if (invoiceCreate) invoiceCreate.click(); else setNewMenuOpen(true)
    }
  }, [newMenuAvailable])
  useEffect(() => {
    if (!newMenuAvailable) setNewMenuOpen(false)
  }, [newMenuAvailable])
  useShellHotkeys({ togglePalette, openPalette, openNewMenu })

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-hairline bg-background">
        <div className="relative mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 px-4 md:gap-3 md:px-8">
          <SearchField onOpen={openPalette} className="max-w-[560px]" />
          {sidebar ? <SidebarTrigger className="size-8 shrink-0 md:absolute md:left-0" /> : null}
          <div className="flex-1 max-md:hidden" />
          <NewMenu open={newMenuOpen} onOpenChange={setNewMenuOpen} can={can} ready={ready} readOnly={readOnly} />
        </div>
      </header>
      {banner}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-auto outline-none">
        <div data-slot="app-content" className="mx-auto w-full max-w-[1280px] px-4 py-5 md:px-8 md:py-8">
          {children}
        </div>
      </main>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        can={can}
        billingEnabled={billingEnabled}
        // ⌘K works over the mobile drawer; going to a page must not leave the drawer over it.
        onNavigate={() => setOpenMobile(false)}
      />
    </div>
  )
}
