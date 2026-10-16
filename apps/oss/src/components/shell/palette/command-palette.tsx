import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { trpc } from '../../../trpc/client'
import { DURATION, EASE_ENTER, prefersReducedMotion } from '../../../lib/motion'
import { cn } from '../../../lib/utils'
import { useMorph } from '../../command-bar/use-morph'
import { useI18n } from '../../../lib/i18n/react'
import { builtinPaletteProviders, reservedProviderIds } from './builtin-providers'
import { useRegisteredPaletteProviders, useSearchPlaceholderKey } from './registry'
import type { PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/** Growing into a card: the palette takes this long to change height, and the list this long to fade. */
const CARD_MORPH_MS = DURATION.palette
const LIST_FADE_MS = DURATION.listFade

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  can: PaletteContext['can']
  billingEnabled: boolean
  /** Called when an item navigates, besides closing the palette: the shell closes its mobile drawer here. */
  onNavigate?: () => void
  /** The search field it opened from. The palette then sits over it and grows out of its outline. */
  anchor?: DOMRect | null
}

/** Over the field: the input row centred on the field's, the icon over the field's icon. */
function anchoredStyle(anchor: DOMRect): CSSProperties {
  const left = Math.max(12, anchor.left - 8)
  return {
    top: Math.max(4, anchor.top + anchor.height / 2 - 28),
    left,
    width: `min(600px, calc(100vw - ${left + 12}px))`,
  }
}

/**
 * Sections of every provider for `query`, in provider order. Async providers fill in when they
 * resolve, and `pending` says whether any still has to. A provider that throws offers nothing;
 * the rest carry on.
 */
