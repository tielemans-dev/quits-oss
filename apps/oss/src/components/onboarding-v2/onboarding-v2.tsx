import { useEffect, useRef, useState, type ReactNode } from "react"
import { Check, LoaderCircle, Search, X } from "lucide-react"
import { confirmOnboardingV2Schema, confirmOnboardingV2WithVatConfirmationSchema } from "@quits/contracts/onboarding"
import type { CvrCompany, OnboardingSuggestions } from "@quits/contracts/cvr"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { SellerVatStatus } from "../seller-vat-status"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import {
  clearDraft,
  confirmationPayload,
  draftKey,
  newDraft,
  restoreDraft,
  storeDraft,
  type OnboardingDraft,
  type ReviewValues,
} from "./draft"
import type { OnboardingV2Client } from "./client"
import { readableIssues } from "../../lib/validation/readable-errors"
import "./onboarding-v2.css"

type Screen = "search" | "working" | "review" | "failed" | "timeout" | "ceased"
type Props = {
  userId: string
  organizationId: string
  signupEmail: string
  confirmationEnabled?: boolean
  nonVatEnabled?: boolean
  client: OnboardingV2Client
  onComplete: () => void
}
const key = (suffix: string) => `onboardingV2.${suffix}` as TranslationKey

function SummaryCard({
  title,
  tag,
  children,
  className = "",
}: {
  title: string
  tag?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`ob-card ${className}`} aria-label={title}>
      <header>
        <h2>{title}</h2>
        {tag ? <span className="ob-tag">{tag}</span> : null}
      </header>
      {children}
    </section>
  )
}
function StateNotice({
  title,
  children,
  danger = false,
}: {
  title?: string
  children: ReactNode
  danger?: boolean
}) {
  return (
    <div className={`ob-notice ${danger ? "ob-danger" : ""}`} role="alert">
      {title ? <h2>{title}</h2> : null}
      {children}
    </div>
  )
}
function SourceField({
  label,
  tag,
  children,
}: {
  label: string
  tag: string
  children: ReactNode
}) {
  return (
    <div className="ob-field">
      <div className="ob-field-label">
        {label}
        <span className="ob-tag">{tag}</span>
      </div>
      {children}
    </div>
  )
}

