import { createFileRoute } from "@tanstack/react-router"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
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
  const initial = Route.useLoaderData({ structuralSharing: false })
  const { token } = Route.useParams()
  const { item } = Route.useSearch()
  const [context, setContext] = useState({ token, item, loaded: initial, generation: 0 })
  // A fresh loader result is authoritative even when token and item have not changed. Reset
  // before committing children so old details, forms and requests cannot survive that result.
  if (context.token !== token || context.item !== item || context.loaded !== initial) {
    setContext({ token, item, loaded: initial, generation: context.generation + 1 })
  }
  const locale = initial.kind === "ready" ? initial.page.locale : initial.locale
  return (
    <LocalizedDocument locale={locale}>
      <ClientActionContent key={context.generation} loaded={initial} />
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

function ClientActionContent({ loaded }: { loaded: ClientActionState }) {
  const { token } = Route.useParams()
  const { item } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { t } = useI18n()
  const [state, setState] = useState<ClientActionState>(loaded)
  const [notice, setNotice] = useState<{ tone: "ok" | "problem"; text: string } | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)

  const active = useRef(false)
  const latestRequest = useRef(0)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
      latestRequest.current += 1
    }
  }, [])
  const ownsResponse = (requestId: number) => active.current && latestRequest.current === requestId

  async function refreshVerification() {
    if (!active.current) return
    const requestId = ++latestRequest.current
    setPayingId(null)
    setNotice(null)
    try {
      const next = await getClientActionState({ data: { token, item: item ?? null } })
      if (ownsResponse(requestId)) setState(next)
    } catch {
      if (ownsResponse(requestId)) setNotice({ tone: "problem", text: t("clientActions.refused.failed") })
    }
  }

  function open(ref: ClientActionRef | null) {
    latestRequest.current += 1
    setPayingId(null)
    setNotice(null)
    void navigate({ search: ref ? { item: `${ref.kind}:${ref.recordId}` } : {} })
    if (typeof window !== "undefined") window.scrollTo({ top: 0 })
  }

  async function perform(request: ClientActionRequest) {
    if (!active.current) return false
    const requestId = ++latestRequest.current
    setPayingId(request.type === "invoice.pay" ? request.invoiceId : null)
    setNotice(null)
    try {
      const { outcome, state: next } = await submitClientAction({ data: { token, request, item: item ?? null } })
      // Discarding a response does not undo the server command. Only its current caller may
      // update this page or leave it for checkout.
      if (!ownsResponse(requestId)) return false
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
      if (ownsResponse(requestId)) setNotice({ tone: "problem", text: t("clientActions.refused.failed") })
      return false
    } finally {
      if (ownsResponse(requestId)) setPayingId(null)
    }
  }

  function pay(invoiceId: string) {
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
  const isVerified = page.verification.verified
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
        submitCode={async (code) => {
          if (!active.current) return { status: "inactive" }
          const requestId = ++latestRequest.current
          setPayingId(null)
          const result = await submitClientActionCode({ data: { token, code } })
          return ownsResponse(requestId) ? result : { status: "inactive" }
        }}
        onVerified={() => void refreshVerification()}
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
        sellerName={page.seller.name}
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
