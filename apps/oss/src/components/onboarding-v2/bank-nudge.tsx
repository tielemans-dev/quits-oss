import { useEffect, useId, useRef, useState } from "react"
import { paymentDetailsInputSchema } from "@quits/contracts/payment-details"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { handledMutationError } from "../../lib/query-refresh"
import { ERROR_KEYS, EMPTY_VALUES, toInput, toValues, validate } from "../settings/payment-details-card"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"

type Readiness = { bankMissing: boolean; onlinePayments?: boolean; canSave?: boolean }
type BankField = "regNumber" | "accountNumber"

/**
 * Check immediately before sending. When the first invoice has no bank account to print, the
 * dialog saves one inline, the same way Settings → Payments does, then lets the send continue.
 * Call `settled()` once the send has finished so the dialog can close.
 */
export function useFirstInvoiceBankNudge() {
  const { t } = useI18n()
  const idPrefix = useId()
  const [open, setOpen] = useState(false)
  const [readiness, setReadiness] = useState<Readiness>({ bankMissing: false })
  const [bank, setBank] = useState<Record<BankField, string>>({ regNumber: "", accountNumber: "" })
  const [submitted, setSubmitted] = useState(false)
  const [phase, setPhase] = useState<"idle" | "saving" | "sending">("idle")
  const [saveError, setSaveError] = useState<string | null>(null)
  const pending = useRef<((proceed: boolean) => void) | null>(null)
  useEffect(
    () => () => {
      pending.current?.(false)
    },
    [],
  )
  function finish(proceed: boolean) {
    pending.current?.(proceed)
    pending.current = null
    setOpen(false)
  }
  async function beforeSend(): Promise<boolean> {
    const next = await trpc.paymentDetails.firstSendReadiness.query()
    if (!next.bankMissing) return true
    setReadiness(next)
    setPhase("idle")
    setSaveError(null)
    return new Promise((resolve) => {
      pending.current = resolve
      setOpen(true)
    })
  }
  function settled() {
    setOpen(false)
    setPhase("idle")
  }

  const errors = validate({ ...EMPTY_VALUES, ...bank })
  const visibleError = (field: BankField) => {
    const error = submitted ? errors[field] : undefined
    const keys = ERROR_KEYS[field]
    return error && t(error === "required" && keys.required ? keys.required : keys.invalid)
  }
  async function saveAndSend() {
    setSubmitted(true)
    if (Object.keys(errors).length) return
    setPhase("saving")
    setSaveError(null)
    try {
      // Saving replaces all payment details, so keep the ones already there (such as the note).
      const current = await trpc.paymentDetails.get.query()
      await trpc.paymentDetails.update.mutate(paymentDetailsInputSchema.parse(toInput({ ...toValues(current), ...bank })), handledMutationError)
    } catch (error) {
      setPhase("idle")
      setSaveError(error instanceof Error && error.message ? error.message : t("settings.paymentDetails.error.save"))
      return
    }
    setPhase("sending")
    pending.current?.(true)
    pending.current = null
  }

  const busy = phase !== "idle"
  const field = (name: BankField, label: string, placeholder: string) => {
    const error = visibleError(name)
    return (
      <div className="grid content-start gap-1.5">
        <Label htmlFor={`${idPrefix}-${name}`}>{label}</Label>
        <Input
          id={`${idPrefix}-${name}`}
          value={bank[name]}
          disabled={busy}
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${idPrefix}-${name}-error` : undefined}
          onChange={(event) => {
            setBank((current) => ({ ...current, [name]: event.target.value }))
            setSaveError(null)
          }}
        />
        {error && <p id={`${idPrefix}-${name}-error`} className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  return {
    beforeSend,
    settled,
    dialog: (
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value && !busy) finish(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("onboardingV2.bankNudge.title")}</DialogTitle>
            <DialogDescription>{t("onboardingV2.bankNudge.body")}</DialogDescription>
          </DialogHeader>
          {readiness.canSave ? (
            <form
              id={`${idPrefix}-form`}
              noValidate
              className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void saveAndSend()
              }}
            >
              {field("regNumber", t("settings.paymentDetails.regNumber.label"), "0040")}
              {field("accountNumber", t("settings.paymentDetails.accountNumber.label"), "0440116243")}
              {saveError && <p role="alert" className="col-span-2 text-sm text-destructive">{saveError}</p>}
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{t("settings.paymentDetails.readOnly")}</p>
          )}
          <DialogFooter className="sm:items-center">
            {!readiness.onlinePayments && (
              <p className="text-sm text-muted-foreground sm:mr-auto" data-testid="bank-nudge-no-payment-method">
                {t("onboardingV2.bankNudge.noPaymentMethod")}
              </p>
            )}
            <Button variant="outline" disabled={busy} onClick={() => finish(true)}>
              {t("onboardingV2.bankNudge.continue")}
            </Button>
            {readiness.canSave && (
              <Button type="submit" form={`${idPrefix}-form`} disabled={busy || (!bank.regNumber.trim() && !bank.accountNumber.trim())}>
                {phase === "saving"
                  ? t("settings.paymentDetails.saving")
                  : phase === "sending"
                    ? t("invoices.detail.action.sending")
                    : t("onboardingV2.bankNudge.save")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  }
}