/** Reload keeps the tab draft; route changes, explicit cancellation and completion discard it. */
export function OnboardingV2({ userId, organizationId, signupEmail, client, onComplete, confirmationEnabled = false, nonVatEnabled = false }: Props) {
  const { t, locale } = useI18n()
  const storageKey = draftKey(userId, organizationId)
  const [draft, setDraft] = useState<OnboardingDraft | null>(null)
  const [screen, setScreen] = useState<Screen>("search")
  const [restored, setRestored] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<CvrCompany[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [selected, setSelected] = useState<CvrCompany | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [bankErrors, setBankErrors] = useState(false)
  const request = useRef<AbortController | null>(null)
  const suggestionRequest = useRef<AbortController | null>(null)
  const suggestionPromise = useRef<{
    cvr: string
    result: Promise<OnboardingSuggestions | null>
    controller: AbortController
  } | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const reviewForm = useRef<HTMLFormElement | null>(null)
  const focusInvalid = useRef(false)
  // Long review page: after a rejected submit, take the user to the first field that needs fixing.
  useEffect(() => {
    if (!focusInvalid.current || !validationErrors.length) return
    focusInvalid.current = false
    // Center the first invalid field so the sticky app header and confirm bar cannot cover it.
    const target = reviewForm.current?.querySelector<HTMLElement>("[aria-invalid='true']")
    target?.focus({ preventScroll: true })
    target?.scrollIntoView?.({ block: "center" })
  }, [validationErrors])
  function reject(fields: string[]) {
    focusInvalid.current = true
    setValidationErrors(fields)
  }
  const mounted = useRef(true)
  const saving = useRef(false)
  const epoch = useRef(0)
  const TT = (suffix: string, vars?: Record<string, string | number>) => t(key(suffix), vars)

  // The answer lives in the draft, so editing other fields or reloading keeps it.
  const sellerVatChoice = draft?.vatChoiceConfirmed ? draft.values.momsRegistered : null

  function discard() {
    epoch.current++
    request.current?.abort()
    suggestionRequest.current?.abort()
    suggestionPromise.current = null
    setValidationErrors([])
    clearDraft(storageKey)
    setDraft(null)
    setRestored(false)
    setSaveFailed(false)
  }

  useEffect(() => {
    mounted.current = true
    const saved = restoreDraft(storageKey)
    if (saved) {
      // Resume an unfinished suggestion lookup after reload, without re-fetching approved facts.
      setDraft(saved)
      setScreen("review")
      setRestored(true)
    }
    const startingPath = window.location.pathname
    function clearOnLeave() {
      if (window.location.pathname !== startingPath) clearDraft(storageKey)
    }
    function clicked(event: MouseEvent) {
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null
      if (
        anchor &&
        anchor.target !== "_blank" &&
        !event.ctrlKey &&
        !event.metaKey &&
        new URL(anchor.href).pathname !== startingPath
      )
        clearDraft(storageKey)
    }
    // Navigation API distinguishes reloads from document navigations, unlike beforeunload.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation
    function navigating(event: Event) {
      const e = event as Event & { navigationType?: string; destination?: { url: string } }
      if (
        e.navigationType !== "reload" &&
        e.destination &&
        new URL(e.destination.url).pathname !== startingPath
      )
        clearDraft(storageKey)
    }
    window.addEventListener("popstate", clearOnLeave)
    document.addEventListener("click", clicked)
    navigation?.addEventListener("navigate", navigating)
    return () => {
      mounted.current = false
      epoch.current++
      request.current?.abort()
      suggestionRequest.current?.abort()
      clearOnLeave()
      window.removeEventListener("popstate", clearOnLeave)
      document.removeEventListener("click", clicked)
      navigation?.removeEventListener("navigate", navigating)
    }
  }, [storageKey])

  useEffect(() => {
    if (draft) storeDraft(storageKey, draft)
  }, [draft, storageKey])

  useEffect(() => {
    if (screen !== "search") return
    const q = query.trim()
    const numeric = /^\d+$/.test(q)
    setMatches([])
    setSearched(false)
    setInvalid(numeric && q.length !== 8)
    if (q.length < 3 || (numeric && q.length !== 8)) {
      setSearching(false)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      const timeout = setTimeout(() => {
        controller.abort()
        setScreen("timeout")
      }, 10_000)
      client
        .search(q, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setMatches(result)
          setSearched(true)
        })
        .catch(() => {
          if (!controller.signal.aborted) setScreen("failed")
        })
        .finally(() => {
          clearTimeout(timeout)
          if (!controller.signal.aborted) setSearching(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, screen, client])

  const pendingCvr = draft?.suggestionsState === "pending" ? draft.company?.cvr : undefined
  useEffect(() => {
    if (!pendingCvr || !client.suggestions) return
    const existing =
      suggestionPromise.current?.cvr === pendingCvr ? suggestionPromise.current : null
    const controller = existing?.controller ?? new AbortController()
    suggestionRequest.current = controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    function apply(suggestions: OnboardingSuggestions | null) {
      if (saving.current) return
      setDraft((current) =>
        current && current.company?.cvr === pendingCvr && current.suggestionsState === "pending"
          ? {
              ...current,
              suggestions,
              suggestionsState:
                suggestions && (suggestions.customers.length || suggestions.lines.length)
                  ? "ready"
                  : "hidden",
            }
          : current,
      )
    }
    const result = existing?.result ?? client.suggestions(pendingCvr, controller.signal)
    result
      .then((result) => {
        if (!controller.signal.aborted) apply(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) apply(null)
      })
    const expiry = setTimeout(() => apply(null), 10_000)
    return () => {
      clearTimeout(timeout)
      clearTimeout(expiry)
      controller.abort()
    }
  }, [pendingCvr, client])

  async function lookup(company: CvrCompany) {
    discard()
    setSelected(company)
    setScreen("working")
    const run = epoch.current
    if (client.suggestions) {
      const controller = new AbortController()
      suggestionRequest.current = controller
      suggestionPromise.current = {
        cvr: company.cvr,
        controller,
        result: client.suggestions(company.cvr, controller.signal).catch(() => null),
      }
    }
    const controller = new AbortController()
    request.current = controller
    const timer = setTimeout(() => {
      controller.abort()
      suggestionRequest.current?.abort()
      if (epoch.current === run) setScreen("timeout")
    }, 10_000)
    try {
      const facts = await client.get(company.cvr, controller.signal)
      if (controller.signal.aborted || run !== epoch.current) return
      if (!facts) {
        setMatches([])
        setQuery(company.cvr)
        setSearched(true)
        setScreen("search")
      } else if (
        facts.statusClass === "blocked" ||
        ["ceased", "dissolved", "bankrupt"].includes(facts.status)
      ) {
        suggestionRequest.current?.abort()
        setSelected(facts)
        setScreen("ceased")
      } else {
        setDraft(newDraft(facts, signupEmail, Boolean(client.suggestions)))
        setScreen("review")
      }
    } catch {
      if (!controller.signal.aborted && run === epoch.current) setScreen("failed")
    } finally {
      clearTimeout(timer)
    }
  }

  function manual() {
    discard()
    setBankErrors(false)
    setDraft(newDraft(null, signupEmail, false))
    setScreen("review")
  }
  function searchAgain() {
    discard()
    setScreen("search")
  }
  function update<K extends keyof ReviewValues>(field: K, value: ReviewValues[K]) {
    setValidationErrors((current) => (current.includes(field) ? current.filter((name) => name !== field) : current))
    setDraft((current) =>
      current
        ? {
            ...current,
            ...(field === "momsRegistered" ? { vatChoiceConfirmed: value !== null } : {}),
            values: {
              ...current.values,
              [field]: value,
              ...(field === "momsRegistered" ? { taxRate: value ? 25 : 0 } : {}),
            },
          }
        : current,
    )
  }
  async function confirm(event: React.FormEvent) {
    event.preventDefault()
    if (!draft || saving.current) return
    const v = draft.values
    // The form opts out of native (English-only) browser validation; required text fields the schema allows empty are checked here.
    const empty: string[] = (["companyName", "companyAddress", "companyForm", "companyEmail"] as const).filter((name) => !v[name].trim())
    // Never a silently disabled button: a missing VAT answer is a visible, focused validation error (QUI-56).
    // Reject before capability guards or the payload's non-null VAT assertion.
    if ((confirmationEnabled && sellerVatChoice === null) || v.momsRegistered === null) {
      reject([...empty, "momsRegistered"])
      return
    }
    if (!nonVatEnabled && v.momsRegistered === false) return
    if (
      (v.bankRegNumber || v.bankAccountNumber) &&
      (!/^\d{4}$/.test(v.bankRegNumber) || !/^\d{1,10}$/.test(v.bankAccountNumber))
    ) {
      setBankErrors(true)
      return
    }
    const validated = (confirmationEnabled ? confirmOnboardingV2WithVatConfirmationSchema : confirmOnboardingV2Schema).safeParse(confirmationPayload(draft))
    if (!validated.success || empty.length) {
      reject([...new Set([...empty, ...(validated.success ? [] : validated.error.issues.map((issue) => String(issue.path.at(-1))))])])
      return
    }
    setValidationErrors([])
    saving.current = true
    setBusy(true)
    setSaveFailed(false)
    suggestionRequest.current?.abort()
    const confirmed =
      draft.suggestionsState === "pending"
        ? { ...draft, suggestionsState: "hidden" as const, suggestions: null }
        : draft
    setDraft(confirmed)
    storeDraft(storageKey, confirmed)
    try {
      await client.confirm(confirmationPayload(confirmed))
      clearDraft(storageKey)
      epoch.current++
      if (mounted.current) onComplete()
    } catch (error) {
      if (!mounted.current) return
      setBusy(false)
      saving.current = false
      // A rejected CVR or email is the user's to fix: point at the field instead of a generic save failure.
      // The router answers with a plain key ("cvr.invalid"); a local schema failure carries a JSON issue list.
      const message = error instanceof Error ? error.message : ""
      const issues = message === "cvr.invalid" ? [{ field: "cvr" }] : message === "email.invalid" ? [{ field: "email" }] : readableIssues(error) ?? []
      const fields = [...new Set(issues.flatMap((issue) => issue.field === "cvr" ? ["cvr"] : issue.field === "email" ? ["companyEmail"] : []))]
      if (fields.length) reject(fields)
      else setSaveFailed(true)
    }
  }
  function remove(group: "customers" | "lines", id: string) {
    setDraft((current) =>
      current?.suggestions
        ? {
            ...current,
            suggestions: {
              ...current.suggestions,
              [group]: current.suggestions[group].filter((row) => row.id !== id),
            },
          }
        : current,
    )
  }

  const step =
    screen === "review"
      ? 3
      : screen === "working" || screen === "ceased" || screen === "failed" || screen === "timeout"
        ? 2
        : 1
  const factsTag = TT(draft?.source === "manual" ? "defaultTag" : "cvrTag")
  /** The localized message under an invalid review field, so an error is visible next to the field and not only in the banner. */
  function fieldError(name: keyof ReviewValues) {
    if (!validationErrors.includes(name)) return null
    const value = String(draft!.values[name] ?? "").trim()
    const message: TranslationKey =
      name === "cvr" ? (value ? "validation.cvr.invalid" : "validation.required")
      : name === "companyEmail" ? (value ? "validation.email.invalid" : "validation.email.required")
      : value ? "validation.unknown" : "validation.required"
    return <span id={`ob-${name}-error`} className="ob-error" role="alert">{t(message)}</span>
  }
  function field(
    name: keyof ReviewValues,
    suffix: string,
    tag: string,
    options: {
      type?: string
      required?: boolean
      maxLength?: number
      pattern?: string
      min?: number
      max?: number
    } = {},
  ) {
    const value = draft!.values[name]
    return (
      <SourceField label={TT(suffix)} tag={tag}>
        <Input
          aria-label={TT(suffix)}
          name={name}
          value={String(value)}
          {...options}
          disabled={busy || (name === "taxRate" && !draft!.values.momsRegistered)}
          aria-invalid={validationErrors.includes(name)}
          aria-describedby={validationErrors.includes(name) ? `ob-${name}-error` : undefined}
          onChange={(event) =>
            update(
              name,
              (typeof value === "number"
                ? Number(event.target.value)
                : event.target.value) as never,
            )
          }
        />
        {fieldError(name)}
      </SourceField>
    )
  }
  const statusPhrase =
    selected && selected.status !== "active" ? TT(`statusPhrase.${selected.status}`) : ""
  return (
    <main className="ob-shell">
      <div className="ob-brand">
        Quits
        <span className="ob-square" aria-hidden="true" />
      </div>
      <nav aria-label={TT("step", { x: step })} className="ob-steps">
        <span className="ob-mobile-step">{TT("step", { x: step })}</span>
        <ol>
          {["company", "lookup", "review"].map((label, index) => (
            <li key={label} aria-current={index + 1 === step ? "step" : undefined}>
              <span
                className={`ob-marker ${index + 1 <= step ? "ob-current" : ""}`}
                aria-hidden="true"
              >
                {index + 1 < step ? <Check size={12} /> : index + 1}
              </span>
              {TT(label)}
            </li>
          ))}
        </ol>
      </nav>
      {screen === "search" ? (
        <section className="ob-search">
          <h1>{TT("search.heading")}</h1>
          <p>{TT("search.sub")}</p>
          <label className="ob-search-input">
            <Search size={20} aria-hidden="true" />
            <Input
              aria-label={TT("search.heading")}
              aria-invalid={invalid}
              aria-describedby={invalid ? "cvr-error" : "cvr-source"}
              placeholder={TT("search.placeholder")}
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {invalid ? (
            <p id="cvr-error" className="ob-error" role="alert">
              {TT("search.invalid")}
            </p>
          ) : null}
          {searching ? <p role="status">{TT("search.loading")}</p> : null}
          {searched && matches.length === 0 ? (
            <StateNotice>
              {TT(/^\d{8}$/.test(query.trim()) ? "search.notFound" : "search.noMatches", {
                cvr: query.trim(),
                query: query.trim(),
              })}
            </StateNotice>
          ) : null}
          {matches.length > 1 ? (
            <p role="status">{TT("search.several", { n: matches.length, query: query.trim() })}</p>
          ) : null}
          <div className="ob-matches">
            {matches.map((company) => (
              <button
                key={company.cvr}
                className="ob-match"
                type="button"
                onClick={() => void lookup(company)}
              >
                <strong>{company.name}</strong>
                <span className="ob-match-meta">
                  {company.cvr} · {company.address}
                </span>
                <span className="ob-tag">{TT(`status.${company.status}`)}</span>
                <span className="ob-continue">
                  {TT("search.continue", { company: company.name })}
                </span>
              </button>
            ))}
          </div>
          <Button variant="link" onClick={manual}>
            {TT("search.manual")}
          </Button>
          <p id="cvr-source" className="ob-source">
            {TT("search.source")}
          </p>
        </section>
      ) : null}
      {screen === "working" ? (
        <section className="ob-working">
          <h1>{TT("working.heading", { company: selected?.name ?? "" })}</h1>
          <p>{TT("working.sub")}</p>
          <ul className="ob-tasks">
            {["facts", "address", "vat", "defaults"].map((task, i) => (
              <li key={task}>
                <span className="ob-marker" aria-hidden="true">
                  {i < 3 ? <LoaderCircle size={14} className="ob-spin" /> : null}
                </span>
                {TT(`working.${task}`)}
                <span>{TT(i < 3 ? "working.fetching" : "working.waiting")}</span>
              </li>
            ))}
          </ul>
          {client.suggestions ? <p>{TT("suggestions.loading")}</p> : null}
          <p className="ob-source">{TT("working.honesty")}</p>
          <Button variant="outline" onClick={searchAgain}>
            {TT("cancel")}
          </Button>
        </section>
      ) : null}
      {screen === "failed" || screen === "timeout" || screen === "ceased" ? (
        <section className="ob-state">
          <StateNotice
            danger
            title={
              screen === "ceased"
                ? TT("ceased.title", { company: selected?.name ?? "", status: statusPhrase })
                : TT(`${screen}.title`)
            }
          >
            <p>
              {screen === "ceased"
                ? TT("ceased.body", {
                    status: selected ? TT(`statusBody.${selected.status}`) : "",
                    date: selected?.statusDate
                      ? new Date(selected.statusDate)
                          .toLocaleDateString("da-DK", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                          })
                          .replaceAll(".", "-")
                      : TT("unknownDate"),
                  })
                : TT(`${screen}.body`)}
            </p>
          </StateNotice>
          <div className="ob-actions">
            <Button onClick={manual}>{TT("manual")}</Button>
            <Button
              variant="outline"
              onClick={() => (selected ? void lookup(selected) : searchAgain())}
            >
              {TT(screen === "ceased" ? "checkAgain" : "retry")}
            </Button>
            {screen === "ceased" ? (
              <Button variant="link" onClick={searchAgain}>
                {TT("searchAgain")}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {screen === "review" && draft ? (
        <form ref={reviewForm} noValidate onSubmit={(event) => void confirm(event)} className="ob-review">
          <h1>{TT(draft.source === "manual" ? "manual.heading" : "review.heading")}</h1>
          <p>{TT(draft.source === "manual" ? "manual.sub" : "review.sub")}</p>
          {restored ? (
            <p className="ob-notice" role="status">
              {TT("restored")}
            </p>
          ) : null}
          {validationErrors.length ? <StateNotice danger>{TT("validation")}</StateNotice> : null}
          {saveFailed ? (
            <StateNotice danger title={TT("saveFailed.title")}>
              <p>{TT("saveFailed.body")}</p>
              <Button type="submit" variant="outline">
                {TT("retry")}
              </Button>
            </StateNotice>
          ) : null}
          {draft.company?.statusClass === "warn" ? (
            <StateNotice>
              {TT("warning", { status: TT(`statusPhrase.${draft.company.status}`) })}
            </StateNotice>
          ) : null}
          {/* Only a registry fact of "not registered" may claim CVR said so; a user answer to an unknown status may not. */}
          {draft.values.momsRegistered === false && draft.source === "cvr" && draft.company?.momsRegistered === false ? (
            <StateNotice>{TT("noVat.notice")}</StateNotice>
          ) : null}
          <p className="ob-edit">{TT("review.edit")}</p>
          <SummaryCard title={TT("company")} tag={factsTag}>
            {field("companyName", "field.name", factsTag, { required: true, maxLength: 120 })}
            {field("cvr", "field.cvr", factsTag, {
              required: confirmationEnabled || draft.source === "cvr",
              maxLength: 8,
              pattern: "[0-9]{8}",
            })}
            <SourceField label={TT("field.address")} tag={factsTag}>
              <textarea
                aria-label={TT("field.address")}
                aria-invalid={validationErrors.includes("companyAddress") || undefined}
                aria-describedby={validationErrors.includes("companyAddress") ? "ob-companyAddress-error" : undefined}
                name="companyAddress"
                required
                maxLength={240}
                value={draft.values.companyAddress}
                disabled={busy}
                onChange={(event) => update("companyAddress", event.target.value)}
              />
              {fieldError("companyAddress")}
            </SourceField>
            {field("companyForm", "field.form", factsTag, { required: true, maxLength: 80 })}
            {draft.company?.industry ? (
              <SourceField label={TT("field.industry")} tag={factsTag}>
                <span>{draft.company.industry}</span>
              </SourceField>
            ) : null}
            {draft.company ? (
              <SourceField label={TT("field.status")} tag={factsTag}>
                <span>{TT(`status.${draft.company.status}`)}</span>
              </SourceField>
            ) : null}
            {field(
              "companyEmail",
              "field.email",
              draft.company?.email && !draft.company.advertisingProtected
                ? factsTag
                : TT("defaultTag"),
              { type: "email", required: true },
            )}
            {field("companyPhone", "field.phone", factsTag)}
          </SummaryCard>
          <SummaryCard title={TT("vatCurrency")}>
            <SourceField label={TT("field.country")} tag={factsTag}>
              <select
                aria-label={TT("field.country")}
                value={draft.values.countryCode}
                disabled={busy}
                onChange={(e) => update("countryCode", e.target.value)}
              >
                <option value="DK">{TT("denmark")}</option>
              </select>
            </SourceField>
            {confirmationEnabled ? <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">{t("sellerCard.body")}</p>
              {/* Not natively required: confirm() shows, focuses and explains a missing answer (QUI-56). */}
              <SellerVatStatus nonVatEnabled={nonVatEnabled} value={sellerVatChoice} invalid={validationErrors.includes("momsRegistered")} disabled={busy} onChange={value => update("momsRegistered", value)} />
              {validationErrors.includes("momsRegistered") ? <p className="ob-error" role="alert">{t("validation.required")}</p> : null}
            </div> : (
            <SourceField label={TT("field.vat")} tag={factsTag}>
              <select
                aria-label={TT("field.vat")}
                name="momsRegistered"
                aria-invalid={validationErrors.includes("momsRegistered")}
                aria-describedby={validationErrors.includes("momsRegistered") ? "ob-momsRegistered-error" : undefined}
                value={draft.values.momsRegistered === null ? "" : String(draft.values.momsRegistered)}
                aria-required
                disabled={busy}
                onChange={(e) => update("momsRegistered", e.target.value === "" ? null : e.target.value === "true")}
              >
                {draft.values.momsRegistered === null && <option value="" disabled>{TT("vatUnknown")}</option>}
                <option value="true">{TT("yes")}</option>
                {nonVatEnabled && <option value="false">{TT("no")}</option>}
              </select>
              {validationErrors.includes("momsRegistered") ? <p id="ob-momsRegistered-error" className="ob-error" role="alert">{t("validation.required")}</p> : null}
            </SourceField>
            )}
            {field("taxRate", "field.rate", TT("defaultTag"), {
              type: "number",
              min: 0,
              max: 100,
              required: true,
            })}
            <SourceField label={TT("field.currency")} tag={TT("defaultTag")}>
              <select
                aria-label={TT("field.currency")}
                value={draft.values.defaultCurrency}
                disabled={busy}
                onChange={(e) => update("defaultCurrency", e.target.value)}
              >
                {(["DKK", "EUR", "USD", "GBP"] as const).map((currency) => (
                  <option key={currency} value={currency}>
                    {t(`auth.onboarding.currency.${currency}`)}
                  </option>
                ))}
              </select>
            </SourceField>
            <SourceField label={TT("field.locale")} tag={TT("defaultTag")}>
              <select
                aria-label={TT("field.locale")}
                value={draft.values.locale}
                disabled={busy}
                onChange={(e) => update("locale", e.target.value)}
              >
                <option value="da-DK">{t("auth.onboarding.locale.da")}</option>
                <option value="en-GB">{t("auth.onboarding.locale.en")}</option>
              </select>
            </SourceField>
            {field("timezone", "field.timezone", TT("defaultTag"), { required: true })}
            <SourceField label={TT("field.prices")} tag={TT("defaultTag")}>
              <select
                aria-label={TT("field.prices")}
                value={String(draft.values.pricesIncludeTax)}
                disabled={busy}
                onChange={(e) => update("pricesIncludeTax", e.target.value === "true")}
              >
                <option value="false">{TT("no")}</option>
                <option value="true">{TT("yes")}</option>
              </select>
            </SourceField>
          </SummaryCard>
          <SummaryCard title={TT("invoices")} tag={TT("defaultTag")}>
            {field("invoicePrefix", "field.prefix", TT("defaultTag"), {
              required: true,
              maxLength: 10,
              pattern: "[A-Z0-9\\-]{1,10}",
            })}
            {field("invoiceNextNum", "field.next", TT("defaultTag"), {
              type: "number",
              min: 1,
              max: 2147483647,
              required: true,
            })}
            <output className="ob-number">
              {draft.values.invoicePrefix}-{String(draft.values.invoiceNextNum).padStart(4, "0")}
            </output>
            {field("paymentTermsDays", "field.terms", TT("defaultTag"), {
              type: "number",
              min: 0,
              max: 365,
              required: true,
            })}
          </SummaryCard>
          {draft.source === "cvr" && client.suggestions ? (
            <div className="ob-suggestion-slot" data-testid="suggestion-slot">
              {draft.suggestionsState === "pending" ? (
                <SummaryCard title={TT("suggestions.title")} className="ob-suggestions">
                  <p role="status">
                    <LoaderCircle size={16} className="ob-spin" />
                    {TT("suggestions.loading")}
                  </p>
                </SummaryCard>
              ) : draft.suggestionsState === "ready" && draft.suggestions ? (
                <SummaryCard
                  title={TT("suggestions.title")}
                  tag={TT("suggestions.tag")}
                  className="ob-suggestions"
                >
                  <p>{TT("suggestions.sub")}</p>
                  <div className="ob-suggestion-content">
                    <h3>{TT("suggestions.customers")}</h3>
                    {draft.suggestions.customers.map((row) => (
                      <div className="ob-suggestion-row" key={row.id}>
                        <span>{row.label}</span>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${TT("remove")} ${row.label}`}
                          onClick={() => remove("customers", row.id)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                    <h3>{TT("suggestions.lines")}</h3>
                    {draft.suggestions.lines.map((row) => (
                      <div className="ob-suggestion-row" key={row.id}>
                        <span>
                          {row.description} ·{" "}
                          {new Intl.NumberFormat(locale, {
                            style: "currency",
                            currency: draft.values.defaultCurrency,
                          }).format(row.unitPrice)}{" "}
                          {TT(row.unit)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${TT("remove")} ${row.description}`}
                          onClick={() => remove("lines", row.id)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    disabled={busy}
                    onClick={() =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              suggestions: { customers: [], lines: [] },
                              suggestionsState: "hidden",
                            }
                          : null,
                      )
                    }
                  >
                    {TT("removeAll")}
                  </Button>
                </SummaryCard>
              ) : null}
            </div>
          ) : null}
          <SummaryCard
            title={TT("bank")}
            tag={
              !draft.values.bankRegNumber || !draft.values.bankAccountNumber
                ? TT("missingTag")
                : undefined
            }
          >
            <h3>{TT("bank.heading")}</h3>
            <p>{TT("bank.sub")}</p>
            <div className="ob-bank-fields">
              <label>
                {TT("bank.reg")}
                <Input
                  aria-label={TT("bank.reg")}
                  inputMode="numeric"
                  maxLength={4}
                  value={draft.values.bankRegNumber}
                  aria-invalid={bankErrors && !/^\d{4}$/.test(draft.values.bankRegNumber)}
                  disabled={busy}
                  onChange={(e) => update("bankRegNumber", e.target.value)}
                />
                {bankErrors && !/^\d{4}$/.test(draft.values.bankRegNumber) ? (
                  <span className="ob-error" role="alert">
                    {TT("bank.regError")}
                  </span>
                ) : null}
              </label>
              <label>
                {TT("bank.account")}
                <Input
                  aria-label={TT("bank.account")}
                  inputMode="numeric"
                  maxLength={10}
                  value={draft.values.bankAccountNumber}
                  aria-invalid={bankErrors && !/^\d{1,10}$/.test(draft.values.bankAccountNumber)}
                  disabled={busy}
                  onChange={(e) => update("bankAccountNumber", e.target.value)}
                />
                {bankErrors && !/^\d{1,10}$/.test(draft.values.bankAccountNumber) ? (
                  <span className="ob-error" role="alert">
                    {TT("bank.accountError")}
                  </span>
                ) : null}
              </label>
            </div>
            <p className="ob-source">{TT("bank.hint")}</p>
            <Button
              type="button"
              variant="link"
              disabled={busy}
              onClick={() => {
                update("bankRegNumber", "")
                update("bankAccountNumber", "")
                setBankErrors(false)
              }}
            >
              {TT("bank.skip")}
            </Button>
            <p className="ob-source">{TT("bank.skipNote")}</p>
          </SummaryCard>
          <aside className="ob-unsaved">
            <h2>{TT("unsaved.title")}</h2>
            <p>{TT("unsaved.body")}</p>
          </aside>
          <div className="ob-confirm">
            <span>{TT("unsaved.hint")}</span>
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle size={16} className="ob-spin" aria-hidden="true" /> : null}
              {TT(busy ? "busy" : draft.source === "manual" ? "manual.confirm" : "confirm")}
            </Button>
          </div>
          <Button variant="link" type="button" disabled={busy} onClick={searchAgain}>
            {TT(draft.source === "manual" ? "manual.search" : "cancel")}
          </Button>
        </form>
      ) : null}
    </main>
  )
}
