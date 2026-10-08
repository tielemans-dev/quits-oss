import { useSyncExternalStore } from 'react'

import type { TranslationKey } from '../../../lib/i18n/messages'
import { reservedProviderIds } from './builtin-providers'
import type { PaletteProvider } from './types'

/**
 * Providers registered by features outside the shell. The palette reads them next to its own.
 * Register in module scope or in an effect, and keep the returned function to unregister.
 */
let providers: readonly PaletteProvider[] = []
const listeners = new Set<() => void>()

export function registerPaletteProvider(provider: PaletteProvider): () => void {
  providers = [...providers.filter((existing) => existing.id !== provider.id), provider]
  listeners.forEach((listener) => listener())
  return () => {
    if (!providers.includes(provider)) return
    providers = providers.filter((existing) => existing !== provider)
    listeners.forEach((listener) => listener())
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRegisteredPaletteProviders(): readonly PaletteProvider[] {
  return useSyncExternalStore(
    subscribe,
    () => providers,
    () => providers
  )
}

/**
 * The placeholder for the search field and the palette input: plain search unless a registered
 * provider promises more (see `PaletteProvider.placeholderKey`).
 */
export function useSearchPlaceholderKey(): TranslationKey {
  const registered = useRegisteredPaletteProviders()
  // A provider that takes a built-in's id is ignored by the palette, so it promises nothing.
  const promising = registered
    .filter((provider) => provider.placeholderKey && !reservedProviderIds.has(provider.id))
    .sort((a, b) => a.order - b.order)[0]
  return promising?.placeholderKey ?? 'shell.search.placeholder'
}

export function resetPaletteProvidersForTesting(): void {
  providers = []
  listeners.forEach((listener) => listener())
}
