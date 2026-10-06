import { useEffect, useMemo, useState } from "react"
import { Plus, X } from "lucide-react"
import {
  REMINDER_MAX_OFFSETS,
  REMINDER_OFFSET_MAX_DAYS,
  REMINDER_OFFSET_MIN_DAYS,
} from "@yaip/contracts/reminders"
import { useSession } from "../../lib/auth-client"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { Label } from "../ui/label"

type Translate = ReturnType<typeof useI18n>["t"]

/** "3 days before due", "on the due date", "7 days after". */
export function describeReminderOffset(offsetDays: number, t: Translate) {
  if (offsetDays === 0) return t("reminders.offset.onDue")
  const count = Math.abs(offsetDays)
  if (offsetDays < 0) {
    return count === 1 ? t("reminders.offset.before.one") : t("reminders.offset.before.other", { count })
  }
  return count === 1 ? t("reminders.offset.after.one") : t("reminders.offset.after.other", { count })
}

type ParsedOffsets =
  | { ok: true; offsets: number[] }
  | { ok: false; error: "invalid" | "duplicate" | "max" }

function parseOffsets(values: string[]): ParsedOffsets {
  if (values.length > REMINDER_MAX_OFFSETS) return { ok: false, error: "max" }
  const offsets: number[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const number = Number(trimmed)
    if (
      trimmed === "" ||
      !Number.isInteger(number) ||
      number < REMINDER_OFFSET_MIN_DAYS ||
      number > REMINDER_OFFSET_MAX_DAYS
    ) {
      return { ok: false, error: "invalid" }
    }
    offsets.push(number)
  }
  if (new Set(offsets).size !== offsets.length) return { ok: false, error: "duplicate" }
  return { ok: true, offsets: offsets.sort((a, b) => a - b) }
}

export function ReminderPolicyCard() {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState(false)
  // Only admins may change the policy (settings:update); everyone else sees it read-only.
  const [canUpdate, setCanUpdate] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [offsets, setOffsets] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null)
  // The policy and the user's rights belong to the active organization; `undefined` while loading.
  const { data: session, isPending: sessionPending } = useSession()
  const organizationId = sessionPending ? undefined : (session?.session.activeOrganizationId ?? null)

  // Switching organization keeps the card mounted, so start over read-only and reload.
  useEffect(() => {
    setLoaded(false)
    setCanUpdate(false)
    setMessage(null)
    if (organizationId === undefined) return
    let cancelled = false
    // Start inside a promise chain so any client failure lands in the error state.
    Promise.resolve()
      .then(() => Promise.all([trpc.reminders.getPolicy.query(), trpc.reminders.capabilities.query()]))
      .then(([policy, capabilities]) => {
        if (cancelled) return
        setEnabled(policy.enabled)
        setOffsets(policy.offsetsDays.map(String))
        setCanUpdate(capabilities.canUpdatePolicy)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setMessage({ kind: "error", text: t("reminders.policy.error.load") })
      })
    return () => {
      cancelled = true
    }
  }, [t, organizationId])

  const editable = loaded && canUpdate
  const parsed = useMemo(() => parseOffsets(offsets), [offsets])
  const preview = parsed.ok && parsed.offsets.length > 0
    ? t("reminders.policy.preview", {
        schedule: parsed.offsets.map((offset) => describeReminderOffset(offset, t)).join(", "),
      })
    : null

  async function handleSave() {
    if (!parsed.ok) return
    setSaving(true)
    setMessage(null)
    try {
      const policy = await trpc.reminders.updatePolicy.mutate({ enabled, offsetsDays: parsed.offsets })
      setEnabled(policy.enabled)
      setOffsets(policy.offsetsDays.map(String))
      setMessage({ kind: "success", text: t("reminders.policy.saved") })
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error && error.message ? error.message : t("reminders.policy.error.save"),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("reminders.policy.title")}</CardTitle>
        <CardDescription>{t("reminders.policy.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!editable}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("reminders.policy.enabled.label")}
        </label>

        <div className="grid gap-2">
          <Label>{t("reminders.policy.offsets.label")}</Label>
          {offsets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("reminders.policy.offsets.empty")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {offsets.map((value, index) => (
                <div key={index} className="flex items-center gap-1">
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={REMINDER_OFFSET_MIN_DAYS}
                    max={REMINDER_OFFSET_MAX_DAYS}
                    className="w-20"
                    value={value}
                    disabled={!editable}
                    onChange={(event) =>
                      setOffsets((current) =>
                        current.map((entry, entryIndex) => (entryIndex === index ? event.target.value : entry))
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={t("reminders.policy.offsets.remove")}
                    disabled={!editable}
                    onClick={() => setOffsets((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("reminders.policy.offsets.help")}</p>
          {editable && offsets.length < REMINDER_MAX_OFFSETS && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!editable}
                onClick={() => setOffsets((current) => [...current, ""])}
              >
                <Plus className="size-3.5" />
                {t("reminders.policy.offsets.add")}
              </Button>
            </div>
          )}
        </div>

        {!parsed.ok && loaded && (
          <p className="text-sm text-destructive">{t(`reminders.policy.error.${parsed.error}`)}</p>
        )}
        {preview && <p className="text-sm text-muted-foreground">{preview}</p>}
        {message && (
          <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </p>
        )}

        {loaded && !canUpdate && (
          <p className="text-sm text-muted-foreground">{t("reminders.policy.readOnly")}</p>
        )}
        {editable && (
          <div>
            <Button type="button" onClick={handleSave} disabled={saving || !parsed.ok}>
              {saving ? t("reminders.policy.saving") : t("reminders.policy.save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
