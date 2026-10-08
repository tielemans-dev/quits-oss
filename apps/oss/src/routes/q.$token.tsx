import { createFileRoute } from "@tanstack/react-router"
import { useState, useTransition } from "react"
import { LocalizedDocument } from "../components/documents/localized-document"
import { PublicQuotePage, type PublicQuotePageState } from "../components/quotes/public-quote-page"
import { useI18n } from "../lib/i18n/react"
import { translate } from "../lib/i18n/translate"
import { getPublicQuoteSession, submitPublicQuoteDecision } from "../lib/quotes/public-session"

export const Route = createFileRoute("/q/$token")({
  loader: async ({ params }) => {
    return getPublicQuoteSession({
      data: {
        token: params.token,
      },
    })
  },
  // The tab shows the quote and its sender, never the product name.
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const label = translate("public.quote.label", loaderData.locale)
    const title =
      loaderData.kind === "ready"
        ? [`${label} ${loaderData.quote.number}`, loaderData.seller.name].filter(Boolean).join(" · ")
        : translate("public.quote.unavailable.title", loaderData.locale)
    return { meta: [{ title }] }
  },
  component: PublicQuoteRoutePage,
})

function PublicQuoteRoutePage() {
  const initialState = Route.useLoaderData()

  // The language belongs to the document and is decided by the server, so it stays fixed for the
  // life of the page even when a later state (such as an expired link) carries none.
  return (
    <LocalizedDocument locale={initialState.locale}>
      <PublicQuoteRoute />
    </LocalizedDocument>
  )
}

function PublicQuoteRoute() {
  const { token } = Route.useParams()
  const initialState = Route.useLoaderData()
  const { t } = useI18n()
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
          if (nextState.kind === "retry_later") setError(t("public.quote.error.retryLater"))
          else setState(nextState)
        })
        .catch(() => {
          setError(t("public.quote.error.failed"))
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
