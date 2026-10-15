import { Sparkles } from 'lucide-react'

import { DURATION } from '../../../lib/motion'
import { suggestRequest } from '../../command-bar/suggest-request'
import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest, type RequestRecognizer, type RequestIntent } from '../../command-bar/request-intent'
import type { PaletteProvider, PaletteSection } from './types'

/** The list fades out over this long (see `CommandPalette`); the card's content waits for it. */
const LIST_FADE_MS = DURATION.listFade

/**
 * "Opgave / Bed quits: …": one row ahead of the search results when the input reads as a
 * request, and nothing otherwise, so ordinary search is untouched. Choosing it expands the
 * palette into the card slot. `recognize` is the parser's seam.
 */
export function createRequestProvider(recognize: RequestRecognizer = recognizeRequest): PaletteProvider {
  return {
    id: 'request',
    // Ahead of Opret and Gå til, behind a provider that drafts invoices itself (see `PaletteProvider.order`).
    order: 90,
    sections: ({ query, can, t, signal, requestFallbackEnabled }) => {
      const section = (intent: RequestIntent | null): PaletteSection[] => intent ? [
        {
          id: 'request',
          heading: t('shell.palette.groupRequest'),
          items: [
            {
              id: 'request:ask',
              label: t('shell.palette.request.ask', { request: intent.input }),
              icon: Sparkles,
              perform: ({ expand, close }) =>
                expand(<RequestCardSlot intent={intent} onDismiss={close} delay={LIST_FADE_MS} />),
            },
          ],
        },
      ] : []
      const intent = permittedRequest(recognize, can)(query)
      return intent ? section(intent) : requestFallbackEnabled ? suggestRequest(query, can, signal).then(section) : []
    },
  }
}

export const requestProvider = createRequestProvider()
