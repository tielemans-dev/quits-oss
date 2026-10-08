import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import {
  BANK_ACCOUNT_FIELDS,
  PAYMENT_NOTE_MAX_LENGTH,
  formatIban,
  paymentDetailsInputSchema,
  type BankAccountField,
  type PaymentDetails,
  type PaymentDetailsInput,
} from "@quits/contracts/payment-details"
import { useActiveOrganizationId } from "../../lib/active-organization"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { buildPaymentDetailsBlock } from "../../lib/payment-details-block"
import { trpc } from "../../trpc/client"
import { Button } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"

/** The form's fields: the bank account's, and the organization-level payment note. */
type PaymentDetailsField = BankAccountField | "note"
const PAYMENT_DETAILS_FIELDS: readonly PaymentDetailsField[] = [...BANK_ACCOUNT_FIELDS, "note"]

type Values = Record<PaymentDetailsField, string>
type FieldError = "invalid" | "required"
type FieldErrors = Partial<Record<PaymentDetailsField, FieldError>>

const EMPTY_VALUES: Values = {
  accountHolder: "",
  bankName: "",
  regNumber: "",
  accountNumber: "",
  iban: "",
  bic: "",
  note: "",
}

/** The invoice number shown in the preview. */
const SAMPLE_INVOICE_NUMBER = "INV-0001"

const ERROR_KEYS: Record<PaymentDetailsField, { invalid: TranslationKey; required?: TranslationKey }> = {
  accountHolder: { invalid: "settings.paymentDetails.error.accountHolder" },
  bankName: { invalid: "settings.paymentDetails.error.bankName" },
  regNumber: {
    invalid: "settings.paymentDetails.error.regNumber",
    required: "settings.paymentDetails.error.regNumber.required",
  },
  accountNumber: {
    invalid: "settings.paymentDetails.error.accountNumber",
    required: "settings.paymentDetails.error.accountNumber.required",
  },
  iban: {
    invalid: "settings.paymentDetails.error.iban",
    required: "settings.paymentDetails.error.iban.required",
  },
  bic: { invalid: "settings.paymentDetails.error.bic" },
  note: { invalid: "settings.paymentDetails.error.note" },
}

function toValues(details: PaymentDetails): Values {
  const account = details.bankAccount
  return {
    accountHolder: account?.accountHolder ?? "",
    bankName: account?.bankName ?? "",
    regNumber: account?.regNumber ?? "",
    accountNumber: account?.accountNumber ?? "",
    iban: account?.iban ? formatIban(account.iban) : "",
    bic: account?.bic ?? "",
    note: details.note ?? "",
  }
}

/** The form as the input the server takes: the account fields grouped under `bankAccount`. */
function toInput(values: Values): PaymentDetailsInput {
  return {
    bankAccount: {
      accountHolder: values.accountHolder,
      bankName: values.bankName,
      regNumber: values.regNumber,
      accountNumber: values.accountNumber,
      iban: values.iban,
      bic: values.bic,
    },
    note: values.note,
  }
}

const isField = (value: unknown): value is PaymentDetailsField =>
  typeof value === "string" && (PAYMENT_DETAILS_FIELDS as readonly string[]).includes(value)

/** Checks the form with the same schema the server enforces. */
function validate(values: Values): FieldErrors {
  const result = paymentDetailsInputSchema.safeParse(toInput(values))
  if (result.success) return {}
  const errors: FieldErrors = {}
  for (const issue of result.error.issues) {
    // Paths are `["bankAccount", field]` for the account and `["note"]` for the note.
    const field = issue.path.at(-1)
    if (!isField(field) || errors[field]) continue
    // A blank field with an error is the one a filled-in partner field asks for.
    errors[field] = values[field].trim() === "" ? "required" : "invalid"
  }
  return errors
}

/** What the invoice would show for the values as typed, even while they are still invalid. */
function previewDetails(values: Values) {
  const text = (value: string) => value.trim() || null
  return {
    bankAccount: {
      accountHolder: text(values.accountHolder),
      bankName: text(values.bankName),
      regNumber: text(values.regNumber.replace(/\s+/g, "")),
      accountNumber: text(values.accountNumber.replace(/\s+/g, "")),
      iban: text(values.iban.replace(/\s+/g, "")),
      bic: text(values.bic.replace(/\s+/g, "").toUpperCase()),
    },
    note: text(values.note),
  }
}

