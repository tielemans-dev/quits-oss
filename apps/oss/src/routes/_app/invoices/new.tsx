import { IssuanceFields, initialIssuanceValues, issuanceInput } from "../../../components/invoices/issuance-fields"
import { previewDraft } from "@quits/shared/pricing"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { DraftVatEvidence } from "@quits/contracts/vat"
import { DocumentVatFields, VatGroupPreview } from "../../../components/document-vat-fields"
import { useOrgPricingSettings } from "../../../hooks/use-org-pricing-settings"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import type { RuntimeCapabilities } from "@quits/contracts/runtime"
import { useState, useEffect } from "react"
import { trpc } from "../../../trpc/client"
import { createThenSend } from "../../../lib/create-and-send"
import { applyCatalogItemToLineItem, type CatalogItemOption } from "../../../lib/catalog"
import { formatCurrency as formatCurrencyIntl } from "../../../lib/i18n/format"
import { useOrgCurrency } from "../../../hooks/use-org-currency"
import { LocalizedDateField } from "../../../components/localized-date-field"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
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
import { Plus, Sparkles, Trash2 } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"

export const Route = createFileRoute("/_app/invoices/new")({
  component: NewInvoicePage,
})

type Contact = { id: string; name: string }

type LineItem = {
  description: string
  quantity: string
  unitPrice: string
  vat?: DocumentLineInput["vat"]
  catalogItemId?: string
}

