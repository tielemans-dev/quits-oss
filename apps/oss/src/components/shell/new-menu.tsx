import { Link, type LinkProps } from '@tanstack/react-router'
import { Plus } from 'lucide-react'

import { useI18n } from '../../lib/i18n/react'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { createActions } from './palette/builtin-providers'
import type { PaletteCapability } from './palette/types'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  can: (action: PaletteCapability) => boolean
  /** False while the member's role is still loading. */
  ready: boolean
}

/**
 * The global "+ Ny" button: the one place to start a new document from, on every page. Offers
 * only what the member may create, and is opened by the `N` key (see `useShellHotkeys`).
 */
export function NewMenu({ open, onOpenChange, can, ready }: Props) {
  const { t } = useI18n()
  const actions = createActions.filter((action) => can(action.capability))

  // Nothing to create (a read-only role): no button, rather than one that opens an empty menu.
  if (ready && actions.length === 0) return null

  return (
    <DropdownMenu open={open && ready} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={!ready}
        aria-label={t('shell.new.menuLabel')}
        className={cn(
          // A secondary button: the page's own call to action stays the only filled primary.
          'inline-flex h-9 shrink-0 items-center gap-2 rounded-[9px] border border-foreground/20 bg-panel px-3 text-[13px] font-semibold text-foreground shadow-ink outline-hidden',
          'transition-colors hover:border-foreground/35 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'data-[state=open]:border-foreground/35 data-[state=open]:bg-sidebar-accent disabled:opacity-60'
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
        <span className="max-sm:sr-only">{t('shell.new')}</span>
        <kbd className="rounded-[5px] border border-hairline px-1 font-mono text-[10px] font-medium text-muted-foreground max-md:hidden" aria-hidden="true">
          N
        </kbd>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-44 rounded-xl p-1.5">
        <DropdownMenuLabel className="mono-label px-2 py-1.5">{t('shell.new.menuLabel')}</DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem key={action.id} asChild className="rounded-md px-2 py-2 text-sm">
            <Link to={action.to as LinkProps['to']}>
              <action.icon className="size-4 text-muted-foreground" aria-hidden="true" />
              {t(action.menuKey)}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
