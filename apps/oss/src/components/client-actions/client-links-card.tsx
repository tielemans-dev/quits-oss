import { useCallback, useEffect, useState } from "react"
import {
  CLIENT_ACTION_DEFAULT_EXPIRY_DAYS,
  clientActionNeedsVerification,
  type ClientActionGrantInput,
  type ClientActionRecordKind,
} from "@quits/contracts/client-actions"
import type { ClientActionPage } from "../../lib/client-actions/page"
import { formatDate } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { LocalizedDocument } from "../documents/localized-document"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { ClientActionHub } from "./client-action-hub"

type Links = Awaited<ReturnType<typeof trpc.clientLinks.list.query>>
type Candidates = Awaited<ReturnType<typeof trpc.clientLinks.candidates.query>>
type Access = "none" | "view" | "pay" | "approve"

const EXPIRY_CHOICES = [7, 30, 60, 90] as const

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none"

function accessOptionsFor(kind: ClientActionRecordKind): Access[] {
  return kind === "invoice" ? ["none", "view", "pay"] : ["none", "view", "approve"]
}

function grantFor(kind: ClientActionRecordKind, recordId: string, access: Access): ClientActionGrantInput | null {
  if (access === "none") return null
  return { kind, recordId, capabilities: access === "view" ? ["view"] : ["view", access] }
}

/**
 * The seller's controls for a contact's client action page: who gets a link, exactly which records
 * it holds and what the holder may do with each, and a preview of the page the recipient gets.
 * Hidden for roles that may not hold links.
 */