function NewInvoicePage() {
  const { t, locale } = useI18n()
  const currency = useOrgCurrency()
  const [issuance, setIssuance] = useState(initialIssuanceValues)
  const [baseCurrency, setBaseCurrency] = useState<string>()
  useEffect(() => { trpc.settings.get.query().then(settings => setBaseCurrency(settings.baseCurrency)).catch(() => {}) }, [])
  const { pricesIncludeTax } = useOrgPricingSettings()
  const [vatEvidence, setVatEvidence] = useState<DraftVatEvidence>({})
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactId, setContactId] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [notes, setNotes] = useState("")
  const [taxRate, setTaxRate] = useState("0")
  const [items, setItems] = useState<LineItem[]>([
    { description: "", quantity: "1", unitPrice: "0", catalogItemId: undefined },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingContacts, setLoadingContacts] = useState(true)
  const [loadingCatalog, setLoadingCatalog] = useState(true)
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
      .finally(() => setLoadingCatalog(false))
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

  function updateItem(index: number, field: keyof LineItem, value: string) {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    )
  }

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

  const preview = previewDraft({ items, taxRate: taxRate || "0", pricesIncludeTax, currency })
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

      if (draft.dueDate) {
        setDueDate(draft.dueDate)
      }
      if (draft.notes) {
        setNotes(draft.notes)
      }
      if (typeof draft.taxRate === "number") {
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
      setAiError(
        err instanceof Error
          ? err.message
          : t("invoices.new.ai.error.generateFailed")
      )
    } finally {
      setAiGenerating(false)
    }
  }

  async function handleSubmit(sendImmediately: boolean) {
    setError(null)

    if (!contactId) {
      setError(t("docForm.validation.contactRequired"))
      return
    }
    if (!dueDate) {
      setError(t("invoices.new.validation.dueDateRequired"))
      return
    }
    if (items.some((item) => !item.description.trim())) {
      setError(t("docForm.validation.itemDescriptionRequired"))
      return
    }

    setSaving(true)
    try {
      // The draft exists once created: whatever happens to the send, show it rather than keep
      // the form, where submitting again would create a second invoice.
      const target = await createThenSend({
        create: () =>
          trpc.invoices.createV2.mutate({
            contactId,
            dueDate,
            supplyDate: issuance.supplyDate,
            taxRate,
            vatEvidence,
            notes: notes || undefined,
            items: items.map((item) => ({
              description: item.description,
              quantity: String(item.quantity),
              unitPrice: String(item.unitPrice),
              vat: item.vat,
            })),
          }),
        send: (id) => trpc.invoices.send.mutate({ id, ...issuanceInput(issuance, currency, baseCurrency) }),
        sendImmediately,
        sendFailedMessage: t("invoices.detail.error.sendFailed"),
      })

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
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("invoices.new.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
              <Label>{t("docForm.contact")} *</Label>
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
                  <SelectTrigger className="w-full">
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
            <div className="grid gap-2">
              <IssuanceFields value={issuance} onChange={setIssuance} currency={currency} baseCurrency={baseCurrency} />
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

          {/* Line Items */}
          <div className="grid gap-3">
            <Label>{t("docForm.lineItems")}</Label>
            <div className="rounded-md border">
              <div className="grid grid-cols-[180px_1fr_80px_100px_100px_40px] gap-2 p-3 border-b bg-muted/50 text-sm font-medium">
                <span>{t("docForm.column.item")}</span>
                <span>{t("docForm.column.description")}</span>
                <span>{t("docForm.column.qty")}</span>
                <span>{t("docForm.column.unitPrice")}</span>
                <span>{t("docForm.column.total")}</span>
                <span />
              </div>
              {items.map((item, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[180px_1fr_80px_100px_100px_40px] gap-2 p-3 border-b last:border-0 items-center"
                >
                  <Select
                    value={item.catalogItemId}
                    onValueChange={(value) => applyCatalogItem(index, value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={
                          loadingCatalog
                            ? t("docForm.loadingItems")
                            : catalogItems.length > 0
                              ? t("docForm.selectItem")
                              : t("docForm.noSavedItems")
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {catalogItems.map((catalogItem) => (
                        <SelectItem key={catalogItem.id} value={catalogItem.id}>
                          {catalogItem.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder={t("docForm.column.description")}
                    value={item.description}
                    onChange={(e) => updateItem(index, "description", e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    value={item.quantity || ""}
                    onChange={(e) =>
                      updateItem(index, "quantity", e.target.value)
                    }
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={item.unitPrice || ""}
                    onChange={(e) =>
                      updateItem(index, "unitPrice", e.target.value)
                    }
                  />
                  <span className="num text-sm text-right pr-2">
                    {preview.result ? formatCurrencyIntl(Number(preview.result?.lines[index]?.[pricesIncludeTax ? "gross" : "net"] ?? "0"), currency, locale) : "—"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeItem(index)}
                    disabled={items.length <= 1}
                  >
                    <Trash2 className="size-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addItem} className="w-fit">
              <Plus className="size-4" />
              {t("docForm.action.addItem")}
            </Button>
          </div>

          <DocumentVatFields items={items} onItemsChange={setItems} taxRate={taxRate} evidence={vatEvidence} onEvidenceChange={setVatEvidence} />
          <VatGroupPreview {...preview} />
          {/* Summary */}
          <div className="flex justify-end">
            <div className="w-64 grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("docForm.summary.subtotal")}</span>
                <span className="num">{preview.result ? formatCurrencyIntl(subtotal, currency, locale) : "—"}</span>
              </div>
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">{t("docForm.summary.tax")}</span>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={taxRate || ""}
                    onChange={(e) => { setTaxRate(e.target.value); setItems((lines) => lines.map((line) => ({ ...line, vat: undefined }))) }}
                    className="w-16 h-7 text-xs"
                  />
                  <span className="text-muted-foreground text-xs">%</span>
                  <span className="ml-auto num">{preview.result ? formatCurrencyIntl(taxAmount, currency, locale) : "—"}</span>
                </div>
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
        <CardFooter className="flex justify-end gap-2">
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
            disabled={saving}
            onClick={() => handleSubmit(false)}
          >
            {saving
              ? t("docForm.action.saving")
              : t("docForm.action.saveDraft")}
          </Button>
          <Button
            type="button"
            disabled={saving}
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
