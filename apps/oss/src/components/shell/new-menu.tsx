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
  readOnly?: boolean
}

/**
 * The global "+ Ny" button: the one place to start a new document from, on every page. Offers
 * only what the member may create, and is opened by the `N` key (see `useShellHotkeys`).
 */
export function NewMenu({ open, onOpenChange, can, ready, readOnly = false }: Props) {
  const { t } = useI18n()
  const actions = createActions.filter((action) => can(action.capability))

  // Nothing to create (a read-only role): no button, rather than one that opens an empty menu.
  if (ready && actions.length === 0) return null

  return (
    <DropdownMenu open={open && ready && !readOnly} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        disabled={!ready || readOnly}
        aria-label={t('shell.new.menuLabel')}
        className={cn(
          // A quiet text action on the bar: the page's own call to action stays the only filled primary.
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-foreground outline-hidden',
          'transition-colors hover:bg-(--neutral-6) focus-visible:ring-2 focus-visible:ring-ring',
          'data-[state=open]:bg-(--neutral-10) disabled:opacity-60'
        )}
      >
        <Plus className="size-4" strokeWidth={1.5} aria-hidden="true" />
        <span className="max-sm:sr-only">{t('shell.new')}</span>
        {readOnly && <span className="font-mono text-2xs tracking-wide">{t('trial.lock')}</span>}
        <kbd className="rounded-sm border border-hairline px-1 font-mono text-2xs font-medium text-muted-foreground max-md:hidden" aria-hidden="true">
          N
        </kbd>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-44 rounded-xl p-1.5">
        <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-xs font-medium">{t('shell.new.menuLabel')}</DropdownMenuLabel>
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
