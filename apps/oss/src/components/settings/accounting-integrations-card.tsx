import { useEffect, useRef, useState } from "react"
import type { AccountingProviderStatus } from "../../domain/accounting/status"
import { useActiveOrganizationId } from "../../lib/active-organization"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { formatDateTime } from "../agents/format"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../ui/alert-dialog"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { AccountingMappingsEditor } from "./accounting-mappings"

type Translate = ReturnType<typeof useI18n>["t"]
type State = { providers: AccountingProviderStatus[]; canDisconnect: boolean }

// Refusals from the provider mappers: documents Quits cannot post yet, or whose amounts it cannot verify.
const UNSUPPORTED = /^(unsupported_|advances_|applications_|purpose_|event_not_supported|not_postable|base_valuation_unknown|amount_not_representable|equation_violation|tax_point_review_required|preparation_failed|provider_mismatch)/

/** Plain-language reason for a stored delivery error code. Unknown codes never leak to the screen. */
export function describeAccountingError(code: string | null, provider: string, t: Translate) {
  const params = { provider }
  if (code === "reconnect_review_required" || code === "missing_mapping" || code === "transport_error" || code === "reconciliation_required" || code === "attempts_exhausted" ||
      code === "payload_totals_mismatch" || code === "provider_totals_mismatch" || code === "source_review_required") return t(`accounting.deliveryError.${code}`, params)
  if (code && UNSUPPORTED.test(code)) return t("accounting.deliveryError.unsupported")
  const status = /^http_(\d{3})$/.exec(code ?? "")?.[1]
  if (status === "401" || status === "403") return t("accounting.deliveryError.unauthorized", params)
  if (status) return t("accounting.deliveryError.http", { ...params, status })
  return t("accounting.deliveryError.unknown")
}

/** Connection status and recent delivery per accounting provider. Connecting arrives with OAuth. */
export function AccountingIntegrationsCard() {
  const { t, locale } = useI18n()
  const organizationId = useActiveOrganizationId()
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [skipReason, setSkipReason] = useState("")
  // Applied only while it is the latest request, so a slow response never overwrites a newer one
  // or another organization's state.
  const latest = useRef(0)

  useEffect(() => {
    const token = ++latest.current
    setState(null)
    setError(null)
    setDisconnecting(false)
    setSkipReason("")
    if (organizationId === undefined) return
    // Start inside a promise chain so any client failure lands in the error state.
    Promise.resolve()
      .then(() => trpc.accounting.status.query())
      .then((result) => {
        if (latest.current === token) setState(result)
      })
      .catch(() => {
        if (latest.current === token) setError(t("accounting.error.load"))
      })
  }, [t, organizationId])

  const canDisconnect = state?.canDisconnect === true

  async function runAction(action: () => Promise<State>, failureMessage: string) {
    const token = ++latest.current
    setDisconnecting(true)
    setError(null)
    try {
      const result = await action()
      if (latest.current === token) setState(result)
      return latest.current === token
    } catch {
      if (latest.current === token) setError(failureMessage)
      return false
    } finally {
      if (latest.current === token) setDisconnecting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("accounting.title")}</CardTitle>
        <CardDescription>{t("accounting.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {state === null && !error ? <p className="text-sm text-muted-foreground">{t("accounting.loading")}</p> : null}
        {state?.providers.map((item) => {
          const name = t(`accounting.provider.${item.provider}`)
          const delivery = item.delivery
          return (
            <div key={item.provider} className="grid gap-2 rounded-md border p-4" data-provider={item.provider}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{name}</span>
                  <Badge variant={item.status === "error" ? "destructive" : item.status === "connected" ? "secondary" : "outline"}>
                    {t(`accounting.status.${item.status}`)}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  {item.status === "not_connected" ? (
                    <>
                      <Badge variant="outline">{t("accounting.connect.soon")}</Badge>
                      <Button size="sm" variant="outline" disabled>{t("accounting.connect")}</Button>
                    </>
                  ) : canDisconnect ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" disabled={disconnecting}>{t("accounting.disconnect")}</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("accounting.disconnect.title", { provider: name })}</AlertDialogTitle>
                          <AlertDialogDescription>{t("accounting.disconnect.description", { provider: name })}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("accounting.disconnect.cancel")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void runAction(() => trpc.accounting.disconnect.mutate(), t("accounting.disconnect.error"))}>{t("accounting.disconnect.confirm")}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              </div>
              {delivery ? (
                <div className="grid gap-1 text-sm text-muted-foreground">
                  <span>{t("accounting.account", { id: item.remoteAccountId ?? "" })}</span>
                  {item.syncStartAt ? <span>{t("accounting.syncStart", { date: formatDateTime(item.syncStartAt, locale) })}</span> : null}
                  <span>{delivery.lastDeliveredAt ? t("accounting.lastDelivered", { date: formatDateTime(delivery.lastDeliveredAt, locale) }) : t("accounting.neverDelivered")}</span>
                  <span>{t("accounting.failed", { count: delivery.failedCount })}</span>
                  {delivery.blockedDocument ? <span className="text-destructive">{t("accounting.mappings.blockedDocument", { number: delivery.blockedDocument })}</span> : null}
                  {delivery.failedCount > 0 ? (
                    <span className="text-destructive">
                      {t("accounting.lastError", { message: describeAccountingError(delivery.lastErrorCode, name, t) })} {t("accounting.blocked")}
                    </span>
                  ) : null}
                  {canDisconnect && delivery.failedDeliveryId ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={disconnecting} onClick={() => void runAction(() => trpc.accounting.retry.mutate({ deliveryId: delivery.failedDeliveryId!, ...(delivery.lastErrorCode === "reconnect_review_required" ? { confirmReconnect: true } : {}) }), t("accounting.action.error"))}>{t("accounting.retry")}</Button>
                      <AlertDialog onOpenChange={() => setSkipReason("")}>
                        <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={disconnecting}>{t("accounting.skip")}</Button></AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("accounting.skip.title")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("accounting.skip.description")}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <label className="grid gap-2 text-sm">{t("accounting.skip.reason")}
                            <Input value={skipReason} maxLength={500} onChange={event => setSkipReason(event.target.value)} />
                          </label>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("accounting.disconnect.cancel")}</AlertDialogCancel>
                            <AlertDialogAction disabled={disconnecting || !skipReason.trim()} onClick={() => void runAction(() => trpc.accounting.skip.mutate({ deliveryId: delivery.failedDeliveryId!, reason: skipReason }), t("accounting.action.error"))}>{t("accounting.skip")}</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {item.mappings ? <AccountingMappingsEditor key={`${organizationId}:${item.generation}`} provider={item.provider} config={item.mappings} canEdit={canDisconnect} busy={disconnecting}
                save={mappings => runAction(() => trpc.accounting.saveMappings.mutate({ provider: item.provider, generation: item.generation!, mappingRevision: item.mappingRevision!, mappings }), t("accounting.mappings.error"))} /> : null}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
