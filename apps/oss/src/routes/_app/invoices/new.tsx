import { PriceBasisToggle } from "../../../components/invoices/price-basis-toggle"
import { InvoiceLinesEditor } from "../../../components/invoices/lines-editor"
import { invoiceQuantityInput, normalizeInvoiceQuantity } from "../../../lib/invoice-quantity"
import { defaultDocumentTaxRate, reconcilePolicyVat } from "../../../lib/invoice-defaults"
import { TaxRateInput } from "../../../components/invoices/tax-rate-input"
import { useFirstInvoiceBankNudge } from "../../../components/onboarding-v2/bank-nudge"
import { useInvoiceDueDate } from "../../../hooks/use-invoice-due-date"
import { IssuanceFields, initialIssuanceValues, issuanceInput } from "../../../components/invoices/issuance-fields"
import { previewDraft } from "@quits/shared/pricing"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { DraftVatEvidence } from "@quits/contracts/vat"
import { DocumentVatFields, VatGroupPreview } from "../../../components/document-vat-fields"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import type { RuntimeCapabilities } from "@quits/contracts/runtime"
import { useState, useEffect, useRef } from "react"
import { trpc } from "../../../trpc/client"
import { retainDraftValuation, clearDraftValuation } from "../../../lib/invoice-issuance-draft"
import { createThenSend } from "../../../lib/create-and-send"
import { applyCatalogItemToLineItem, type CatalogItemOption } from "../../../lib/catalog"
import { formatCurrency as formatCurrencyIntl } from "../../../lib/i18n/format"
import { useOrgCurrency } from "../../../hooks/use-org-currency"
import { LocalizedDateField } from "../../../components/localized-date-field"
import { Button } from "../../../components/ui/button"
import { Label } from "../../../components/ui/label"
import { Textarea } from "../../../components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card"
import { Sparkles } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"
import { aiDraftErrorMessageKey } from "../../../lib/ai-draft-error"
import { visibleFieldError, type FieldError } from "../../../lib/validation/field-error"

export const Route = createFileRoute("/_app/invoices/new")({
  component: NewInvoicePage,
})

type Contact = { id: string; name: string; email?: string | null }

type LineItem = {
  description: string
  quantity: string
  unitPrice: string
  vat?: DocumentLineInput["vat"]
  catalogItemId?: string
}

