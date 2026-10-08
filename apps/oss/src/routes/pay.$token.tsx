import { createFileRoute } from "@tanstack/react-router"
import { useState, useTransition } from "react"
import { LocalizedDocument } from "../components/documents/localized-document"
import {
  PublicInvoicePaymentPage,
  type PublicInvoicePaymentPageState,
} from "../components/invoices/public-invoice-payment-page"
import { useI18n } from "../lib/i18n/react"
import { translate } from "../lib/i18n/translate"
import {
  beginPublicInvoiceCheckout,
  getPublicInvoiceSession,
} from "../lib/payments/public-session"

export const Route = createFileRoute("/pay/$token")({
  loader: async ({ params }) => {
    return getPublicInvoiceSession({
      data: {
        token: params.token,
      },
    })
  },
  // The tab shows the invoice and its sender, never the product name.
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const label = translate("public.invoice.label", loaderData.locale)
    const title =
      loaderData.kind === "ready"
        ? [`${label} ${loaderData.invoice.number}`, loaderData.seller.name].filter(Boolean).join(" · ")
        : translate("public.invoice.unavailable.title", loaderData.locale)
    return { meta: [{ title }] }
  },
  component: PublicInvoicePaymentRoutePage,
})

function PublicInvoicePaymentRoutePage() {
  const initialState = Route.useLoaderData()

  // The language belongs to the document and is decided by the server, so it stays fixed for the
  // life of the page even when a later state (such as an expired link) carries none.
  return (
    <LocalizedDocument locale={initialState.locale}>
      <PublicInvoicePaymentRoute />
    </LocalizedDocument>
  )
}

function PublicInvoicePaymentRoute() {
  const { token } = Route.useParams()
  const initialState = Route.useLoaderData()
  const { t } = useI18n()
  const [state, setState] = useState<PublicInvoicePaymentPageState>(initialState)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handlePay() {
    setError(null)
    startTransition(() => {
      beginPublicInvoiceCheckout({
        data: {
          token,
        },
      })
        .then((result) => {
          if (result.url) {
            window.location.assign(result.url)
            return
          }

          if (result.status === "paid") {
            setState((current) =>
              current.kind === "ready"
                ? {
                    ...current,
                    paymentState: "paid",
                  }
                : current
            )
            return
          }

          if (result.status === "invalid") {
            setState({ kind: "invalid" })
            return
          }

          setError(t("public.invoice.pay.unavailable"))
        })
        .catch(() => {
          setError(t("public.invoice.pay.failed"))
        })
    })
  }

  return (
    <PublicInvoicePaymentPage
      token={token}
      state={state}
      onPay={handlePay}
      submitting={isPending}
      error={error}
    />
  )
}
