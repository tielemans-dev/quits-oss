import { createFileRoute } from "@tanstack/react-router"
import { useState, useTransition } from "react"
import { PublicQuotePage, type PublicQuotePageState } from "../components/quotes/public-quote-page"
import { getPublicQuoteSession, submitPublicQuoteDecision } from "../lib/quotes/public-session"

export const Route = createFileRoute("/q/$token")({
  loader: async ({ params }) => {
    return getPublicQuoteSession({
      data: {
        token: params.token,
      },
    })
  },
  component: PublicQuoteRoutePage,
})

function PublicQuoteRoutePage() {
  const { token } = Route.useParams()
  const initialState = Route.useLoaderData()
  const [state, setState] = useState<PublicQuotePageState>(initialState)
  const [rejectionReason, setRejectionReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleDecision(decision: "accepted" | "rejected") {
    setError(null)
    startTransition(() => {
      submitPublicQuoteDecision({
        data: {
          token,
          decision,
          rejectionReason: decision === "rejected" ? rejectionReason : undefined,
        },
      })
        .then((nextState) => {
          if (nextState.kind === "retry_later")
            setError("Too many submissions. Please try again later.")
          else setState(nextState)
        })
        .catch(() => {
          setError("Unable to update this quote right now. Please try again.")
        })
    })
  }

  return (
    <PublicQuotePage
      token={token}
      state={state}
      rejectionReason={rejectionReason}
      onRejectionReasonChange={setRejectionReason}
      onAccept={() => handleDecision("accepted")}
      onReject={() => handleDecision("rejected")}
      submitting={isPending}
      error={error}
    />
  )
}
