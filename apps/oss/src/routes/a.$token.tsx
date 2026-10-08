import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import {
  getPublicAgreementSession,
  submitPublicAgreementDecision,
} from "../lib/agreements/public-session"
import { PublicDeliverablePage } from "../components/agreements/public-deliverable-page"
import { PublicAgreementPage } from "../components/agreements/public-agreement-page"
import { LocalizedDocument } from "../components/documents/localized-document"
import { useI18n } from "../lib/i18n/react"
import { translate } from "../lib/i18n/translate"
export const Route = createFileRoute("/a/$token")({
  loader: ({ params }) => getPublicAgreementSession({ data: { token: params.token } }),
  // The tab shows the agreement and its sender, never the product name.
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    if (loaderData.kind === "invalid") {
      return { meta: [{ title: translate("agreements.invalidLink", loaderData.locale) }] }
    }
    const number =
      loaderData.scope === "sign_off"
        ? loaderData.deliverable.agreementNumber
        : loaderData.document.number
    const title = [`${translate("agreements.document", loaderData.locale)} ${number}`, loaderData.seller.name]
      .filter(Boolean)
      .join(" · ")
    return { meta: [{ title }] }
  },
  component: AgreementRoute,
})
function AgreementRoute() {
  const initial = Route.useLoaderData()
  // The page speaks the language the agreement was written in, not the visitor's browser's. The
  // server decides it and it stays fixed for the life of the page, whatever a later state carries.
  return (
    <LocalizedDocument locale={initial.locale}>
      <AgreementRouteContent />
    </LocalizedDocument>
  )
}
function AgreementRouteContent() {
  const { token } = Route.useParams()
  const initial = Route.useLoaderData()
  type State =
    | Awaited<ReturnType<typeof getPublicAgreementSession>>
    | Extract<Awaited<ReturnType<typeof submitPublicAgreementDecision>>, { kind: "ready" }>
    | { readonly kind: "invalid" }
  const [state, setState] = useState<State>(initial)
  const [name, setName] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useI18n()
  async function decide(verb: "accept" | "decline") {
    setBusy(true)
    setError(null)
    try {
      const next = await submitPublicAgreementDecision({
        data: {
          token,
          decision:
            verb === "accept"
              ? { decision: verb, acceptedByName: name, confirmed }
              : { decision: verb, reason },
        },
      })
      if (next.kind === "retry_later") setError(t("agreements.retryLater"))
      else if (next.kind === "already_decided") setError(t("agreements.alreadyDecided"))
      else setState(next)
    } catch {
      setError(t("agreements.error"))
    } finally {
      setBusy(false)
    }
  }
  if (state.kind === "invalid")
    return (
      <main className="mx-auto max-w-lg px-4 py-20">
        <h1 className="text-2xl font-semibold">{t("agreements.invalidLink")}</h1>
      </main>
    )
  // The seller does not change with a decision; the logo address belongs to the link opened.
  const seller = initial.kind === "ready" ? initial.seller : { name: null, logo: null }
  if (state.scope === "sign_off")
    return <PublicDeliverablePage token={token} initial={state.deliverable} seller={seller} />
  return (
    <PublicAgreementPage
      seller={seller}
      document={state.document}
      scope={state.scope}
      token={state.readLink?.token ?? token}
      name={name}
      onNameChange={setName}
      confirmed={confirmed}
      onConfirmedChange={setConfirmed}
      reason={reason}
      onReasonChange={setReason}
      onDecision={(verb) => void decide(verb)}
      busy={busy}
      error={error}
    />
  )
}