function Field({
  label,
  htmlFor,
  error,
  errorId,
  hint,
  hintId,
  children,
}: {
  label: string
  htmlFor: string
  error?: string
  errorId: string
  hint?: string
  hintId?: string
  children: ReactNode
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function PaymentDetailsPreview({ values, locale }: { values: Values; locale: string | undefined }) {
  const { t } = useI18n()
  const block = buildPaymentDetailsBlock(previewDetails(values), SAMPLE_INVOICE_NUMBER, locale)

  return (
    <div className="grid gap-2">
      <div>
        <p className="text-sm font-medium">{t("settings.paymentDetails.preview.title")}</p>
        <p className="text-xs text-muted-foreground">{t("settings.paymentDetails.preview.help")}</p>
      </div>
      {block ? (
        <div
          className="rounded-md border bg-muted/40 p-3 text-sm"
          aria-label={t("settings.paymentDetails.preview.title")}
          data-testid="payment-details-preview"
        >
          <p className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">{block.title}</p>
          <dl className="grid gap-0.5">
            {block.rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[7rem_1fr] items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
          {block.note && <p className="mt-1.5 whitespace-pre-line text-xs text-muted-foreground">{block.note}</p>}
          <p className="mt-2 border-t pt-2">
            {block.reference.label}: <span className="font-semibold">{block.reference.value}</span>
          </p>
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t("settings.paymentDetails.preview.empty")}
        </p>
      )}
    </div>
  )
}

export function PaymentDetailsCard() {
  const { t, locale } = useI18n()
  const idPrefix = useId()
  const [loaded, setLoaded] = useState(false)
  // Only admins may change the details (settings:update); everyone else sees them read-only.
  const [canUpdate, setCanUpdate] = useState(false)
  const [values, setValues] = useState<Values>(EMPTY_VALUES)
  const [saved, setSaved] = useState<Values>(EMPTY_VALUES)
  const [touched, setTouched] = useState<Partial<Record<PaymentDetailsField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null)
  // The details belong to the active organization; `undefined` while loading. Keyed on it so the
  // card starts over, read-only, after the user switches organization.
  const organizationId = useActiveOrganizationId()
  // Bumped when a save starts and when the organization changes: a save response is applied only
  // while its token is still the latest (see ReminderPolicyCard for why ids alone are not enough).
  const latestRequest = useRef(0)

  useEffect(() => {
    latestRequest.current += 1
    setLoaded(false)
    setCanUpdate(false)
    setSaving(false)
    setMessage(null)
    setTouched({})
    setSubmitted(false)
    if (organizationId === undefined) return
    let cancelled = false
    // Start inside a promise chain so any client failure lands in the error state.
    Promise.resolve()
      .then(() => trpc.paymentDetails.get.query())
      .then((state) => {
        if (cancelled) return
        const next = toValues(state)
        setValues(next)
        setSaved(next)
        setCanUpdate(state.canUpdate)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setMessage({ kind: "error", text: t("settings.paymentDetails.error.load") })
      })
    return () => {
      cancelled = true
    }
  }, [t, organizationId])

  const editable = loaded && canUpdate
  const errors = useMemo(() => validate(values), [values])
  const dirty = PAYMENT_DETAILS_FIELDS.some((field) => values[field] !== saved[field])
  const visibleError = (field: PaymentDetailsField) => {
    const error = errors[field]
    if (!error || !(submitted || touched[field])) return undefined
    const keys = ERROR_KEYS[field]
    return t(error === "required" && keys.required ? keys.required : keys.invalid)
  }

  function setField(field: PaymentDetailsField, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setMessage(null)
  }
  const touch = (field: PaymentDetailsField) => setTouched((current) => ({ ...current, [field]: true }))

  async function handleSave() {
    setSubmitted(true)
    const parsed = paymentDetailsInputSchema.safeParse(toInput(values))
    if (!parsed.success) return
    // A response that arrives after the user switched organization, or after a newer save started,
    // is stale and must not overwrite what is now on screen.
    const token = ++latestRequest.current
    const stillCurrent = () => latestRequest.current === token
    setSaving(true)
    setMessage(null)
    try {
      const state = await trpc.paymentDetails.update.mutate(parsed.data)
      if (!stillCurrent()) return
      const next = toValues(state)
      setValues(next)
      setSaved(next)
      setTouched({})
      setSubmitted(false)
      setMessage({ kind: "success", text: t("settings.paymentDetails.saved") })
    } catch (error) {
      if (!stillCurrent()) return
      setMessage({
        kind: "error",
        text: error instanceof Error && error.message ? error.message : t("settings.paymentDetails.error.save"),
      })
    } finally {
      if (stillCurrent()) setSaving(false)
    }
  }

  const id = (field: PaymentDetailsField) => `${idPrefix}-${field}`
  const errorId = (field: PaymentDetailsField) => `${idPrefix}-${field}-error`
  const describedBy = (field: PaymentDetailsField, hintId?: string) =>
    [visibleError(field) ? errorId(field) : null, hintId ?? null].filter(Boolean).join(" ") || undefined
  const inputProps = (field: PaymentDetailsField, hintId?: string) => ({
    id: id(field),
    value: values[field],
    disabled: !editable,
    "aria-invalid": visibleError(field) ? true : undefined,
    "aria-describedby": describedBy(field, hintId),
    onChange: (event: { target: { value: string } }) => setField(field, event.target.value),
    onBlur: () => touch(field),
  })

  const noteLength = values.note.trim().length
  const noteHintId = `${idPrefix}-note-hint`

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.paymentDetails.title")}</CardTitle>
        <CardDescription>{t("settings.paymentDetails.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium">{t("settings.paymentDetails.group.dk.title")}</legend>
          <p className="-mt-1 text-xs text-muted-foreground">{t("settings.paymentDetails.group.dk.hint")}</p>
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <Field
              label={t("settings.paymentDetails.regNumber.label")}
              htmlFor={id("regNumber")}
              error={visibleError("regNumber")}
              errorId={errorId("regNumber")}
            >
              <Input {...inputProps("regNumber")} inputMode="numeric" autoComplete="off" placeholder="0040" />
            </Field>
            <Field
              label={t("settings.paymentDetails.accountNumber.label")}
              htmlFor={id("accountNumber")}
              error={visibleError("accountNumber")}
              errorId={errorId("accountNumber")}
            >
              <Input
                {...inputProps("accountNumber")}
                inputMode="numeric"
                autoComplete="off"
                placeholder="0440116243"
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium">{t("settings.paymentDetails.group.intl.title")}</legend>
          <p className="-mt-1 text-xs text-muted-foreground">{t("settings.paymentDetails.group.intl.hint")}</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <Field
              label={t("settings.paymentDetails.iban.label")}
              htmlFor={id("iban")}
              error={visibleError("iban")}
              errorId={errorId("iban")}
            >
              <Input
                {...inputProps("iban")}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="DK50 0040 0440 1162 43"
              />
            </Field>
            <Field
              label={t("settings.paymentDetails.bic.label")}
              htmlFor={id("bic")}
              error={visibleError("bic")}
              errorId={errorId("bic")}
            >
              <Input
                {...inputProps("bic")}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="DABADKKK"
              />
            </Field>
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("settings.paymentDetails.accountHolder.label")}
            htmlFor={id("accountHolder")}
            error={visibleError("accountHolder")}
            errorId={errorId("accountHolder")}
          >
            <Input {...inputProps("accountHolder")} autoComplete="off" />
          </Field>
          <Field
            label={t("settings.paymentDetails.bankName.label")}
            htmlFor={id("bankName")}
            error={visibleError("bankName")}
            errorId={errorId("bankName")}
          >
            <Input {...inputProps("bankName")} autoComplete="off" />
          </Field>
        </div>

        <Field
          label={t("settings.paymentDetails.note.label")}
          htmlFor={id("note")}
          error={visibleError("note")}
          errorId={errorId("note")}
          hint={t("settings.paymentDetails.note.help", { count: noteLength, max: PAYMENT_NOTE_MAX_LENGTH })}
          hintId={noteHintId}
        >
          <Textarea
            {...inputProps("note", noteHintId)}
            rows={3}
            placeholder={t("settings.paymentDetails.note.placeholder")}
          />
        </Field>

        <PaymentDetailsPreview values={values} locale={locale} />

        {message && (
          <p
            className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        )}

        {loaded && !canUpdate && (
          <p className="text-sm text-muted-foreground">{t("settings.paymentDetails.readOnly")}</p>
        )}
        {editable && (
          <div>
            <Button type="button" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? t("settings.paymentDetails.saving") : t("settings.paymentDetails.save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
