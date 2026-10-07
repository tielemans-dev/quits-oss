import { useState } from "react"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../ui/alert-dialog"

type Agreement = Awaited<ReturnType<typeof trpc.agreements.get.query>>
type Capabilities = Awaited<ReturnType<typeof trpc.agreements.capabilities.query>>
export function DeliverableControls({
  agreement,
  line,
  capabilities,
  onChanged,
  onError,
}: {
  agreement: Agreement
  line: Agreement["deliverables"][number]
  capabilities: Capabilities
  onChanged: () => Promise<void>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [date, setDate] = useState(line.expectedDate?.toISOString().slice(0, 10) ?? "")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const disabled = busy || agreement.lastEmailAttemptOutcome === "sending"
  const accepted = agreement.status === "accepted"
  const work = accepted && !line.isDeposit
  const unbilled = line.billingStatus === "unbilled"
  const input = { id: line.id, agreementId: agreement.id }
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await onChanged()
      setNote("")
    } catch (error) {
      onError(error instanceof Error ? error.message : t("agreements.error"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-3 mt-3">
      <div className="flex flex-wrap gap-2">
        {work &&
          capabilities.deliverableUpdate &&
          (line.status === "planned" ||
            (unbilled && ["delivered", "accepted"].includes(line.status))) && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  trpc.agreements.updateDeliverable.mutate({
                    ...input,
                    status: "in_progress",
                  }),
                )
              }
            >
              {t(line.status === "planned" ? "agreements.start" : "agreements.reopen")}
            </Button>
          )}
        {work &&
          capabilities.deliverableDeliver &&
          ["planned", "in_progress", "changes_requested"].includes(line.status) && (
            <Button
              disabled={disabled}
              onClick={() => void run(() => trpc.agreements.markDeliverableDelivered.mutate(input))}
            >
              {t("agreements.markDelivered")}
            </Button>
          )}
        {accepted && capabilities.deliverableUpdate && unbilled && line.status !== "cancelled" && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={disabled}>
                {t("agreements.cancelDeliverable")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("agreements.cancelDeliverable")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("agreements.cancelDeliverableConfirm", {
                    title: line.title,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void run(() => trpc.agreements.cancelDeliverable.mutate(input))}
                >
                  {t("agreements.cancelDeliverable")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {work && capabilities.deliverableAccept && line.status === "delivered" && (
        <details>
          <summary className="cursor-pointer">{t("agreements.recordAcceptance")}</summary>
          <div className="grid gap-2 mt-3">
            <Label htmlFor={`evidence-${line.id}`}>{t("agreements.evidenceNote")}</Label>
            <Textarea
              id={`evidence-${line.id}`}
              value={note}
              maxLength={5000}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button
              disabled={disabled || !note.trim()}
              onClick={() =>
                void run(() =>
                  trpc.agreements.acceptDeliverable.mutate({
                    ...input,
                    evidenceNote: note,
                  }),
                )
              }
            >
              {t("agreements.recordAcceptance")}
            </Button>
          </div>
        </details>
      )}
      {capabilities.deliverableUpdate && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run(() =>
              trpc.agreements.updateDeliverable.mutate({
                ...input,
                expectedDate: date || null,
              }),
            )
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={`expected-${line.id}`}>{t("agreements.expectedDate")}</Label>
            <Input
              id={`expected-${line.id}`}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={disabled}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || date === (line.expectedDate?.toISOString().slice(0, 10) ?? "")}
          >
            {t("agreements.saveExpectedDate")}
          </Button>
        </form>
      )}
    </div>
  )
}
