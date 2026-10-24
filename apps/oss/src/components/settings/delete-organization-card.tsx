import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { switchActiveOrganization } from "../../lib/active-organization"
import { authClient } from "../../lib/auth-client"
import { invalidateAppLayoutSession } from "../../lib/app-layout-session"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { loadPage } from "../../lib/page-navigation"
import { trpc } from "../../trpc/client"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { Label } from "../ui/label"

/** Permanently deletes the organization after the admin types its name. The server checks both again. */
export function DeleteOrganizationCard({ organizationName }: { organizationName: string }) {
  const { t, locale } = useI18n()
  const [confirmName, setConfirmName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduledFor, setScheduledFor] = useState<Date | null>(null)

  async function deleteOrganization() {
    setBusy(true)
    setError(null)
    try {
      const outcome = await trpc.settings.deleteOrganization.mutate({ confirmName })
      if (outcome.status === "scheduled") {
        setScheduledFor(outcome.deleteAfter)
        setBusy(false)
        return
      }
      if (outcome.nextOrganizationId) {
        await switchActiveOrganization(outcome.nextOrganizationId)
        return
      }
      // The user may have been deleted with the organization, which already ended the session.
      await authClient.signOut().catch(() => undefined)
      invalidateAppLayoutSession()
      loadPage("/login")
    } catch {
      setError(t("settings.deleteOrganization.failed"))
      setBusy(false)
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>{t("settings.deleteOrganization.title")}</CardTitle>
        <CardDescription>{t("settings.deleteOrganization.description", { name: organizationName })}</CardDescription>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        <Link to="/activity" search={{ tab: "accounting" }} className="text-sm underline underline-offset-4">
          {t("settings.deleteOrganization.export")}
        </Link>
        {scheduledFor ? (
          <p role="status" className="text-sm">{t("settings.deleteOrganization.scheduled", { date: formatDate(scheduledFor, locale) })}</p>
        ) : (
          <AlertDialog onOpenChange={open => { if (!open) { setConfirmName(""); setError(null) } }}>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive">{t("settings.deleteOrganization.action")}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("settings.deleteOrganization.confirm.title", { name: organizationName })}</AlertDialogTitle>
                <AlertDialogDescription>{t("settings.deleteOrganization.confirm.description")}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="delete-organization-name">{t("settings.deleteOrganization.confirm.label", { name: organizationName })}</Label>
                <Input id="delete-organization-name" autoComplete="off" value={confirmName} onChange={event => setConfirmName(event.target.value)} />
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={busy}>{t("settings.deleteOrganization.confirm.cancel")}</AlertDialogCancel>
                <Button type="button" variant="destructive" disabled={busy || confirmName.trim() !== organizationName.trim()} onClick={() => void deleteOrganization()}>
                  {t("settings.deleteOrganization.confirm.submit")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </CardContent>
    </Card>
  )
}
