import { Link } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
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
import { UserMenu } from '../user-menu'
import { useI18n } from '../../lib/i18n/react'

/**
 * Everything to the right of the sidebar: the top bar (menu, search, "+ Ny"), the command
 * palette, and the one content container every page renders in. Pages bring their own markup;
 * the container sets the width and the padding (see `[data-slot='app-content']` in styles.css).
 */
export function AppMain({ banner, children, sidebar = true }: { banner?: ReactNode; children: ReactNode; sidebar?: boolean }) {
  const { t } = useI18n()
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
      <header className="sticky top-0 z-20 bg-background">
        <div className="flex h-(--topbar-height) w-full items-center gap-2 px-(--gutter)">
          {sidebar ? <SidebarTrigger className="size-8 shrink-0 md:hidden" /> : null}
          <SearchField onOpen={openPalette} className="max-w-[360px]" />
          <div className="flex-1" />
          <NewMenu open={newMenuOpen} onOpenChange={setNewMenuOpen} can={can} ready={ready} readOnly={readOnly} />
          {sidebar ? (
            <Link
              to="/settings"
              aria-label={t('shell.settings')}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden hover:bg-(--neutral-6) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:text-foreground"
            >
              <Settings className="size-4" strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ) : null}
          <UserMenu />
        </div>
      </header>
      {banner}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 outline-none">
        <div data-slot="app-content">{children}</div>
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
