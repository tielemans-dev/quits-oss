import { useCallback, useLayoutEffect, useRef } from "react"
import { getRequestOrganizationId } from "../lib/active-organization"

/**
 * Guards a detail page that stays mounted while its route parameter changes. Call the returned
 * `begin(documentId)` when starting a request for that document; the check it returns tells
 * whether the response still belongs on screen. It does not once the page shows another document
 * (including after navigating away and back) or this tab acts for another organization, so a slow
 * load or poll for one document can never overwrite the next one.
 */
export function useDocumentResponseGuard(documentId: string) {
  const current = useRef({ documentId, generation: 0 })

  useLayoutEffect(() => {
    if (current.current.documentId === documentId) return
    current.current = { documentId, generation: current.current.generation + 1 }
  }, [documentId])

  return useCallback((requestedId: string) => {
    const generation = current.current.generation
    const organizationId = getRequestOrganizationId()
    return () =>
      current.current.documentId === requestedId &&
      current.current.generation === generation &&
      getRequestOrganizationId() === organizationId
  }, [])
}