function NewInvoicePage() {
  const { t, locale } = useI18n()
  const bankNudge = useFirstInvoiceBankNudge()
  const currency = useOrgCurrency()
  const [issuance, setIssuance] = useState(initialIssuanceValues)
  const [baseCurrency, setBaseCurrency] = useState<string>()
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false)
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof trpc.invoices.sendReadiness.query>> | null>(null)
  const submitPending = useRef(false)
  const priceBasisEdited = useRef(false)
  const taxRateEdited = useRef(false)
  const [vatEvidence, setVatEvidence] = useState<DraftVatEvidence>({})
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactId, setContactId] = useState("")
  const [dueDate, setDueDate] = useInvoiceDueDate()
  const [notes, setNotes] = useState("")
  const [taxRate, setTaxRate] = useState("25")
  const [items, setItems] = useState<LineItem[]>([
    { description: "", quantity: "1", unitPrice: "0", catalogItemId: undefined },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<FieldError<"contact" | "dueDate" | "items"> | null>(null)
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [catalogItems, setCatalogItems] = useState<CatalogItemOption[]>([])
  const [aiCapabilities, setAiCapabilities] = useState<
    Pick<RuntimeCapabilities, "aiInvoiceDraft"> | null
  >(null)
  const [loadingAiCapabilities, setLoadingAiCapabilities] = useState(true)
  const [aiPrompt, setAiPrompt] = useState("")
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiInfo, setAiInfo] = useState<string | null>(null)
  const aiInvoiceDraft = aiCapabilities?.aiInvoiceDraft
  const aiDraftAvailable = Boolean(
    aiInvoiceDraft?.enabled &&
      (aiInvoiceDraft.byok || aiInvoiceDraft.localAgent || aiInvoiceDraft.managed)
  )

  useEffect(() => {
    trpc.contacts.list
      .query()
      .then((data) => setContacts(data as Contact[]))
      .catch(() => {})
      .finally(() => setLoadingContacts(false))
  }, [])

  useEffect(() => {
    trpc.catalog.list
      .query()
      .then((data) => setCatalogItems(data as CatalogItemOption[]))
      .catch(() => {})

  }, [])

  useEffect(() => {
    trpc.runtime.capabilities
      .query()
      .then((data) =>
        setAiCapabilities(data as Pick<RuntimeCapabilities, "aiInvoiceDraft">)
      )
      .catch(() => {})
      .finally(() => setLoadingAiCapabilities(false))
  }, [])

  function addItem() {
    setItems((prev) => [
      ...prev,
      { description: "", quantity: "1", unitPrice: "0", catalogItemId: undefined },
    ])
  }

  function removeItem(index: number) {
    if (items.length <= 1) return
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function applyCatalogItem(index: number, catalogItemId: string) {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        return applyCatalogItemToLineItem(item, catalogItemId, catalogItems)
      })
    )
  }

  useEffect(() => {
    let cancelled = false
    trpc.invoices.sendReadiness.query({ contactId: contactId || undefined, currency }).then(state => {
      if (cancelled) return
      setReadiness(state)
      setBaseCurrency(state.baseCurrency)
      // A policy-fixed rate always wins, also over an earlier edit or an accepted AI rate; otherwise the default
      // applies until the user edits it.
      if (state.standardVatRate != null) {
        setTaxRate(defaultDocumentTaxRate(state))
        setItems(lines => reconcilePolicyVat(lines, state))
      } else if (!taxRateEdited.current) setTaxRate(defaultDocumentTaxRate(state))
      if (!priceBasisEdited.current) setPricesIncludeTax(state.standardVatRate != null ? false : state.pricesIncludeTax)
    }).catch(() => { if (!cancelled) setError(t("invoiceValidation.unknown")) })
    return () => { cancelled = true }
  }, [contactId, currency, t])

  const invalidFields = new Set<"contact" | "dueDate" | "items">()
  if (!contactId) invalidFields.add("contact")
  if (!dueDate) invalidFields.add("dueDate")
  if (items.some((item) => !item.description.trim())) invalidFields.add("items")
  const shownError = visibleFieldError(fieldError, invalidFields) ?? error

  // An adopter policy fixes the rate and treatment; without one the full classification editor applies.
  const restrictedVat = !!readiness?.standardVatRate
  const preview = previewDraft({ items: items.map(item => normalizeInvoiceQuantity(item, locale)), taxRate: taxRate || "0", pricesIncludeTax, currency })
  const subtotal = Number(preview.result?.net ?? "0")
  const taxAmount = Number(preview.result?.tax ?? "0")
  const total = Number(preview.result?.gross ?? "0")

  async function handleGenerateInvoiceDraftFromAi() {
    setAiError(null)
    setAiInfo(null)

    const prompt = aiPrompt.trim()
    if (!prompt) {
      setAiError(t("invoices.new.ai.error.promptRequired"))
      return
    }

    setAiGenerating(true)
    try {
      const result = await trpc.ai.generateInvoiceDraft.mutate({
        prompt,
        // Use the organisation's own provider when the distribution allows one; otherwise the
        // distribution's managed provider.
        mode: aiInvoiceDraft?.byok || aiInvoiceDraft?.localAgent ? "byok" : "managed",
      })
      const draft = result.draft
      // The prompt described nothing that was sold; the model says why, in the user's language.
      if (draft.items.length === 0) {
        setAiError(draft.reason ?? t("invoices.new.ai.error.notAnInvoice"))
        return
      }

      if (draft.dueDate) {
        setDueDate(draft.dueDate)
      }
      if (draft.notes) {
        setNotes(draft.notes)
      }
      // A policy-fixed rate stays; a model-supplied rate only applies where the user can see and correct it.
      if (typeof draft.taxRate === "number" && !readiness?.standardVatRate) {
        taxRateEdited.current = true
        setTaxRate(String(draft.taxRate))
      }
      if (draft.items.length > 0) {
        setItems(
          draft.items.map((item) => ({
            ...applyCatalogItemToLineItem(
              {
                description: item.description ?? "",
                quantity: String(item.quantity),
                unitPrice: String(item.unitPrice),
                catalogItemId: undefined,
              },
              item.catalogItemId || "",
              catalogItems
            ),
            description: item.description ?? "",
            quantity: String(item.quantity),
            unitPrice: String(item.unitPrice),
            catalogItemId: item.catalogItemId,
          }))
        )
      }

      if (draft.contactId && contacts.some((contact) => contact.id === draft.contactId)) {
        setContactId(draft.contactId)
      } else if (draft.contactName) {
        const matchedContact = contacts.find(
          (contact) => contact.name.trim().toLowerCase() === draft.contactName?.trim().toLowerCase()
        )
        if (matchedContact) {
          setContactId(matchedContact.id)
        } else {
          setAiInfo(
            t("invoices.new.ai.info.contactNotMatched", {
              name: draft.contactName,
            })
          )
        }
      }
    } catch (err) {
      const messageKey = aiDraftErrorMessageKey(err)
      setAiError(
        messageKey
          ? t(messageKey)
          : err instanceof Error
            ? err.message
            : t("invoices.new.ai.error.generateFailed")
      )
    } finally {
      setAiGenerating(false)
    }
  }

  async function handleSubmit(sendImmediately: boolean) {
    if (submitPending.current) return
    setError(null)
    setFieldError(null)

    // The VAT rate and price basis are placeholders until the organisation's configuration has loaded.
    if (!readiness) return
    if (!contactId) {
      setFieldError({ field: "contact", message: t("docForm.validation.contactRequired") })
      return
    }
    if (!dueDate) {
      setFieldError({ field: "dueDate", message: t("invoices.new.validation.dueDateRequired") })
      return
    }
    if (items.some((item) => !item.description.trim())) {
      setFieldError({ field: "items", message: t("docForm.validation.itemDescriptionRequired") })
      return
    }

    if (items.some((item) => !invoiceQuantityInput(locale).safeParse(item.quantity).success)) {
      setError(t("docForm.validation.quantityInvalid"))
      return
    }

    submitPending.current = true
    setSaving(true)
    try {
      let settingsRequested = false
      // The draft exists once created: whatever happens to the send, show it rather than keep
      // the form, where submitting again would create a second invoice.
      const target = await createThenSend({
        create: async () => {
          const draft = await trpc.invoices.createV2.mutate({
            contactId,
            dueDate,
            supplyDate: issuance.supplyDate,
            taxRate,
            pricesIncludeTax,
            vatEvidence,
            notes: notes || undefined,
            items: items.map(item => normalizeInvoiceQuantity(item, locale)).map((item) => ({
              description: item.description,
              quantity: String(item.quantity),
              unitPrice: String(item.unitPrice),
              vat: item.vat,
            })),
          })
          retainDraftValuation(draft.id, currency, baseCurrency, issuance)
          return draft
        },
        beforeSend: async () => {
          return bankNudge.beforeSend(() => { settingsRequested = true })
        },
        send: async (id) => {
          const result = await trpc.invoices.send.mutate({ id, ...issuanceInput(issuance, currency, baseCurrency) })
          clearDraftValuation(id, currency, baseCurrency)
          return result
        },
        sendImmediately,
        sendFailedMessage: t("invoices.detail.error.sendFailed"),
      })

      if (settingsRequested) return
      navigate({
        to: "/invoices/$invoiceId",
        params: { invoiceId: target.id },
        search: { emailWarning: target.emailWarning, sendError: target.sendError },
      })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("invoices.new.error.createFailed")
      )
      submitPending.current = false
      setSaving(false)
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      {bankNudge.dialog}
      <Card>
        <CardHeader>
          <CardTitle>{t("invoices.new.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {shownError && (
            <p className="text-sm text-destructive" role="alert">
              {shownError}
            </p>
          )}

          <div className="grid gap-2">
            <Label htmlFor="aiPrompt">{t("invoices.new.ai.label")}</Label>
            <Textarea
              id="aiPrompt"
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              rows={4}
              placeholder={t("invoices.new.ai.placeholder")}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleGenerateInvoiceDraftFromAi}
                disabled={aiGenerating || loadingAiCapabilities || !aiDraftAvailable}
              >
                <Sparkles className="size-4" />
                {aiGenerating
                  ? t("invoices.new.ai.action.generating")
                  : t("invoices.new.ai.action.generate")}
              </Button>
              {loadingAiCapabilities && (
                <p className="text-xs text-muted-foreground">
                  {t("invoices.new.ai.availability.checking")}
                </p>
              )}
              {!loadingAiCapabilities &&
                !aiDraftAvailable && (
                  <p className="text-xs text-muted-foreground">
                    {t("invoices.new.ai.availability.disabled")}
                  </p>
                )}
            </div>
            {aiError && <p className="text-sm text-destructive">{aiError}</p>}
            {aiInfo && <p className="text-sm text-muted-foreground">{aiInfo}</p>}
          </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 items-start gap-4">
              <div className="grid gap-2">
              <Label htmlFor="invoice-contact">{t("docForm.contact")} *</Label>
              {loadingContacts ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("docForm.loadingContacts")}
                </p>
              ) : contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("docForm.noContacts")}
                </p>
              ) : (
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger id="invoice-contact" className="w-full">
                    <SelectValue placeholder={t("docForm.selectContact")} />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <IssuanceFields value={issuance} onChange={setIssuance} currency={currency} baseCurrency={baseCurrency} showHint={false} />
            <div className="grid gap-2">
              <Label htmlFor="dueDate">{t("invoices.new.field.dueDate")} *</Label>
              <LocalizedDateField
                id="dueDate"
                value={dueDate}
                onChange={setDueDate}
                locale={locale}
                placeholder={t("docForm.selectDate")}
                clearLabel={t("docForm.clear")}
                required
              />
            </div>
          </div>

          <PriceBasisToggle value={pricesIncludeTax} onChange={value => { priceBasisEdited.current = true; setPricesIncludeTax(value) }} />
          <InvoiceLinesEditor items={items} onItemsChange={setItems} catalogItems={catalogItems} onCatalogItem={applyCatalogItem} onAdd={addItem} onRemove={removeItem}
            taxRate={taxRate} standardVatRate={readiness?.standardVatRate} defaultCountry={readiness?.countryCode} momsRegistered={readiness?.momsRegistered} showVat={restrictedVat}
            amounts={items.map((_, index) => preview.result ? formatCurrencyIntl(Number(preview.result.lines[index]?.[pricesIncludeTax ? "gross" : "net"] ?? "0"), currency, locale) : "—")} />

          <DocumentVatFields items={items} onItemsChange={setItems} taxRate={taxRate} evidence={vatEvidence} onEvidenceChange={setVatEvidence} hideClassification={restrictedVat} />
          {!restrictedVat && <VatGroupPreview {...preview} />}
          {/* Summary */}
          <div className="flex justify-end">
            <div className="w-64 grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                <span className="num">{preview.result ? formatCurrencyIntl(subtotal, currency, locale) : "—"}</span>
              </div>
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                {restrictedVat ? <span className="num">{preview.result ? formatCurrencyIntl(taxAmount, currency, locale) : "—"}</span> : <div className="flex items-center gap-1">
                  <TaxRateInput value={taxRate} onChange={value => { taxRateEdited.current = true; setTaxRate(value); setItems(lines => lines.map(line => ({ ...line, vat: undefined }))) }} />
                  <span className="ml-auto num">{preview.result ? formatCurrencyIntl(taxAmount, currency, locale) : "—"}</span>
                </div>}
              </div>
              <div className="flex justify-between font-semibold border-t pt-2">
                <span>{t("docForm.summary.total")}</span>
                <span className="num">{preview.result ? formatCurrencyIntl(total, currency, locale) : "—"}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="grid gap-2">
            <Label htmlFor="notes">{t("docForm.notes")}</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("invoices.new.notes.placeholder")}
              rows={3}
            />
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate({ to: "/invoices" })}
          >
            {t("docForm.action.cancel")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={saving || !readiness}
            onClick={() => handleSubmit(false)}
          >
            {saving
              ? t("docForm.action.saving")
              : t("docForm.action.saveDraft")}
          </Button>
          <Button
            type="button"
            disabled={saving || !readiness}
            onClick={() => handleSubmit(true)}
          >
            {saving
              ? t("docForm.action.saving")
              : t("docForm.action.saveSend")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
