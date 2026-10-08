import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState, type ReactNode } from "react"
import type { ClientActionRequest } from "@quits/contracts/client-actions"
import {
  AgreementDetail,
  DeliverableDetail,
  InvoiceDetail,
} from "../components/client-actions/client-action-details"
import { ClientActionHub, type ClientActionRef } from "../components/client-actions/client-action-hub"
import { VerificationGate } from "../components/client-actions/verification-gate"
import { LocalizedDocument } from "../components/documents/localized-document"
import { Button } from "../components/ui/button"
import {
  getClientActionState,
  requestClientActionCode,
  submitClientAction,
  submitClientActionCode,
  type ClientActionState,
} from "../lib/client-actions/public-session"
import { useI18n } from "../lib/i18n/react"
import { translate } from "../lib/i18n/translate"
import type { TranslationKey } from "../lib/i18n/messages"

export const Route = createFileRoute("/c/$token")({
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === "string" && /^(agreement|deliverable|invoice):[A-Za-z0-9_-]{1,100}$/.test(search.item)
      ? { item: search.item }
      : {},
  loaderDeps: ({ search }) => ({ item: search.item }),
  loader: ({ params, deps }) => getClientActionState({ data: { token: params.token, item: deps.item ?? null } }),
  // The tab shows the sender, never the product name.
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const locale = loaderData.kind === "ready" ? loaderData.page.locale : loaderData.locale
    const seller = loaderData.kind === "ready" ? loaderData.page.seller.name : loaderData.kind === "inactive" ? loaderData.seller.name : null
    return {
      meta: [
        {
          title: seller
            ? translate("clientActions.title", locale, { seller })
            : translate("clientActions.titleFallback", locale),
        },
        // A page reached through a secret address is not for search engines or referrers.
        { name: "robots", content: "noindex, nofollow" },
        { name: "referrer", content: "no-referrer" },
      ],
    }
  },
  component: ClientActionRoute,
})

function ClientActionRoute() {
  const initial = Route.useLoaderData()
  const locale = initial.kind === "ready" ? initial.page.locale : initial.locale
  return (
    <LocalizedDocument locale={locale}>
      <ClientActionContent />
    </LocalizedDocument>
  )
}

const DONE_KEYS = {
  "agreement.accept": "clientActions.done.agreement.accept",
  "agreement.decline": "clientActions.done.agreement.decline",
  "deliverable.accept": "clientActions.done.deliverable.accept",
  "deliverable.request_changes": "clientActions.done.deliverable.request_changes",
  "invoice.pay": "clientActions.done.paid",
} as const satisfies Record<ClientActionRequest["type"], TranslationKey>