export function ClientLinksCard({
  contactId,
  contactName,
  contactEmail,
}: {
  contactId: string
  contactName: string
  contactEmail: string | null
}) {
  const { t, locale } = useI18n()
  const [links, setLinks] = useState<Links | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ name: string; page: ClientActionPage | null } | null>(null)

  const load = useCallback(async () => {
    try {
      setLinks(await trpc.clientLinks.list.query({ contactId }))
      setLoadFailed(false)
    } catch (error) {
      const code = (error as { data?: { code?: string } })?.data?.code
      if (code === "FORBIDDEN") setForbidden(true)
      else setLoadFailed(true)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  if (forbidden) return null

  async function act(work: () => Promise<unknown>) {
    setMessage(null)
    try {
      await work()
      await load()
    } catch {
      setMessage(t("clientLinks.error.action"))
    }
  }

  async function openPreview(id: string, name: string) {
    setMessage(null)
    try {
      const result = await trpc.clientLinks.preview.query({ id })
      setPreview({ name, page: result.page as ClientActionPage | null })
    } catch {
      setMessage(t("clientLinks.error.action"))
    }
  }

  async function copy(url: string) {
    await navigator.clipboard?.writeText(url)
    setMessage(t("clientLinks.copied"))
  }

  const date = (value: Date | string) => formatDate(value, locale, undefined, { month: "short" })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("clientLinks.title")}</CardTitle>
        <CardDescription>{t("clientLinks.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {loadFailed ? <p className="text-sm text-destructive" role="alert">{t("clientLinks.loadFailed")}</p> : null}
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{message}</p>
        {createdUrl ? (
          <div className="grid gap-2 rounded-md border bg-muted/30 p-3" data-testid="created-client-link">
            <p className="font-medium">{t("clientLinks.created")}</p>
            <Input readOnly value={createdUrl} aria-label={t("clientLinks.copy")} onFocus={(event) => event.currentTarget.select()} />
            <p className="text-sm text-muted-foreground">{t("clientLinks.bearerNote")}</p>
            <div>
              <Button type="button" variant="outline" onClick={() => void copy(createdUrl)}>{t("clientLinks.copy")}</Button>
            </div>
          </div>
        ) : null}

        {links && links.length === 0 && !creating ? <p className="text-sm text-muted-foreground">{t("clientLinks.empty")}</p> : null}
        {links && links.length > 0 ? (
          <ul className="grid gap-3">
            {links.map((link) => (
              <li key={link.id} className="grid gap-2 rounded-lg border p-3" data-testid="client-link-row" data-state={link.state}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{link.recipientName}</span>
                  <Badge variant={link.state === "active" ? "default" : "outline"}>{t(`clientLinks.state.${link.state}`)}</Badge>
                  {link.verification === "email_code" ? <Badge variant="secondary">{t("clientLinks.emailCode")}</Badge> : null}
                </div>
                {link.recipientEmail ? <p className="text-sm text-muted-foreground">{link.recipientEmail}</p> : null}
                <p className="text-sm text-muted-foreground">
                  {link.revokedAt ? t("clientLinks.revokedOn", { date: date(link.revokedAt) }) : t("clientLinks.expires", { date: date(link.expiresAt) })}
                  {" · "}
                  {link.lastOpenedAt ? t("clientLinks.lastOpened", { date: date(link.lastOpenedAt) }) : t("clientLinks.neverOpened")}
                </p>
                <ul className="grid gap-1 text-sm">
                  {link.grants.map((grant) => (
                    <li key={grant.id} className="flex flex-wrap items-center gap-2">
                      <span>{t(`clientActions.kind.${grant.kind}`)} {grant.label}</span>
                      {grant.capabilities.map((capability) => (
                        <Badge key={capability} variant="outline">{t(`clientLinks.cap.${capability}`)}</Badge>
                      ))}
                      {grant.stale ? <span className="text-amber-700 dark:text-amber-400">{t("clientLinks.stale")}</span> : null}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {link.state === "active" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void copy(link.url)}>{t("clientLinks.copy")}</Button>
                  ) : null}
                  {link.state !== "revoked" ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => void openPreview(link.id, link.recipientName)}>
                      {t("clientLinks.preview")}
                    </Button>
                  ) : null}
                  {link.state !== "revoked" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void act(() => trpc.clientLinks.renew.mutate({ id: link.id, expiresInDays: CLIENT_ACTION_DEFAULT_EXPIRY_DAYS }))}
                    >
                      {t("clientLinks.renewDays", { days: CLIENT_ACTION_DEFAULT_EXPIRY_DAYS })}
                    </Button>
                  ) : null}
                  {link.state !== "revoked" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t("clientLinks.revokeConfirm"))) void act(() => trpc.clientLinks.revoke.mutate({ id: link.id }))
                      }}
                    >
                      {t("clientLinks.revoke")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {preview ? (
          <section aria-label={t("clientLinks.preview")} className="grid gap-3 rounded-lg border p-3" data-testid="client-link-preview">
            {preview.page ? (
              <LocalizedDocument locale={preview.page.locale}>
                <PreviewBanner name={preview.name} />
                <ClientActionHub page={preview.page} preview embedded />
              </LocalizedDocument>
            ) : (
              <p className="text-sm text-muted-foreground">{t("clientLinks.preview.inactive")}</p>
            )}
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setPreview(null)}>{t("clientLinks.preview.close")}</Button>
            </div>
          </section>
        ) : null}

        {creating ? (
          <CreateForm
            contactId={contactId}
            defaultName={contactName}
            defaultEmail={contactEmail}
            onCancel={() => setCreating(false)}
            onCreated={(url) => {
              setCreating(false)
              setCreatedUrl(url)
              void load()
            }}
          />
        ) : (
          <div>
            <Button type="button" onClick={() => { setCreating(true); setCreatedUrl(null) }}>{t("clientLinks.create")}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PreviewBanner({ name }: { name: string }) {
  const { t } = useI18n()
  return <p className="rounded-md bg-muted p-2 text-sm" role="note">{t("clientActions.preview.banner", { name })}</p>
}

function CreateForm({
  contactId,
  defaultName,
  defaultEmail,
  onCancel,
  onCreated,
}: {
  contactId: string
  defaultName: string
  defaultEmail: string | null
  onCancel: () => void
  onCreated: (url: string) => void
}) {
  const { t } = useI18n()
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [recipientName, setRecipientName] = useState(defaultName)
  const [recipientEmail, setRecipientEmail] = useState(defaultEmail ?? "")
  const [access, setAccess] = useState<Record<string, Access>>({})
  const [expiresInDays, setExpiresInDays] = useState<number>(CLIENT_ACTION_DEFAULT_EXPIRY_DAYS)
  const [verifyChoice, setVerifyChoice] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void trpc.clientLinks.candidates.query({ contactId }).then(setCandidates).catch(() => setError(t("clientLinks.loadFailed")))
  }, [contactId])

  const key = (kind: ClientActionRecordKind, id: string) => `${kind}:${id}`
  const records: { kind: ClientActionRecordKind; id: string; label: string }[] = candidates
    ? [
        ...candidates.agreements.map((a) => ({ kind: "agreement" as const, id: a.id, label: [a.number, a.title].filter(Boolean).join(" · ") })),
        ...candidates.deliverables.map((d) => ({ kind: "deliverable" as const, id: d.id, label: [d.agreementNumber, d.title].filter(Boolean).join(" · ") })),
        ...candidates.invoices.map((i) => ({ kind: "invoice" as const, id: i.id, label: i.number ?? "" })),
      ]
    : []

  function applyPreset(preset: "finance" | "approver") {
    const next: Record<string, Access> = {}
    for (const record of records) {
      if (preset === "finance" && record.kind === "invoice") next[key(record.kind, record.id)] = "pay"
      if (preset === "approver" && record.kind !== "invoice") next[key(record.kind, record.id)] = "approve"
    }
    setAccess(next)
  }

  const grants = records.flatMap((record) => {
    const grant = grantFor(record.kind, record.id, access[key(record.kind, record.id)] ?? "none")
    return grant ? [grant] : []
  })
  const mustVerify = clientActionNeedsVerification(grants)
  // Only approving ever waits for the code; a link that cannot approve has nothing to verify.
  const canApprove = grants.some((grant) => grant.capabilities.includes("approve"))
  const verification = canApprove && (mustVerify || verifyChoice) ? "email_code" : "none"

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await trpc.clientLinks.create.mutate({
        contactId,
        recipientName,
        recipientEmail: recipientEmail.trim() || null,
        expiresInDays,
        verification,
        grants,
      })
      onCreated(created.url)
    } catch (caught) {
      const reason = (caught as { data?: { reason?: string } })?.data?.reason
      setError(reason === "email_unavailable" ? t("clientLinks.error.emailUnavailable") : t("clientLinks.error.create"))
      setBusy(false)
    }
  }

  return (
    <form className="grid gap-4 rounded-lg border p-4" onSubmit={(event) => void submit(event)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="client-link-name">{t("clientLinks.recipientName")}</Label>
          <Input id="client-link-name" required maxLength={200} value={recipientName} onChange={(event) => setRecipientName(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="client-link-email">{t("clientLinks.recipientEmail")}</Label>
          <Input id="client-link-email" type="email" maxLength={320} value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} aria-describedby="client-link-email-hint" required={verification === "email_code"} />
          <p id="client-link-email-hint" className="text-xs text-muted-foreground">{t("clientLinks.recipientEmailHint")}</p>
        </div>
      </div>

      <fieldset className="grid gap-3" aria-busy={!candidates && !error}>
        <legend className="mb-1 font-medium">{t("clientLinks.records")}</legend>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("clientLinks.presets")}</span>
          <Button type="button" variant="outline" size="sm" disabled={!candidates || busy} onClick={() => applyPreset("finance")} title={t("clientLinks.preset.financeHint")}>
            {t("clientLinks.preset.finance")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!candidates || busy} onClick={() => applyPreset("approver")} title={t("clientLinks.preset.approverHint")}>
            {t("clientLinks.preset.approver")}
          </Button>
        </div>
        {!candidates && !error ? <p role="status" className="text-sm text-muted-foreground">{t("clientLinks.loadingRecords")}</p> : null}
        {candidates && records.length === 0 ? <p className="text-sm text-muted-foreground">{t("clientLinks.noRecords")}</p> : null}
        {(["agreement", "deliverable", "invoice"] as const).map((kind) => {
          const rows = records.filter((record) => record.kind === kind)
          if (rows.length === 0) return null
          return (
            <div key={kind} className="grid gap-2">
              <p className="text-sm font-medium">{t(`clientLinks.records.${kind}`)}</p>
              {rows.map((record) => {
                const id = `client-link-${kind}-${record.id}`
                return (
                  <div key={record.id} className="grid items-center gap-2 sm:grid-cols-[1fr_12rem]">
                    <Label htmlFor={id} className="font-normal">{record.label}</Label>
                    <select
                      id={id}
                      className={selectClass}
                      value={access[key(kind, record.id)] ?? "none"}
                      onChange={(event) => setAccess((current) => ({ ...current, [key(kind, record.id)]: event.target.value as Access }))}
                    >
                      {accessOptionsFor(kind).map((option) => (
                        <option key={option} value={option}>{t(`clientLinks.access.${option}`)}</option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )
        })}
      </fieldset>

      <div className="grid gap-2 sm:max-w-xs">
        <Label htmlFor="client-link-expiry">{t("clientLinks.expiry")}</Label>
        <select id="client-link-expiry" className={selectClass} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
          {EXPIRY_CHOICES.map((days) => (
            <option key={days} value={days}>{t("clientLinks.expiryDays", { days })}</option>
          ))}
        </select>
      </div>

      {canApprove ? (
      <div className="grid gap-1">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={verification === "email_code"}
            disabled={mustVerify}
            onChange={(event) => setVerifyChoice(event.target.checked)}
          />
          <span>{t("clientLinks.verification")}</span>
        </label>
        <p className="text-xs text-muted-foreground">
          {mustVerify ? t("clientLinks.verification.required") : t("clientLinks.verification.bearer")}
        </p>
      </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {candidates && grants.length === 0 ? <p className="text-sm text-muted-foreground">{t("clientLinks.noGrant")}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || grants.length === 0}>
          {busy ? t("clientLinks.submitting") : t("clientLinks.submit")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>{t("clientLinks.cancel")}</Button>
      </div>
    </form>
  )
}
