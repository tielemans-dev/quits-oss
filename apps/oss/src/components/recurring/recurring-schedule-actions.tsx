import { useState } from "react"
import { MoreHorizontal, Pause, Pencil, Play, Square, Zap } from "lucide-react"
import { trpc } from "../../trpc/client"
import { useI18n } from "../../lib/i18n/react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog"
import { Button } from "../ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { formatRunDate } from "./recurring-format"
import { RecurringScheduleDialog, type EditableSchedule } from "./recurring-schedule-dialog"

type ActionSchedule = EditableSchedule & {
  status: "active" | "paused" | "ended"
  nextRunAt: Date
}

type Confirm = "end" | "runNow" | null

/**
 * Edit, pause/resume, generate now, and end for one schedule. Renders nothing for people who may
 * not update schedules (`recurring.capabilities`), since the server would reject every action.
 */
export function RecurringScheduleActions({
  schedule,
  canUpdate,
  onChanged,
  onMessage,
  variant = "menu",
}: {
  schedule: ActionSchedule
  canUpdate: boolean
  onChanged: () => void
  onMessage: (message: { kind: "info" | "error"; text: string }) => void
  /** `menu` renders a compact dropdown for table rows; `buttons` renders a toolbar. */
  variant?: "menu" | "buttons"
}) {
  const { t, locale } = useI18n()
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const ended = schedule.status === "ended"

  async function run(action: () => Promise<string | null>) {
    setBusy(true)
    try {
      const info = await action()
      if (info) onMessage({ kind: "info", text: info })
      onChanged()
    } catch (error) {
      onMessage({
        kind: "error",
        text: error instanceof Error ? error.message : t("recurring.error.action"),
      })
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const togglePause = () =>
    run(async () => {
      if (schedule.status === "active") {
        await trpc.recurring.setStatus.mutate({ id: schedule.id, status: "paused" })
      } else {
        await trpc.recurring.resume.mutate({ id: schedule.id })
      }
      return null
    })

  const runNow = () =>
    run(async () => {
      const result = await trpc.recurring.runNow.mutate({ id: schedule.id })
      return result.invoice ? t("recurring.runNow.done", { number: result.invoice.number }) : null
    })

  const end = () =>
    run(async () => {
      await trpc.recurring.setStatus.mutate({ id: schedule.id, status: "ended" })
      return null
    })

  if (!canUpdate) return null

  const pauseLabel = schedule.status === "active" ? t("recurring.action.pause") : t("recurring.action.resume")
  const PauseIcon = schedule.status === "active" ? Pause : Play

  return (
    <>
      {variant === "menu" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy || ended}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil className="size-4" />
              {t("recurring.action.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConfirm("runNow")}>
              <Zap className="size-4" />
              {t("recurring.action.runNow")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={togglePause}>
              <PauseIcon className="size-4" />
              {pauseLabel}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("end")}>
              <Square className="size-4" />
              {t("recurring.action.end")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        !ended && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              {t("recurring.action.edit")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={togglePause}>
              <PauseIcon className="size-4" />
              {pauseLabel}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm("end")}>
              <Square className="size-4" />
              {t("recurring.action.end")}
            </Button>
            <Button disabled={busy} onClick={() => setConfirm("runNow")}>
              <Zap className="size-4" />
              {t("recurring.action.runNow")}
            </Button>
          </div>
        )
      )}

      <RecurringScheduleDialog
        open={editing}
        onOpenChange={setEditing}
        schedule={schedule}
        onSaved={onChanged}
      />

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "end" ? t("recurring.confirm.end.title") : t("recurring.confirm.runNow.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "end"
                ? t("recurring.confirm.end.description")
                : t(
                    schedule.autoSend
                      ? "recurring.confirm.runNow.descriptionAutoSend"
                      : "recurring.confirm.runNow.description",
                    { date: formatRunDate(schedule.nextRunAt, locale) }
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("recurring.confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void (confirm === "end" ? end() : runNow())
              }}
            >
              {confirm === "end" ? t("recurring.action.end") : t("recurring.action.runNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
