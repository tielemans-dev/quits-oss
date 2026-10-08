import { useCallback, useState, type ReactNode } from 'react'

import { useRuntimeDistribution } from '../../lib/runtime-distribution'
import { SidebarTrigger } from '../ui/sidebar'
import { NewMenu } from './new-menu'
import { CommandPalette } from './palette'
import { SearchField } from './search-field'
import { useShellHotkeys } from './use-shell-hotkeys'
import { useShellPermissions } from './use-shell-permissions'

/**
 * Everything to the right of the sidebar: the top bar (menu, search, "+ Ny"), the command
 * palette, and the one content container every page renders in. Pages bring their own markup;
 * the container sets the width and the padding (see `[data-slot='app-content']` in styles.css).
 */
export function AppMain({ banner, children }: { banner?: ReactNode; children: ReactNode }) {
  const { billingEnabled } = useRuntimeDistribution()
  const { can, ready } = useShellPermissions()
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
  const openNewMenu = useCallback(() => setNewMenuOpen(true), [])
  useShellHotkeys({ togglePalette, openPalette, openNewMenu })

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-hairline bg-background">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 px-3 md:gap-3 md:px-8">
          <SidebarTrigger className="-ml-1 size-9 shrink-0" />
          <SearchField onOpen={openPalette} className="max-w-[560px]" />
          <div className="flex-1 max-md:hidden" />
          <NewMenu open={newMenuOpen} onOpenChange={setNewMenuOpen} can={can} ready={ready} />
        </div>
      </header>
      {banner}
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-auto outline-none">
        <div data-slot="app-content" className="mx-auto w-full max-w-[1280px] px-4 py-5 md:px-8 md:py-8">
          {children}
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} can={can} billingEnabled={billingEnabled} />
    </div>
  )
}
