import { trpc } from "../../trpc/client"
import { permittedRequest, recognizeRequest, type RequestIntent } from "./request-intent"
import type { PaletteContext } from "../shell/palette/types"

/** Debounce leftovers; a changed query or a closed entry point drops the suggestion. */
export async function suggestRequest(input: string, can: PaletteContext["can"], signal: AbortSignal): Promise<RequestIntent | null> {
  if (input.trim().length < 10 || input.length > 4000 || recognizeRequest(input) || !can("contact:read") || (!can("invoice:create") && !can("invoice:send"))) return null
  try {
    const capabilities = await trpc.runtime.capabilities.query(undefined, { signal })
    if (!capabilities.aiInvoiceDraft.requestFallbackEnabled) return null
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
      const timer = setTimeout(finish, 600)
      signal.addEventListener("abort", finish, { once: true })
      if (signal.aborted) finish()
    })
    if (signal.aborted) return null
    const draft = await trpc.ai.fillRequest.mutate({ prompt: input }, { signal })
    return !signal.aborted && draft ? permittedRequest(() => ({ kind: draft.intent, input, suggested: draft }), can)(input) : null
  } catch { return null }
}
