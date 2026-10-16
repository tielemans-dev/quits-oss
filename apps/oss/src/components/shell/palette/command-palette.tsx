import { useNavigate } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { trpc } from '../../../trpc/client'
import { DURATION, EASE_ENTER, prefersReducedMotion } from '../../../lib/motion'
import { cn } from '../../../lib/utils'
import { onRequestOpen } from '../../command-bar/request-events'
import { useFollowHeight } from '../../command-bar/use-morph'
import { useI18n } from '../../../lib/i18n/react'
import { builtinPaletteProviders, reservedProviderIds } from './builtin-providers'
import { useRegisteredPaletteProviders, useSearchPlaceholderKey } from './registry'
import type { PaletteActions, PaletteContext, PaletteItem, PaletteProvider, PaletteSection } from './types'

/** Growing out of the field and into a card: the palette takes this long to change shape. */
const CARD_MORPH_MS = DURATION.palette
/** How long typing has to pause before the palette becomes the card for what was typed. */
const LIVE_PAUSE_MS = 120
/** How long typing has to pause before the leading item's card starts reading what it shows. */
const PREFETCH_PAUSE_MS = 40

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  can: PaletteContext['can']
  billingEnabled: boolean
  /** Called when an item navigates, besides closing the palette: the shell closes its mobile drawer here. */
  onNavigate?: () => void
  /** The search field it opened from. The palette then sits over it and grows out of its outline. */
  anchor?: DOMRect | null
  /** How far into that field its icon sits; the palette's icon lands on it. */
  anchorInset?: number
  /** What was already typed in that field; the palette opens with it. */
  initialQuery?: string
  /** The field's own placeholder, so the text does not change as the palette takes its place. */
  placeholder?: string
  /** Closed by Esc or a click outside, with what the field held: the field it grew out of keeps it. */
  onDismiss?: (query: string) => void
  /**
   * In the page instead of over it: the field itself, with no dimming, that unfolds into results
   * and cards as it is typed in, and folds back into a field when it loses focus. Cards come at
   * once, without waiting for typing to pause, and ⌘↵ presses the card's own button.
   */
  inline?: boolean
}

/**
 * Over the field: the input row centred on the field's, the icon over the field's icon. It is at
 * least as wide as the field, so the command bar on Overblik is covered edge to edge.
 */
