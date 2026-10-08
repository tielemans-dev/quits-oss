import { previewDraft } from "@quits/shared/pricing"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { DraftVatEvidence } from "@quits/contracts/vat"
import { DocumentVatFields, VatGroupPreview } from "../../../components/document-vat-fields"
import { useOrgPricingSettings } from "../../../hooks/use-org-pricing-settings"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
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
import { Plus, Trash2 } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"

export const Route = createFileRoute("/_app/quotes/new")({
  component: NewQuotePage,
})

type Contact = { id: string; name: string }

type LineItem = {
  description: string
  quantity: string
  unitPrice: string
  vat?: DocumentLineInput["vat"]
  catalogItemId?: string
}

function NewQuotePage() {
  const { t, locale } = useI18n()
  const currency = useOrgCurrency()
  const { pricesIncludeTax } = useOrgPricingSettings()
  const [vatEvidence, setVatEvidence] = useState<DraftVatEvidence>({})
  const navigate = useNavigate()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactId, setContactId] = useState("")
  const [expiryDate, setExpiryDate] = useState("")
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

  async function handleSubmit(sendImmediately: boolean) {
    setError(null)

    if (!contactId) {
      setError(t("docForm.validation.contactRequired"))
      return
    }
    if (!expiryDate) {
      setError(t("quotes.new.validation.expiryDateRequired"))
      return
    }
    if (items.some((item) => !item.description.trim())) {
      setError(t("docForm.validation.itemDescriptionRequired"))
      return
    }

    setSaving(true)
    try {
      // The draft exists once created: whatever happens to the send, show it rather than keep
      // the form, where submitting again would create a second quote.
      const target = await createThenSend({
        create: () =>
          trpc.quotes.createV2.mutate({
            contactId,
            expiryDate,
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
        send: (id) => trpc.quotes.send.mutate({ id }),
        sendImmediately,
        sendFailedMessage: t("quotes.detail.error.sendFailed"),
      })

      navigate({
        to: "/quotes/$quoteId",
        params: { quoteId: target.id },
        search: { emailWarning: target.emailWarning, sendError: target.sendError },
      })
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("quotes.new.error.createFailed")
      )
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("quotes.new.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

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
              <Label htmlFor="expiryDate">{t("quotes.new.field.expiryDate")} *</Label>
              <LocalizedDateField
                id="expiryDate"
                value={expiryDate}
                onChange={setExpiryDate}
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
              placeholder={t("quotes.new.notes.placeholder")}
              rows={3}
            />
          </div>
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate({ to: "/quotes" })}
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
