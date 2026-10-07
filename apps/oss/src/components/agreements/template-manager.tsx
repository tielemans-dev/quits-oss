import { useEffect, useState } from "react"
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

type Template = Awaited<
  ReturnType<typeof trpc.agreements.listTemplates.query>
>[number]
const empty = { id: "", name: "", termsMarkdown: "", isDefault: false }
export function AgreementTemplateManager() {
  const { t } = useI18n()
  const [allowed, setAllowed] = useState(false)
  const [templates, setTemplates] = useState<Template[]>([])
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    trpc.agreements.capabilities
      .query()
      .then(async (capabilities) => {
        if (!capabilities.manageTemplates || cancelled) return
        const rows = await trpc.agreements.listTemplates.query()
        if (!cancelled) {
          setTemplates(rows)
          setAllowed(true)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : t("agreements.error"))
      })
    return () => {
      cancelled = true
    }
  }, [t])
  async function mutate(remove = false) {
    setBusy(true)
    setError(null)
    try {
      const { id, ...data } = form
      if (remove) await trpc.agreements.deleteTemplate.mutate({ id })
      else if (id) await trpc.agreements.updateTemplate.mutate({ id, ...data })
      else await trpc.agreements.createTemplate.mutate(data)
      setTemplates(await trpc.agreements.listTemplates.query())
      setForm(empty)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("agreements.error"))
    } finally {
      setBusy(false)
    }
  }
  if (!allowed) return error ? <p role="alert">{error}</p> : null
  return (
    <details className="border rounded-md p-4">
      <summary className="cursor-pointer">
        {t("agreements.manageTemplates")}
      </summary>
      <div className="grid gap-4 mt-4 max-w-2xl">
        <p className="text-sm text-muted-foreground">
          {t("agreements.legalNotice")}
        </p>
        <Label htmlFor="template-choice">{t("agreements.template")}</Label>
        <select
          id="template-choice"
          className="border rounded-md p-2"
          value={form.id}
          disabled={busy}
          onChange={(e) => {
            const template = templates.find((row) => row.id === e.target.value)
            setForm(template ? { ...template } : empty)
          }}
        >
          <option value="">{t("agreements.newTemplate")}</option>
          {templates.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <Label htmlFor="template-name">{t("agreements.templateName")}</Label>
        <Input
          id="template-name"
          value={form.name}
          maxLength={200}
          disabled={busy}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, name: e.target.value }))
          }
        />
        <Label htmlFor="template-terms">{t("agreements.terms")}</Label>
        <Textarea
          id="template-terms"
          rows={10}
          maxLength={50_000}
          value={form.termsMarkdown}
          disabled={busy}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, termsMarkdown: e.target.value }))
          }
        />
        <p className="text-sm text-muted-foreground">
          {t("agreements.templatePlaceholders")}
        </p>
        <Label className="flex gap-2">
          <input
            type="checkbox"
            checked={form.isDefault}
            disabled={busy}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, isDefault: e.target.checked }))
            }
          />
          {t("agreements.defaultTemplate")}
        </Label>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={busy || !form.name.trim()}
            onClick={() => void mutate()}
          >
            {t("agreements.saveTemplate")}
          </Button>
          {form.id && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={busy}>
                  {t("agreements.deleteTemplate")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("agreements.deleteTemplate")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("agreements.deleteTemplateConfirm")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t("agreements.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction onClick={() => void mutate(true)}>
                    {t("agreements.deleteTemplate")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </details>
  )
}