function useSections(
  providers: readonly PaletteProvider[],
  context: Omit<PaletteContext, 'signal'>,
  active: boolean
): { sections: PaletteSection[]; pending: boolean } {
  const [resolved, setResolved] = useState<Record<string, PaletteSection[]>>({})
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (!active) return
    // Closing, a new query and unmounting all end this run: its answers are stale and its
    // requests are told to stop.
    const run = new AbortController()
    const next: Record<string, PaletteSection[]> = {}
    const waiting = new Set<string>()
    const settle = (id: string) =>
      setPendingIds((current) => {
        const rest = new Set(current)
        rest.delete(id)
        return rest
      })
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
        waiting.add(provider.id)
        result.then(
          (sections) => {
            if (run.signal.aborted) return
            setResolved((current) => ({ ...current, [provider.id]: sections }))
            settle(provider.id)
          },
          (error) => {
            if (run.signal.aborted) return
            console.error(`Command palette provider "${provider.id}" failed`, error)
            settle(provider.id)
          }
        )
      }
    }
    setResolved(next)
    setPendingIds(waiting)
    return () => run.abort()
    // `context` is rebuilt every render; its parts that matter are listed.
  }, [providers, context.query, context.billingEnabled, context.can, context.t, context.requestFallbackEnabled, active])

  const sections = useMemo(() => {
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
  return { sections, pending: pendingIds.size > 0 }
}

/**
 * The ⌘K command palette: a search field over sections of items. It owns keyboard handling
 * (arrows, Home/End, Enter, Esc), focus (trapped while open, returned to where it came from) and
 * closing. What it offers comes from providers; see `types.ts`.
 */
export function CommandPalette({ open, onOpenChange, can, billingEnabled, onNavigate, anchor = null }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  // A card the palette has grown into, in place of the list. The list stays a moment to fade out.
  const [card, setCard] = useState<ReactNode>(null)
  const [listLeaving, setListLeaving] = useState(false)
  const morph = useMorph<HTMLDivElement>(CARD_MORPH_MS)
  // Where focus was before the palette opened, and goes back to when it closes.
  const returnFocusTo = useRef<HTMLElement | null>(null)

  const [requestFallbackEnabled, setRequestFallbackEnabled] = useState(false)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    trpc.runtime.capabilities.query().then(value => { if (!cancelled) setRequestFallbackEnabled(value.aiInvoiceDraft.requestFallbackEnabled === true) }).catch(() => {})
    return () => { cancelled = true }
  }, [open])
  const registered = useRegisteredPaletteProviders()
  const placeholderKey = useSearchPlaceholderKey()
  // An extension cannot take a built-in's id: both would render under the same section.
  const providers = useMemo(
    () => [...builtinPaletteProviders, ...registered.filter((provider) => !reservedProviderIds.has(provider.id))],
    [registered]
  )
  const context = useMemo<Omit<PaletteContext, 'signal'>>(
    () => ({ query, can, billingEnabled, t, requestFallbackEnabled }),
    [query, can, billingEnabled, t, requestFallbackEnabled]
  )
  const { sections, pending } = useSections(providers, context, open)
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections])

  // A new query, or new results, start on the first item; keep the choice while it still exists.
  const effectiveActiveId = items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCard(null)
  }, [open])

  // Opening over the field: the panel starts as the field's outline and grows to its own.
  const growFromAnchor = useCallback(() => {
    const el = morph.ref.current
    if (!anchor || !el || typeof el.animate !== 'function' || prefersReducedMotion()) return
    const box = el.getBoundingClientRect()
    const top = anchor.top - box.top
    const left = anchor.left - box.left
    const from = `inset(${top}px ${box.width - left - anchor.width}px ${box.height - top - anchor.height}px ${left}px round 8px)`
    // It ends past the panel by as far as its shadow reaches, so the shadow grows with it.
    el.animate({ clipPath: [from, 'inset(-16px -16px -48px round 12px)'] }, { duration: CARD_MORPH_MS, easing: EASE_ENTER })
  }, [anchor, morph.ref])

  useEffect(() => {
    if (!listLeaving) return
    const timer = setTimeout(() => setListLeaving(false), LIST_FADE_MS)
    return () => clearTimeout(timer)
  }, [listLeaving])

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
          onNavigate?.()
          void navigate({ to } as Parameters<typeof navigate>[0])
        },
        close,
        expand: (content) =>
          morph.run(() => {
            setCard(content)
            setListLeaving(true)
          }),
      })
    },
    [close, navigate, onNavigate, morph.run]
  )

  function move(delta: number | 'first' | 'last') {
    if (items.length === 0) return
    const index = items.findIndex((item) => item.id === effectiveActiveId)
    const next =
      delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : (index + delta + items.length) % items.length
    setActiveId(items[next].id)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // With a card open the request is settled; the card owns the keys.
    if (card) return
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 duration-(--duration-square-shrink) ease-enter data-[state=closed]:ease-exit data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={morph.ref}
          data-slot="command-palette"
          onOpenAutoFocus={() => {
            // Radix mounts the content a render after `open`; this is the first moment it is laid out.
            growFromAnchor()
            returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            // The palette has no trigger of its own, so Radix has nowhere to send focus back to.
            event.preventDefault()
            returnFocusTo.current?.focus()
            returnFocusTo.current = null
          }}
          style={anchor ? anchoredStyle(anchor) : undefined}
          className={cn(
            'fixed z-50 overflow-hidden rounded-xl',
            'border border-hairline bg-panel text-foreground shadow-2xl shadow-black/30 outline-none',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-(--duration-square-shrink) ease-enter data-[state=closed]:ease-exit',
            anchor
              ? // Grows out of the field (see the layout effect); with reduced motion it fades in.
                'motion-reduce:data-[state=open]:animate-in motion-reduce:data-[state=open]:fade-in-0'
              : // Centred, with a token-timed fade and scale; reduced motion drops the scale.
                'top-[12vh] left-1/2 w-[min(600px,calc(100vw-1.5rem))] -translate-x-1/2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 motion-reduce:zoom-in-100 motion-reduce:zoom-out-100'
          )}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{t('shell.palette.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description>{t('shell.palette.description')}</DialogPrimitive.Description>
          </VisuallyHidden.Root>
          <div className="flex items-center gap-3 border-b border-hairline px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
            <input
              type="text"
              role="combobox"
              aria-expanded={!card}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={effectiveActiveId ? `${listboxId}-${effectiveActiveId}` : undefined}
              aria-label={t('shell.palette.inputLabel')}
              placeholder={t(placeholderKey)}
              autoComplete="off"
              spellCheck={false}
              value={query}
              readOnly={card !== null}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <kbd className="mono-label rounded-sm border border-hairline px-1.5 py-px text-2xs">esc</kbd>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-busy={pending}
            aria-label={t('shell.palette.title')}
            className={cn(
              'max-h-[min(380px,55vh)] overflow-y-auto p-2',
              // Once a card is open the list fades out where it was, then goes. It stays in the DOM
              // meanwhile: the card needs no blank frame to arrive on.
              card !== null && (listLeaving ? 'pointer-events-none absolute inset-x-0 animate-out fade-out-0 fill-mode-forwards duration-(--duration-list-fade)' : 'hidden')
            )}
          >
            {sections.length === 0 &&
              (pending ? (
                // Nothing has matched yet, but a provider is still answering: not "no results" yet.
                <p className="mono-label px-3 py-8 text-center">{t('shell.palette.searching')}</p>
              ) : (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t('shell.palette.empty', { query: query.trim() })}
                </p>
              ))}
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
                      {item.hint && <span className="mono-label shrink-0 text-2xs">{item.hint}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {card}
          <div className={cn('mono-label flex items-center gap-4 border-t border-hairline px-4 py-2.5 text-2xs', card !== null && 'hidden')} aria-hidden="true">
            <span>↑↓ {t('shell.palette.hint.select')}</span>
            <span>↵ {t('shell.palette.hint.open')}</span>
            <span>esc {t('shell.palette.hint.close')}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
