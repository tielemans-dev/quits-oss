import { Sparkles } from 'lucide-react'

import { RequestCardSlot } from '../../command-bar/request-card-slot'
import { permittedRequest, recognizeRequest, type RequestRecognizer } from '../../command-bar/request-intent'
import type { PaletteProvider } from './types'

/** The list fades out over this long (see `CommandPalette`); the card's content waits for it. */
const LIST_FADE_MS = 90

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
    sections: ({ query, can, t }) => {
      const intent = permittedRequest(recognize, can)(query)
      if (!intent) return []
      return [
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
      ]
    },
  }
}

export const requestProvider = createRequestProvider()
