/**
 * Where to go after "create and send": the new draft, plus what to tell the user about the send.
 * `sendError` is set when the draft was created but sending it failed (for example the email
 * provider refused the email); the draft still exists and should be shown, not created again.
 */
export type CreatedDocumentTarget = {
  id: string
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
  sendImmediately: boolean
  sendFailedMessage: string
}): Promise<CreatedDocumentTarget> {
  const { id } = await input.create()
  if (!input.sendImmediately) return { id }
  try {
    const result = await input.send(id)
    return { id, emailWarning: result.emailSkipReason ?? undefined }
  } catch (error) {
    return {
      id,
      sendError: error instanceof Error && error.message ? error.message : input.sendFailedMessage,
    }
  }
}
