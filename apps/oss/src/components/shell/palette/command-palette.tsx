import { useNavigate } from '@tanstack/react-router'
import { Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '../../../lib/utils'
import { useI18n } from '../../../lib/i18n/react'
import { builtinPaletteProviders, reservedProviderIds } from './builtin-providers'
import { useRegisteredPaletteProviders, useSearchPlaceholderKey } from './registry'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  can: PaletteContext['can']
  billingEnabled: boolean
}

/**
 * Sections of every provider for `query`, in provider order. Async providers fill in when they
 * resolve. A provider that throws offers nothing; the rest carry on.
 */
function useSections(
  providers: readonly PaletteProvider[],
  context: Omit<PaletteContext, 'signal'>,
  active: boolean
): PaletteSection[] {
  const [resolved, setResolved] = useState<Record<string, PaletteSection[]>>({})

  useEffect(() => {
    if (!active) return
    // Closing, a new query and unmounting all end this run: its answers are stale and its
    // requests are told to stop.
    const run = new AbortController()
    const next: Record<string, PaletteSection[]> = {}
    for (const provider of providers) {
      let result: PaletteSection[] | Promise<PaletteSection[]>
      try {
        result = provider.sections({ ...context, signal: run.signal })
      } catch (error) {
        console.error(`Command palette provider "${provider.id}" failed`, error)
        continue
      }
      if (Array.isArray(result)) {
        next[provider.id] = result
      } else {
        result.then(
          (sections) => {
            if (run.signal.aborted) return
            setResolved((current) => ({ ...current, [provider.id]: sections }))
          },
          (error) => {
            if (!run.signal.aborted) console.error(`Command palette provider "${provider.id}" failed`, error)
          }
        )
      }
    }
    setResolved(next)
    return () => run.abort()
    // `context` is rebuilt every render; its parts that matter are listed.
  }, [providers, context.query, context.billingEnabled, context.can, context.t, active])

  return useMemo(() => {
    const seen = new Set<string>()
    return [...providers]
      .sort((a, b) => a.order - b.order)
      .flatMap((provider) =>
        // Section ids only have to be unique within a provider; they become keys and DOM ids.
        (resolved[provider.id] ?? []).map((section) => ({ ...section, id: `${provider.id}:${section.id}` }))
      )
      .map((section) => ({
        ...section,
        // Item ids are DOM ids and the keyboard's handle on an item: the first one keeps it.
        items: section.items.filter((item) => !seen.has(item.id) && seen.add(item.id)),
      }))
      .filter((section) => section.items.length > 0)
  }, [providers, resolved])
}

/**
 * The ⌘K command palette: a search field over sections of items. It owns keyboard handling
 * (arrows, Home/End, Enter, Esc), focus (trapped while open, returned to where it came from) and
 * closing. What it offers comes from providers; see `types.ts`.
 */
export function CommandPalette({ open, onOpenChange, can, billingEnabled }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  // Where focus was before the palette opened, and goes back to when it closes.
  const returnFocusTo = useRef<HTMLElement | null>(null)

  const registered = useRegisteredPaletteProviders()
  const placeholderKey = useSearchPlaceholderKey()
  // An extension cannot take a built-in's id: both would render under the same section.
  const providers = useMemo(
    () => [...builtinPaletteProviders, ...registered.filter((provider) => !reservedProviderIds.has(provider.id))],
    [registered]
  )
  const context = useMemo<Omit<PaletteContext, 'signal'>>(
    () => ({ query, can, billingEnabled, t }),
    [query, can, billingEnabled, t]
  )
  const sections = useSections(providers, context, open)
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections])

  // A new query, or new results, start on the first item; keep the choice while it still exists.
  const effectiveActiveId = items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? null)

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!effectiveActiveId) return
    document.getElementById(`${listboxId}-${effectiveActiveId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [effectiveActiveId, listboxId])

  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const choose = useCallback(
    (item: PaletteItem) => {
      item.perform({
        navigate: (to) => {
          close()
          void navigate({ to } as Parameters<typeof navigate>[0])
        },
        close,
      })
    },
    [close, navigate]
  )

  function move(delta: number | 'first' | 'last') {
    if (items.length === 0) return
    const index = items.findIndex((item) => item.id === effectiveActiveId)
    const next =
      delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : (index + delta + items.length) % items.length
    setActiveId(items[next].id)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // Esc is Radix's: it closes and returns focus. Everything else is the list's.
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Home' && event.currentTarget.value === '') {
      event.preventDefault()
      move('first')
    } else if (event.key === 'End' && event.currentTarget.value === '') {
      event.preventDefault()
      move('last')
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const item = items.find((candidate) => candidate.id === effectiveActiveId)
      if (item) {
        event.preventDefault()
        choose(item)
      }
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-slot="command-palette"
          onOpenAutoFocus={() => {
            returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            // The palette has no trigger of its own, so Radix has nowhere to send focus back to.
            event.preventDefault()
            returnFocusTo.current?.focus()
            returnFocusTo.current = null
          }}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 w-[min(600px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl',
            'border border-hairline bg-panel text-foreground shadow-2xl shadow-black/30 outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150'
          )}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{t('shell.palette.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description>{t('shell.palette.description')}</DialogPrimitive.Description>
          </VisuallyHidden.Root>
          <div className="flex items-center gap-3 border-b border-hairline px-4">
            <input
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={effectiveActiveId ? `${listboxId}-${effectiveActiveId}` : undefined}
              aria-label={t('shell.palette.inputLabel')}
              placeholder={t(placeholderKey)}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <kbd className="mono-label rounded-[5px] border border-hairline px-1.5 py-px text-[10px]">esc</kbd>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-label={t('shell.palette.title')}
            className="max-h-[min(380px,55vh)] overflow-y-auto p-2"
          >
            {sections.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {t('shell.palette.empty', { query: query.trim() })}
              </p>
            )}
            {sections.map((section) => (
              <div
                key={section.id}
                role="group"
                aria-labelledby={section.heading ? `${listboxId}-heading-${section.id}` : undefined}
                className="pb-1"
              >
                {section.heading && (
                  <div id={`${listboxId}-heading-${section.id}`} className="mono-label px-3 pt-2 pb-1.5">
                    {section.heading}
                  </div>
                )}
                {section.items.map((item) => {
                  const active = item.id === effectiveActiveId
                  const Icon = item.icon
                  return (
                    <div
                      key={item.id}
                      id={`${listboxId}-${item.id}`}
                      role="option"
                      aria-selected={active}
                      aria-label={item.content ? item.label : undefined}
                      data-active={active}
                      onPointerMove={() => !active && setActiveId(item.id)}
                      onClick={() => choose(item)}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm',
                        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground'
                      )}
                    >
                      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate">{item.content ?? item.label}</span>
                      {item.hint && <span className="mono-label shrink-0 text-[10.5px]">{item.hint}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="mono-label flex items-center gap-4 border-t border-hairline px-4 py-2.5 text-[10.5px]" aria-hidden="true">
            <span>↑↓ {t('shell.palette.hint.select')}</span>
            <span>↵ {t('shell.palette.hint.open')}</span>
            <span>esc {t('shell.palette.hint.close')}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