function anchoredStyle(anchor: DOMRect): CSSProperties {
  const left = Math.max(12, anchor.left - 8)
  return {
    top: Math.max(4, anchor.top + anchor.height / 2 - 28),
    left,
    width: `min(${Math.max(600, anchor.width + 16)}px, calc(100vw - ${left + 12}px))`,
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
    // A provider still answering keeps what it said for the last query, so its rows do not blink
    // out and back with every key.
    setResolved((current) => ({ ...Object.fromEntries([...waiting].filter((id) => id in current).map((id) => [id, current[id]])), ...next }))
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
export function CommandPalette({ open: openProp, onOpenChange, can, billingEnabled, onNavigate, anchor = null, anchorInset = 8, initialQuery = '', placeholder, onDismiss, inline = false }: Props) {
  // Inline it is always there; it unfolds while it has focus or holds a card.
  const open = openProp || inline
  const [focused, setFocused] = useState(false)
  const { t } = useI18n()
  const navigate = useNavigate()
  const listboxId = useId()
  const [query, setQuery] = useState(open ? initialQuery : '')
  const [activeId, setActiveId] = useState<string | null>(null)
  // A card the palette has grown into, in place of the list: one chosen with Enter, or else the
  // leading item's own card once typing has paused (see `lead` below).
  const [card, setCard] = useState<ReactNode>(null)
  const [paused, setPaused] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // Typing resizes the list at once. Every change to or from a card eases: list to card, one card
  // to another, a card as its data arrives, and back to the list when the text stops reading as one.
  const morph = useRef({ shown: false, changedAt: 0 })
  const follow = useFollowHeight(CARD_MORPH_MS, () => morph.current.shown || performance.now() - morph.current.changedAt < CARD_MORPH_MS * 2)
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
  // Inline and empty, only what is probably next: the page around it already shows the rest.
  const offered = useMemo(() => (inline && !query.trim() ? sections.filter((section) => section.id.startsWith('next:')) : sections), [inline, query, sections])
  const items = useMemo(() => offered.flatMap((section) => section.items), [offered])

  // A new query, or new results, start on the first item; keep the choice while it still exists.
  const effectiveActiveId = items.some((item) => item.id === activeId) ? activeId : (items[0]?.id ?? null)

  // Opening starts over, with what the field held.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery(initialQuery)
      setCard(null)
      setPaused(false)
    }
  }

  // Opening over the field: the panel starts as the field's outline and grows to its own.
  const growFromAnchor = useCallback(() => {
    const el = panel.current
    if (!anchor || !el || typeof el.animate !== 'function' || prefersReducedMotion()) return
    const box = el.getBoundingClientRect()
    const top = anchor.top - box.top
    const left = anchor.left - box.left
    const from = `inset(${top}px ${box.width - left - anchor.width}px ${box.height - top - anchor.height}px ${left}px round 8px)`
    // It ends past the panel by as far as its shadow reaches, so the shadow grows with it.
    el.animate({ clipPath: [from, 'inset(-16px -16px -48px round 12px)'] }, { duration: CARD_MORPH_MS, easing: EASE_ENTER })
  }, [anchor])

  useEffect(() => {
    if (!effectiveActiveId) return
    document.getElementById(`${listboxId}-${effectiveActiveId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [effectiveActiveId, listboxId])

  // Over a field the palette closes back into it: the clip ends on the field's outline, measured
  // now, since the panel may have grown into a card since it opened.
  const close = useCallback(() => {
    if (inline) {
      setQuery('')
      setCard(null)
      input.current?.blur()
      setFocused(false)
      return
    }
    const el = panel.current
    if (anchor && el) {
      const box = el.getBoundingClientRect()
      const top = anchor.top - box.top
      const left = anchor.left - box.left
      el.style.setProperty('--palette-field', `inset(${top}px ${box.width - left - anchor.width}px ${box.height - top - anchor.height}px ${left}px round 29px)`)
    }
    onOpenChange(false)
  }, [anchor, onOpenChange, inline])
  const actions = useMemo<PaletteActions>(
    () => ({
      navigate: (to) => {
        close()
        onNavigate?.()
        void navigate({ to } as Parameters<typeof navigate>[0])
      },
      close,
      expand: setCard,
      fill: (text) => {
        setQuery(text)
        setCard(null)
        input.current?.focus()
      },
    }),
    [close, navigate, onNavigate]
  )
  const choose = useCallback((item: PaletteItem) => item.perform(actions), [actions])

  // The leading item can answer with a card. Once typing pauses the palette becomes it, without
  // waiting for Enter; typing on updates it, and text that stops reading as one brings the list back.
  // Readings that each have a card: the chosen one shows, the others wait beside it (↑↓ switch).
  const carded = useMemo(() => items.filter((item) => item.card), [items])
  const first = items[0]?.card && (!inline || query.trim()) ? items[0] : null
  const lead = first ? (carded.find((item) => item.id === effectiveActiveId) ?? first) : null
  if (!lead && paused) setPaused(false)
  // Its reads start well before the pause ends, so the card opens with its data instead of filling
  // in as it grows. Not on every key: a half-typed invoice number is not worth looking up.
  useEffect(() => {
    if (!lead?.prefetch) return
    const timer = setTimeout(lead.prefetch, PREFETCH_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [lead])
  useEffect(() => {
    if (!lead || paused) return
    const timer = setTimeout(() => setPaused(true), inline ? 0 : LIVE_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [lead, paused, inline])
  const shown = card ?? (paused && lead?.card ? lead.card(actions) : null)
  if ((shown !== null) !== morph.current.shown) morph.current = { shown: shown !== null, changedAt: performance.now() }

  function clear() {
    // Emptied over the field it grew out of, the palette goes back to being that field.
    if (anchor && !inline) return close()
    setQuery('')
    setCard(null)
    input.current?.focus()
  }

  function move(delta: number | 'first' | 'last') {
    if (items.length === 0) return
    const index = items.findIndex((item) => item.id === effectiveActiveId)
    const next =
      delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : (index + delta + items.length) % items.length
    setActiveId(items[next].id)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // ⌘↵ is the card's own button, pressed from the field: one deliberate chord on a labelled button.
    if (shown && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      panel.current?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled)')?.click()
      return
    }
    // With a card showing, the arrows are the card's; Enter steps into it, to its fields and buttons.
    if (shown) {
      if (!card && carded.length > 1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        const index = carded.findIndex((item) => item.id === lead?.id)
        setActiveId(carded[(index + (event.key === 'ArrowDown' ? 1 : -1) + carded.length) % carded.length]!.id)
        return
      }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        panel.current?.querySelector<HTMLElement>('[data-slot=request-card-slot]')?.focus()
      }
      return
    }
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

  // A summary row asks for a card ("Send rykker"): the field takes the request and becomes its card.
  useEffect(() => {
    if (!inline) return
    return onRequestOpen((request) => {
      setQuery(request.input)
      setCard(null)
      setFocused(true)
      input.current?.focus({ preventScroll: true })
    })
  }, [inline])
  // It folds on a press outside, not on blur: a card's own menus open in portals of their own.
  useEffect(() => {
    if (!inline) return
    const fold = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (panel.current?.contains(target) || target?.closest?.('[data-radix-popper-content-wrapper]')) return
      setFocused(false)
    }
    document.addEventListener('pointerdown', fold)
    return () => document.removeEventListener('pointerdown', fold)
  }, [inline])
  const unfolded = !inline || (focused && (query.trim() !== '' || shown !== null || offered.length > 0)) || card !== null
  // The panel follows this: list to card, and the card again when its data arrives.
  const body = (
    <div ref={follow}>
      {/* Over a field, the icon lands on the field's: its inset plus the 8px overhang, less the palette's border. */}
      <div className={cn('flex items-center gap-3 border-hairline px-4', unfolded && 'border-b', inline && 'pl-5')} style={anchor && !inline ? { paddingLeft: anchorInset + 7 } : undefined}>
        <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          ref={input}
          aria-expanded={!shown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={effectiveActiveId ? `${listboxId}-${effectiveActiveId}` : undefined}
          aria-label={t('shell.palette.inputLabel')}
          placeholder={placeholder ?? t(placeholderKey)}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            // Editing what a chosen card answers drops it; the text decides again.
            setCard(null)
          }}
          onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {query && (
          <button
            type="button"
            onClick={clear}
            aria-label={t('shell.palette.clear')}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fade) hover:bg-(--neutral-6) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
        {!inline && <kbd className="mono-label rounded-sm border border-hairline px-1.5 py-px text-2xs">esc</kbd>}
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-busy={pending}
        aria-label={t('shell.palette.title')}
        className={cn(
          'max-h-[min(380px,55vh)] overflow-y-auto p-2',
          // A card takes the list's place; the panel eases from the list's height to the card's.
          // Coming back, the list fades in (an animation restarts when `hidden` comes off).
          shown !== null || !unfolded ? 'hidden' : 'animate-in fade-in-0 duration-(--duration-fade)'
        )}
      >
        {offered.length === 0 &&
          (pending ? (
            // Nothing has matched yet, but a provider is still answering: not "no results" yet.
            <p className="mono-label px-3 py-8 text-center">{t('shell.palette.searching')}</p>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t('shell.palette.empty', { query: query.trim() })}
            </p>
          ))}
        {offered.map((section) => (
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
      {unfolded && shown && !card && carded.length > 1 && (
        <div role="radiogroup" aria-label={t('shell.palette.groupSuggest')} className="flex gap-1.5 overflow-x-auto border-b border-hairline px-3 py-2">
          {carded.slice(0, 5).map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.id === lead?.id}
                onClick={() => { setActiveId(item.id); input.current?.focus() }}
                className="flex max-w-72 shrink-0 items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-(--duration-fade) hover:text-foreground aria-checked:border-foreground/30 aria-checked:bg-sidebar-accent aria-checked:text-foreground"
              >
                {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
                <span className="truncate">{item.content ?? item.label}</span>
              </button>
            )
          })}
        </div>
      )}
      {unfolded && shown}
      <div className={cn('mono-label flex items-center gap-4 border-t border-hairline px-4 py-2.5 text-2xs', (shown !== null || !unfolded) && 'hidden')} aria-hidden="true">
        <span>↑↓ {t('shell.palette.hint.select')}</span>
        <span>↵ {t('shell.palette.hint.open')}</span>
        <span>esc {t('shell.palette.hint.close')}</span>
      </div>
    </div>
  )

  if (inline) {
    return (
      // The field keeps its place in the page; what it unfolds into floats over what follows.
      <div className="relative h-14" data-live-sheet="">
        <div
          ref={panel}
          data-slot="command-palette"
          data-unfolded={unfolded}
          onFocus={() => setFocused(true)}
          onKeyDown={(event) => {
            // Esc anywhere in it, the card included: empty it first, then fold it. A menu that took Esc keeps it.
            if (event.key !== 'Escape' || event.defaultPrevented) return
            event.preventDefault()
            if (query || card) clear()
            else close()
          }}
          className={cn(
            'absolute inset-x-0 top-0 z-40 overflow-hidden border border-hairline bg-panel text-foreground',
            '[transition:border-radius_var(--duration-palette)_var(--ease-enter),box-shadow_var(--duration-palette)_var(--ease-enter)]',
            unfolded ? 'rounded-2xl shadow-2xl shadow-black/15 dark:border-white/10 dark:shadow-black/60' : 'rounded-[29px] shadow-xs'
          )}
        >
          {body}
        </div>
      </div>
    )
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return onOpenChange(true)
        onDismiss?.(query)
        close()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 duration-(--duration-square-shrink) ease-enter data-[state=closed]:ease-exit data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={panel}
          data-slot="command-palette"
          onOpenAutoFocus={(event) => {
            // Radix mounts the content a render after `open`; this is the first moment it is laid out.
            growFromAnchor()
            returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            // Radix would select the text it focuses, and the next key would replace what the field
            // handed over. The cursor goes after it instead, so typing carries on.
            event.preventDefault()
            const field = input.current
            field?.focus()
            field?.setSelectionRange(field.value.length, field.value.length)
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
            anchor
              ? 'palette-into-field'
              : 'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-(--duration-square-shrink) ease-enter data-[state=closed]:ease-exit',
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
          {body}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
