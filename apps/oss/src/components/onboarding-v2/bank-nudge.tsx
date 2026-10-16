import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"

/** Check immediately before sending, so adding a bank account in Settings removes the nudge. */
export function useFirstInvoiceBankNudge() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const onSettings = useRef<(() => void) | undefined>(undefined)
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
  async function beforeSend(settingsAction?: () => void): Promise<boolean> {
    onSettings.current = settingsAction
    const readiness = await trpc.paymentDetails.firstSendReadiness.query()
    if (!readiness.bankMissing) return true
    return new Promise((resolve) => {
      pending.current = resolve
      setOpen(true)
    })
  }
  return {
    beforeSend,
    dialog: (
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) finish(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("onboardingV2.bankNudge.title")}</DialogTitle>
            <DialogDescription>{t("onboardingV2.bankNudge.body")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => finish(true)}>
              {t("onboardingV2.bankNudge.continue")}
            </Button>
            <Button asChild>
              <Link to="/settings/$section" params={{ section: "payments" }} onClick={() => { onSettings.current?.(); finish(false) }}>
                {t("onboardingV2.bankNudge.settings")}
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  }
}
