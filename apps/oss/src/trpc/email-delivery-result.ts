import { TRPCError } from "@trpc/server"

type AttemptFields = {
  lastEmailAttemptAt: Date | null
  lastEmailAttemptOutcome: string | null
  lastEmailAttemptMessage: string | null
}

/**
 * Reports a queued email the way the UI expects a send to behave. The delivery is attempted right
 * after the command commits, so by now the document usually shows its outcome: sent, refused (an
 * error, with the document left editable), or still pending a retry.
 */
export async function settleEmailResult<
  Result extends AttemptFields & { emailSent: boolean; emailPending: boolean },
  Row extends AttemptFields,
>(result: Result, reload: () => Promise<Row>): Promise<Result | (Result & Row)> {
  if (!result.emailPending) {
    return result
  }
  const current = await reload()
  const sameAttempt = current.lastEmailAttemptAt?.getTime() === result.lastEmailAttemptAt?.getTime()
  if (sameAttempt && current.lastEmailAttemptOutcome === "failed") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: current.lastEmailAttemptMessage ?? "The email could not be sent.",
    })
  }
  return {
    ...result,
    ...current,
    emailSent: sameAttempt && current.lastEmailAttemptOutcome === "sent",
    emailPending: sameAttempt && current.lastEmailAttemptOutcome === "sending",
  }
}
