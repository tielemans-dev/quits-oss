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
export const Route = createFileRoute("/a/$token")({
  loader: ({ params }) => getPublicAgreementSession({ data: { token: params.token } }),
  component: AgreementRoute,
})
function AgreementRoute() {
  const initial = Route.useLoaderData()
  // The page speaks the language the agreement was written in, not the visitor's browser's.
  const locale =
    initial.kind === "invalid"
      ? initial.locale
      : initial.scope === "sign_off"
        ? initial.deliverable.locale
        : initial.document.snapshot.locale
  return (
    <LocalizedDocument locale={locale}>
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
  if (state.scope === "sign_off") return <PublicDeliverablePage token={token} initial={state.deliverable} />
  return (
    <PublicAgreementPage
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
