import { useState } from "react"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Textarea } from "../ui/textarea"
import { Label } from "../ui/label"
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
function ConfirmAction({
  label,
  description,
  disabled,
  run,
}: {
  label: string
  description: string
  disabled: boolean
  run: () => void
}) {
  const { t } = useI18n()
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("agreements.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={run}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
export function AgreementActions({
  agreement,
  capabilities,
  onChanged,
  onError,
}: {
  agreement: Agreement
  capabilities: Capabilities
  onChanged: () => Promise<void>
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [recipient, setRecipient] = useState("")
  const [name, setName] = useState("")
  const [note, setNote] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const disabled = busy || agreement.lastEmailAttemptOutcome === "sending"
  const id = agreement.id
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await onChanged()
    } catch (error) {
      onError(error instanceof Error ? error.message : t("agreements.error"))
      await onChanged()
    } finally {
      setBusy(false)
    }
  }
  const canRead = Boolean(
    agreement.acceptedAt && ["accepted", "completed", "cancelled"].includes(agreement.status),
  )
  return (
    <section className="grid gap-4 rounded-md border p-4">
      <div className="flex flex-wrap gap-2">
        {agreement.status === "draft" && capabilities.send && (
          <Button
            disabled={disabled}
            onClick={() => void run(() => trpc.agreements.send.mutate({ id }))}
          >
            {t("agreements.send")}
          </Button>
        )}
        {["sent", "expired", "declined"].includes(agreement.status) && capabilities.update && (
          <ConfirmAction
            label={t("agreements.recall")}
            description={t("agreements.recallConfirm")}
            disabled={disabled}
            run={() => void run(() => trpc.agreements.recall.mutate({ id }))}
          />
        )}
        {agreement.offerSnapshot && capabilities.update && (
          <ConfirmAction
            label={t("agreements.revokeLinks")}
            description={t("agreements.revokeConfirm")}
            disabled={disabled}
            run={() => void run(() => trpc.agreements.revokeLinks.mutate({ id }))}
          />
        )}
        {canRead && agreement.issuedToEmail && capabilities.send && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void run(() => trpc.agreements.sendReadLink.mutate({ id }))}
          >
            {t("agreements.sendReadLink")}
          </Button>
        )}
        {agreement.offerSnapshot && (
          <Button asChild variant="outline">
            <a href={`/api/agreements/${id}/pdf`} target="_blank" rel="noreferrer">
              {t("agreements.pdf")}
            </a>
          </Button>
        )}
      </div>
      {capabilities.send && ["draft", "sent"].includes(agreement.status) && (
        <div className="grid gap-2">
          <Label htmlFor="issue-recipient">{t("agreements.optionalRecipient")}</Label>
          <Input
            id="issue-recipient"
            type="email"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder={agreement.issuedToEmail ?? ""}
          />
          <Button
            variant="outline"
            disabled={disabled}
            className="justify-self-start"
            onClick={() =>
              void run(() =>
                agreement.status === "draft"
                  ? trpc.agreements.issue.mutate({
                      id,
                      ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
                    })
                  : trpc.agreements.resend.mutate({
                      id,
                      ...(recipient.trim() ? { recipient: recipient.trim() } : {}),
                    }),
              )
            }
          >
            {t(agreement.status === "draft" ? "agreements.issue" : "agreements.resend")}
          </Button>
        </div>
      )}
      {agreement.status === "sent" && capabilities.accept && (
        <details className="grid gap-2">
          <summary className="cursor-pointer">{t("agreements.recordAcceptance")}</summary>
          <div className="grid gap-2 mt-3">
            <Label htmlFor="internal-name">{t("agreements.signerName")}</Label>
            <Input
              id="internal-name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
            <Label htmlFor="evidence-note">{t("agreements.evidenceNote")}</Label>
            <Textarea
              id="evidence-note"
              value={note}
              maxLength={5000}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button
              disabled={disabled || !name.trim() || !note.trim()}
              onClick={() =>
                void run(() =>
                  trpc.agreements.recordAcceptance.mutate({
                    id,
                    acceptedByName: name,
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
      {["sent", "accepted"].includes(agreement.status) && capabilities.close && (
        <details>
          <summary className="cursor-pointer">{t("agreements.cancelAgreement")}</summary>
          <div className="grid gap-2 mt-3">
            <Label htmlFor="close-reason">{t("agreements.closeReason")}</Label>
            <Textarea
              id="close-reason"
              value={reason}
              maxLength={5000}
              onChange={(event) => setReason(event.target.value)}
            />
            <ConfirmAction
              label={t("agreements.cancelAgreement")}
              description={t("agreements.cancelConfirm")}
              disabled={disabled || !reason.trim()}
              run={() =>
                void run(() =>
                  trpc.agreements.close.mutate({ id, disposition: "cancelled", reason }),
                )
              }
            />
          </div>
        </details>
      )}
      {agreement.lastEmailAttemptMessage && (
        <p className="text-sm text-muted-foreground">{agreement.lastEmailAttemptMessage}</p>
      )}
    </section>
  )
}
