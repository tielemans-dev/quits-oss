import { useCallback, useEffect, useState } from "react"
import { BellRing } from "lucide-react"
import type { InvoiceReminderRecord, ReminderStatus } from "@yaip/contracts/reminders"
import { formatDate } from "../../../lib/i18n/format"
import { useI18n } from "../../../lib/i18n/react"
import { trpc } from "../../../trpc/client"
import { describeReminderOffset } from "../../settings/reminder-policy-card"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table"
import type { InvoicePanelProps } from "./types"

type ReminderCapabilities = { canSendNow: boolean; canPause: boolean }

type RemindersState = {
  remindersPaused: boolean
  policyEnabled: boolean
  remindable: boolean
  hasRecipient: boolean
  reminders: InvoiceReminderRecord[]
}

const statusVariant: Record<ReminderStatus, "default" | "secondary" | "destructive" | "outline"> = {
  upcoming: "outline",
  scheduled: "secondary",
  sent: "default",
  failed: "destructive",
  skipped: "outline",
}

/** Owned by the reminders feature. */
export function InvoiceRemindersPanel({ invoice, locale, onChanged }: InvoicePanelProps) {
  const { t } = useI18n()
  const [state, setState] = useState<RemindersState | null>(null)
  // Nothing is allowed until the server says so; accountants may only look.
  const [capabilities, setCapabilities] = useState<ReminderCapabilities>({ canSendNow: false, canPause: false })
  const [busy, setBusy] = useState<"pause" | "send" | null>(null)
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await trpc.reminders.listForInvoice.query({ invoiceId: invoice.id }))
    } catch {
      setMessage({ kind: "error", text: t("reminders.panel.error.load") })
    }
  }, [invoice.id, t])

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => trpc.reminders.capabilities.query())
      .then((result) => {
        if (!cancelled) setCapabilities(result)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Reload when the invoice changes status, e.g. after a payment settles it.
  useEffect(() => {
    void load()
  }, [load, invoice.status, invoice.paymentStatus])

  if (invoice.status === "draft") {
    return null
  }

  async function run(kind: "pause" | "send", action: () => Promise<unknown>, success?: string) {
    setBusy(kind)
    setMessage(null)
    try {
      await action()
      if (success) setMessage({ kind: "success", text: success })
      await load()
      await onChanged()
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error && error.message ? error.message : t("reminders.panel.error.action"),
      })
    } finally {
      setBusy(null)
    }
  }

  const canSend = Boolean(state?.remindable && state.hasRecipient)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t("reminders.panel.title")}</CardTitle>
            <CardDescription>{t("reminders.panel.description")}</CardDescription>
          </div>
          {capabilities.canSendNow && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canSend || busy !== null}
              onClick={() =>
                run(
                  "send",
                  () => trpc.reminders.sendNow.mutate({ invoiceId: invoice.id }),
                  t("reminders.panel.sent")
                )
              }
            >
              <BellRing className="size-3.5" />
              {busy === "send" ? t("reminders.panel.sending") : t("reminders.panel.sendNow")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {state && (
          <>
            {!state.remindable && (
              <p className="text-sm text-muted-foreground">{t("reminders.panel.notEligible")}</p>
            )}
            {state.remindable && !state.hasRecipient && (
              <p className="text-sm text-muted-foreground">{t("reminders.panel.noEmail")}</p>
            )}
            {!state.policyEnabled && (
              <p className="text-sm text-muted-foreground">{t("reminders.panel.policyDisabled")}</p>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.remindersPaused}
                disabled={!capabilities.canPause || busy !== null}
                onChange={(event) => {
                  const paused = event.target.checked
                  void run("pause", () =>
                    trpc.reminders.setPaused.mutate({ invoiceId: invoice.id, paused })
                  )
                }}
              />
              {t("reminders.panel.paused")}
            </label>

            {state.reminders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("reminders.panel.empty")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("reminders.panel.column.when")}</TableHead>
                    <TableHead>{t("reminders.panel.column.schedule")}</TableHead>
                    <TableHead>{t("reminders.panel.column.status")}</TableHead>
                    <TableHead>{t("reminders.panel.column.detail")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.reminders.map((reminder) => (
                    <TableRow key={reminder.id ?? `upcoming-${reminder.offsetDays}`}>
                      <TableCell>
                        {formatDate(reminder.sentAt ?? reminder.scheduledFor, locale, undefined, { month: "short" })}
                      </TableCell>
                      <TableCell>
                        {reminder.manual
                          ? t("reminders.panel.manual")
                          : describeReminderOffset(reminder.offsetDays, t)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant[reminder.status]}>
                          {t(`reminders.status.${reminder.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{reminder.message ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {message && (
          <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
