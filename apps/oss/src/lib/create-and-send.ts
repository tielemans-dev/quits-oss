/**
 * Where to go after "create and send": the new draft, plus what to tell the user about the send.
 * `sendError` is set when the draft was created but sending it failed (for example the email
 * provider refused the email); the draft still exists and should be shown, not created again.
 */
export type CreatedDocumentTarget = {
  id: string
  kind?: "invoice" | "recurring" | "link" | "draft"
  paymentUrl?: string
  emailWarning?: string
  sendError?: string
}

/**
 * Creates a document and, when asked, sends it. A failed create throws; a failed send does not,
 * because the draft already exists and the caller must navigate to it rather than stay on a
 * form whose resubmission would create a duplicate.
 */
export async function createThenSend(input: {
  create: () => Promise<{ id: string }>
  send: (id: string) => Promise<{ emailSkipReason?: string | null }>
  // Run navigational gates only once the draft is durable. A cancelled gate keeps the draft.
  beforeSend?: (id: string) => Promise<boolean>
  sendImmediately: boolean
  sendFailedMessage: string
  sendErrorMessage?: (error: unknown) => string
}): Promise<CreatedDocumentTarget> {
  const { id } = await input.create()
  if (!input.sendImmediately) return { id }
  try {
    if (input.beforeSend && !await input.beforeSend(id)) return { id }
    const result = await input.send(id)
    return { id, emailWarning: result.emailSkipReason ?? undefined }
  } catch (error) {
    return {
      id,
      sendError: input.sendErrorMessage ? input.sendErrorMessage(error) : error instanceof Error && error.message ? error.message : input.sendFailedMessage,
    }
  }
}
