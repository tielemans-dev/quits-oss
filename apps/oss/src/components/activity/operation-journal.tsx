import { useCallback, useEffect, useId, useState } from "react"
import type {
  JournalDocumentInput,
  JournalStepState
} from "@quits/contracts/journal"
import type { documentJournal } from "../../domain/delivery/journal"
import { useI18n } from "../../lib/i18n/react"
import { normalizeLocale } from "../../lib/i18n/locale"
import type { TranslationKey } from "../../lib/i18n/messages"
import { trpc } from "../../trpc/client"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "../ui/card"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"

type Journal = Awaited<ReturnType<typeof documentJournal>>
const commandLabels: Record<string, TranslationKey> = {
  create_draft: "journal.command.create",
  update_draft: "journal.command.update",
  send: "journal.command.send",
  issue: "journal.command.issue",
  resend: "journal.command.resend",
  resend_email: "journal.command.resend",
  manual_resend: "journal.command.manualResend",
  convert_to_invoice: "journal.command.convert",
  record_acceptance: "journal.command.accept"
}

export function OperationJournal({
  documentType,
  documentId,
  revision,
  onChanged
}: JournalDocumentInput & { revision?: string; onChanged?: () => void }) {
  const { t, locale } = useI18n()
  const formId = useId()
  const [data, setData] = useState<Journal | null>(null)
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState<{
    id: string
    requestId: string
  } | null>(null)
  const [reason, setReason] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const reload = useCallback(
    async () => trpc.journal.forDocument.query({ documentType, documentId }),
    [documentType, documentId]
  )
  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(false)
    setManual(null)
    setActionError(null)
    reload()
      .then((value) => {
        if (!cancelled) setData(value)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [reload, revision])
  const timestamp = (value: string) =>
    new Intl.DateTimeFormat(normalizeLocale(locale), {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value))
  const state = (value: JournalStepState) => (
    <Badge
      variant={
        value === "failed_step" || value === "uncertain"
          ? "destructive"
          : "outline"
      }
    >
      {t(`journal.state.${value}`)}
    </Badge>
  )
  async function act(
    deliveryId: string,
    action: "recover" | "reconcile" | "manualResend"
  ) {
    setBusy(true)
    setActionError(null)
    try {
      const input = { documentType, documentId, deliveryId }
      const value =
        action === "manualResend"
          ? await trpc.journal.manualResend.mutate({
              ...input,
              reason,
              acknowledgeDuplicateRisk: true,
              clientRequestId: manual!.requestId
            })
          : await trpc.journal[action].mutate(input)
      setData(value)
      setManual(null)
      setReason("")
      setAcknowledged(false)
      onChanged?.()
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : t("journal.actionError")
      )
    } finally {
      setBusy(false)
    }
  }
  const current =
    data?.document.id === documentId && data.document.type === documentType
      ? data
      : null
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>{t("journal.title")}</CardTitle>
          <CardDescription>{t("journal.description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setError(false)
            void reload()
              .then(setData)
              .catch(() => setError(true))
          }}
        >
          {t("journal.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5" aria-busy={busy}>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("journal.loadError")}
          </p>
        ) : !current ? (
          <p className="text-sm text-muted-foreground">
            {t("activity.loading")}
          </p>
        ) : (
          <>
            <a
              className="text-sm font-medium underline underline-offset-4 break-all"
              href={`/${documentType === "creditNote" ? "credit-notes" : `${documentType}s`}/${documentId}`}
            >
              {t("journal.record", {
                record: current.document.number || current.document.id
              })}
            </a>
            {current.commands.length === 0 &&
            current.effects.length === 0 &&
            current.deliveries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("journal.empty")}
              </p>
            ) : null}
            <ol className="grid gap-4" aria-label={t("journal.businessSteps")}>
              {current.commands.map((command) => (
                <li
                  key={command.id}
                  id={`operation-${command.id}`}
                  className="grid gap-1 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {t(
                        commandLabels[command.type.split(".").at(-1)!] ??
                          "journal.command.other"
                      )}
                    </span>
                    {state(command.state)}
                  </div>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={command.at}
                  >
                    {timestamp(command.at)}
                  </time>
                  {command.awaitingApproval && (
                    <p>{t("journal.approvalWaiting")}</p>
                  )}
                  {command.blocker && (
                    <p>{t(`journal.blocker.${command.blocker}`)}</p>
                  )}
                  <ul className="grid gap-1">
                    {command.steps.map((step, index) => (
                      <li key={`${step.type}-${index}`}>
                        {step.type.endsWith("draft_created")
                          ? t("journal.created")
                          : step.type.includes("email_") ||
                              step.type.endsWith(".sent")
                            ? t("journal.deliveryEffect")
                            : t("journal.effect")}{" "}
                        <time
                          className="text-xs text-muted-foreground"
                          dateTime={step.at}
                        >
                          {timestamp(step.at)}
                        </time>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {current.effects
                .filter(
                  (effect) =>
                    !current.commands.some(
                      (command) => command.id === effect.commandId
                    )
                )
                .map((effect, index) => (
                  <li
                    key={index}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span>
                      {effect.type.endsWith("draft_created")
                        ? t("journal.created")
                        : t("journal.effect")}
                    </span>
                    {state("effects_completed")}
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={effect.at}
                    >
                      {timestamp(effect.at)}
                    </time>
                  </li>
                ))}
            </ol>
            <ol className="grid gap-5" aria-label={t("journal.deliverySteps")}>
              {current.deliveries.map((delivery) => (
                <li
                  key={delivery.id}
                  className="grid gap-3 border-t pt-4 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {t("journal.deliveryTo", {
                        recipient: delivery.recipient
                      })}
                    </span>
                    {state(delivery.state)}
                  </div>
                  {current.commands.some(
                    (command) => command.id === delivery.commandId
                  ) && (
                    <a
                      className="text-xs underline underline-offset-4"
                      href={`#operation-${delivery.commandId}`}
                    >
                      {t("journal.viewCommand")}
                    </a>
                  )}
                  <dl className="grid gap-1 text-xs text-muted-foreground">
                    <div className="flex flex-wrap gap-x-2">
                      <dt>{t("journal.queuedAt")}</dt>
                      <dd>
                        <time dateTime={delivery.queuedAt}>
                          {timestamp(delivery.queuedAt)}
                        </time>
                      </dd>
                    </div>
                    {delivery.providerReference && (
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t("journal.providerReference")}</dt>
                        <dd className="break-all">
                          {delivery.providerReference}
                        </dd>
                      </div>
                    )}
                    {delivery.attempts.map((attempt, index) => (
                      <div key={index} className="flex flex-wrap gap-x-2">
                        <dt>{t("journal.attempt", { count: index + 1 })}</dt>
                        <dd>
                          <time dateTime={attempt.startedAt}>
                            {timestamp(attempt.startedAt)}
                          </time>{" "}
                          · {t(`journal.attempt.${attempt.outcome}`)}
                        </dd>
                      </div>
                    ))}
                    {delivery.legacyAttempts > 0 && (
                      <div>
                        {t("journal.legacyAttempts", {
                          count: delivery.legacyAttempts
                        })}
                      </div>
                    )}
                    {delivery.evidence.map((evidence) => (
                      <div
                        key={evidence.evidenceId}
                        className="flex flex-wrap gap-x-2"
                      >
                        <dt>{t("journal.evidence")}</dt>
                        <dd>
                          {t(`journal.evidence.${evidence.outcome}`)} ·{" "}
                          <time dateTime={evidence.observedAt}>
                            {timestamp(evidence.observedAt)}
                          </time>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {delivery.state === "delivery_confirmed" && (
                    <p className="text-muted-foreground">
                      {t("journal.acceptedExplanation")}
                    </p>
                  )}
                  {delivery.settlementPending && (
                    <p>{t("journal.settlementPending")}</p>
                  )}
                  {delivery.state === "waiting_prerequisite" && (
                    <p>{t("journal.waitingExplanation")}</p>
                  )}
                  {delivery.state === "failed_step" && (
                    <p>
                      {t(
                        delivery.failure === "rejected"
                          ? "journal.rejectedExplanation"
                          : "journal.failedExplanation"
                      )}
                    </p>
                  )}
                  {delivery.state === "uncertain" && (
                    <p>{t("journal.uncertainExplanation")}</p>
                  )}
                  {delivery.manualReason && (
                    <p className="whitespace-pre-wrap break-words">
                      {t("journal.manualReason", {
                        reason: delivery.manualReason
                      })}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {delivery.canRecover && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(delivery.id, "recover")}
                      >
                        {t("journal.recover")}
                      </Button>
                    )}
                    {delivery.canReconcile && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(delivery.id, "reconcile")}
                      >
                        {t("journal.reconcile")}
                      </Button>
                    )}
                    {delivery.canManualResend && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setManual({
                            id: delivery.id,
                            requestId: crypto.randomUUID()
                          })
                          setReason("")
                          setAcknowledged(false)
                          setActionError(null)
                        }}
                      >
                        {t("journal.manualResend")}
                      </Button>
                    )}
                  </div>
                  {manual?.id === delivery.id && (
                    <form
                      className="grid gap-3 max-w-xl"
                      onSubmit={(event) => {
                        event.preventDefault()
                        if (acknowledged && reason.trim())
                          void act(delivery.id, "manualResend")
                      }}
                    >
                      <p>{t("journal.duplicateWarning")}</p>
                      <div className="grid gap-2">
                        <Label htmlFor={`${formId}-reason`}>
                          {t("journal.reason")}
                        </Label>
                        <Textarea
                          id={`${formId}-reason`}
                          value={reason}
                          maxLength={1000}
                          required
                          disabled={busy}
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </div>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          checked={acknowledged}
                          disabled={busy}
                          onChange={(event) =>
                            setAcknowledged(event.target.checked)
                          }
                        />
                        {t("journal.acknowledge")}
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="submit"
                          disabled={busy || !acknowledged || !reason.trim()}
                        >
                          {busy
                            ? t("journal.working")
                            : t("journal.confirmManualResend")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setManual(null)}
                        >
                          {t("journal.cancel")}
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ol>
            {current.truncated && (
              <p className="text-sm text-muted-foreground">
                {t("journal.truncated")}
              </p>
            )}
          </>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
