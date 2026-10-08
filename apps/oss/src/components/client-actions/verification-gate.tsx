import { useState } from "react"
import type { CodeCheckResult, CodeRequestResult } from "../../lib/client-actions/public-session"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"

/**
 * Asks an approver to prove they hold the email address the page was made for. Shown only while
 * approving needs it; viewing and paying never wait for it.
 */
export function VerificationGate({
  emailHint,
  requestCode,
  submitCode,
  onVerified,
  compact = false,
}: {
  emailHint: string | null
  requestCode: () => Promise<CodeRequestResult>
  // Supersession is local UI ownership, never a server claim about the link or code.
  submitCode: (code: string) => Promise<CodeCheckResult | { status: "superseded" }>
  onVerified: () => void
  compact?: boolean
}) {
  const { t } = useI18n()
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function send() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await requestCode()
      if (result.status === "sent") {
        setSent(true)
        setMessage(t("clientActions.gate.sent"))
      } else if (result.status === "rate_limited") setMessage(t("clientActions.gate.rateLimited"))
      else setMessage(t("clientActions.gate.unavailable"))
    } catch {
      setMessage(t("clientActions.refused.failed"))
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await submitCode(code)
      if (result.status === "superseded") return
      if (result.status === "verified") {
        setMessage(t("clientActions.gate.verified"))
        onVerified()
      } else if (result.status === "inactive") setMessage(t("clientActions.refused.inactive"))
      else setMessage(t(`clientActions.gate.${result.status}`))
    } catch {
      setMessage(t("clientActions.refused.failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="client-actions-gate" className="grid gap-3 rounded-lg border bg-muted/30 p-4">
      <h2 id="client-actions-gate" className={compact ? "font-medium" : "text-lg font-semibold"}>
        {t("clientActions.gate.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {emailHint ? t("clientActions.gate.body", { email: emailHint }) : t("clientActions.gate.bodyNoEmail")}
      </p>
      <div>
        <Button type="button" variant={sent ? "outline" : "default"} disabled={busy} onClick={() => void send()} className="w-full sm:w-auto">
          {busy && !sent ? t("clientActions.gate.sending") : sent ? t("clientActions.gate.resend") : t("clientActions.gate.send")}
        </Button>
      </div>
      {sent ? (
        <form
          className="grid gap-2 sm:max-w-xs"
          onSubmit={(event) => {
            event.preventDefault()
            void verify()
          }}
        >
          <Label htmlFor="client-actions-code">{t("clientActions.gate.codeLabel")}</Label>
          <Input
            id="client-actions-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || code.length !== 6}>
            {t("clientActions.gate.verify")}
          </Button>
        </form>
      ) : null}
      <p role="status" aria-live="polite" className="min-h-5 text-sm">
        {message}
      </p>
    </section>
  )
}