function ClientActionContent() {
  const { token } = Route.useParams()
  const { item } = Route.useSearch()
  const navigate = Route.useNavigate()
  const loaded = Route.useLoaderData()
  const { t } = useI18n()
  const [state, setState] = useState<ClientActionState>(loaded)
  const [notice, setNotice] = useState<{ tone: "ok" | "problem"; text: string } | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)

  // Opening another record (or the browser's back button) loads fresh state for it.
  useEffect(() => {
    setState(loaded)
  }, [loaded])

  function open(ref: ClientActionRef | null) {
    setNotice(null)
    void navigate({ search: ref ? { item: `${ref.kind}:${ref.recordId}` } : {} })
    if (typeof window !== "undefined") window.scrollTo({ top: 0 })
  }

  async function perform(request: ClientActionRequest) {
    setNotice(null)
    try {
      const { outcome, state: next } = await submitClientAction({ data: { token, request, item: item ?? null } })
      setState(next)
      if (outcome.status === "ok") {
        if (outcome.checkoutUrl) {
          window.location.assign(outcome.checkoutUrl)
          return true
        }
        setNotice({ tone: "ok", text: t(DONE_KEYS[request.type]) })
        return true
      }
      setNotice({ tone: "problem", text: t(`clientActions.refused.${outcome.status}`) })
      return false
    } catch {
      setNotice({ tone: "problem", text: t("clientActions.refused.failed") })
      return false
    } finally {
      setPayingId(null)
    }
  }

  function pay(invoiceId: string) {
    setPayingId(invoiceId)
    void perform({ type: "invoice.pay", invoiceId })
  }

  if (state.kind === "invalid") {
    return <Message title={t("clientActions.invalid.title")} body={t("clientActions.invalid.description")} />
  }
  if (state.kind === "inactive") {
    const seller = state.seller.name ?? t("clientActions.theSender")
    return (
      <Message
        title={t(state.reason === "expired" ? "clientActions.inactive.expired.title" : "clientActions.inactive.revoked.title")}
        body={t("clientActions.inactive.recover", { seller })}
      />
    )
  }

  const { page, detail } = state
  const isVerified = page.verification.verified || verified
  const announce = notice ? (
    <p
      role={notice.tone === "problem" ? "alert" : "status"}
      className={notice.tone === "problem" ? "rounded-md border border-destructive/40 p-3 text-destructive" : "rounded-md border p-3"}
    >
      {notice.text}
    </p>
  ) : null
  const gate =
    page.verification.required && !isVerified ? (
      <VerificationGate
        emailHint={page.verification.emailHint}
        requestCode={() => requestClientActionCode({ data: { token } })}
        submitCode={(code) => submitClientActionCode({ data: { token, code } })}
        onVerified={() => {
          setVerified(true)
          void navigate({ search: item ? { item } : {} })
        }}
      />
    ) : null
  const hrefFor = (ref: ClientActionRef) => `/c/${encodeURIComponent(token)}?item=${ref.kind}:${encodeURIComponent(ref.recordId)}`
  const downloadHref = (ref: ClientActionRef) => `/c/${encodeURIComponent(token)}/download/${ref.kind}/${encodeURIComponent(ref.recordId)}`

  if (item && detail) {
    const problem = notice?.tone === "problem" ? notice.text : null
    return (
      <main className="mx-auto grid w-full max-w-3xl min-w-0 gap-6 px-4 py-8 sm:py-12">
        <div className="grid gap-3">
          <Button asChild variant="outline" className="w-fit">
            <a
              href={`/c/${encodeURIComponent(token)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                open(null)
              }}
            >
              {t("clientActions.action.back")}
            </a>
          </Button>
          {notice?.tone === "ok" ? announce : null}
        </div>
        {gate}
        <LocalizedDocument locale={detail.locale}>
          <Detail
            detail={detail}
            page={page}
            token={token}
            verified={isVerified}
            perform={perform}
            pay={pay}
            paying={payingId !== null}
            problem={problem}
            downloadHref={downloadHref({ kind: detail.kind, recordId: detail.recordId })}
          />
        </LocalizedDocument>
      </main>
    )
  }

  return (
    <ClientActionHub
      page={page}
      busyInvoiceId={payingId}
      gate={gate}
      notice={announce}
      hrefFor={hrefFor}
      downloadHref={downloadHref}
      onOpen={open}
      onPay={pay}
    />
  )
}

function Detail({
  detail,
  page,
  token,
  verified,
  perform,
  pay,
  paying,
  problem,
  downloadHref,
}: {
  detail: NonNullable<Extract<ClientActionState, { kind: "ready" }>["detail"]>
  page: Extract<ClientActionState, { kind: "ready" }>["page"]
  token: string
  verified: boolean
  perform: (request: ClientActionRequest) => Promise<boolean>
  pay: (invoiceId: string) => void
  paying: boolean
  problem: string | null
  downloadHref: string
}): ReactNode {
  if (detail.kind === "agreement")
    return (
      <AgreementDetail
        detail={detail}
        seller={page.seller}
        token={token}
        verified={verified}
        perform={perform}
        pdfHref={downloadHref}
        error={problem}
      />
    )
  if (detail.kind === "deliverable")
    return (
      <DeliverableDetail
        detail={detail}
        perform={perform}
        error={problem}
        verified={verified}
        approvalsNeedVerification={page.verification.required}
      />
    )
  return (
    <InvoiceDetail
      detail={detail}
      token={token}
      paying={paying}
      onPay={() => pay(detail.recordId)}
      error={problem}
      downloadHref={downloadHref}
    />
  )
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto max-w-lg px-4 py-20">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-3 text-muted-foreground">{body}</p>
    </main>
  )
}
