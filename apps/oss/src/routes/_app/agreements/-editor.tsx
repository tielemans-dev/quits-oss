import { useEffect, useMemo, useState, useDeferredValue } from "react"
import { useNavigate } from "@tanstack/react-router"
import { agreementCreateDraftDecimalInputSchema, type DeliverableInput } from "@quits/contracts/agreements"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../../components/ui/card"
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
import { LocalizedDateField } from "../../../components/localized-date-field"
import { useI18n } from "../../../lib/i18n/react"
import { renderAgreementMarkdown } from "../../../lib/agreements/markdown"
import { calculateLegacyDocument, previewDraft } from "@quits/shared/pricing"
import { currencyFractionDigits } from "../../../lib/payments/stripe-amounts"
import { formatCurrency } from "../../../lib/i18n/format"
import { Plus, Trash2 } from "lucide-react"

type Form = {
  contactId: string
  title: string
  summary: string
  termsMarkdown: string
  templateId: string | null
  validUntil: string
  currency: string
  taxRate: string
  dueInDays: number
  billingTrigger: "on_acceptance" | "on_delivery"
  notes: string
  deliverables: EditorDeliverable[]
}
type EditorDeliverable = Omit<DeliverableInput, "quantity" | "unitPrice"> & { quantity: string; unitPrice: string }
const emptyLine = (): EditorDeliverable => ({
  title: "",
  description: "",
  quantity: "1",
  unitPrice: "0",
  agreedDate: null,
  expectedDate: null,
  isDeposit: false,
})
const initial: Form = {
  contactId: "",
  title: "",
  summary: "",
  termsMarkdown: "",
  templateId: null,
  validUntil: "",
  currency: "USD",
  taxRate: "0",
  dueInDays: 30,
  billingTrigger: "on_acceptance",
  notes: "",
  deliverables: [emptyLine()],
}
export function AgreementEditor({ agreementId }: { agreementId?: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [form, setForm] = useState<Form>(initial)
  const [contacts, setContacts] = useState<Awaited<ReturnType<typeof trpc.contacts.list.query>>>([])
  const [templates, setTemplates] = useState<
    Awaited<ReturnType<typeof trpc.agreements.listTemplates.query>>
  >([])
  const [sellerName, setSellerName] = useState("")
  const [offerFormatVersion, setOfferFormatVersion] = useState<number | null>(2)
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.all([
      trpc.contacts.list.query(),
      trpc.agreements.listTemplates.query(),
      trpc.settings.get.query(),
      agreementId ? trpc.agreements.get.query({ id: agreementId }) : Promise.resolve(null),
    ])
      .then(([buyers, available, settings, agreement]) => {
        if (cancelled) return
        setContacts(buyers)
        setTemplates(available)
        const seller = agreement?.sellerSnapshot as { companyName?: string | null } | null
        setSellerName(agreement ? seller?.companyName ?? "" : settings.companyName ?? "")
        setPricesIncludeTax(agreement?.pricesIncludeTax ?? settings.pricesIncludeTax)
        if (agreement) {
          if (agreement.status !== "draft") throw new Error(t("agreements.draftOnly"))
          setOfferFormatVersion(agreement.offerFormatVersion)
          setForm({
            contactId: agreement.contactId,
            title: agreement.title,
            summary: agreement.summary ?? "",
            termsMarkdown: agreement.termsMarkdown,
            templateId: agreement.templateId,
            validUntil: agreement.validUntil.toISOString().slice(0, 10),
            currency: agreement.currency,
            taxRate: String(agreement.taxRate),
            dueInDays: agreement.dueInDays,
            billingTrigger: agreement.billingTrigger as Form["billingTrigger"],
            notes: agreement.notes ?? "",
            deliverables: agreement.deliverables.map((line) => ({
              title: line.title,
              description: line.description,
              quantity: line.quantityInput ?? String(line.quantity),
              unitPrice: line.unitPriceInput ?? String(agreement.pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet),
              agreedDate: line.agreedDate?.toISOString().slice(0, 10) ?? null,
              expectedDate: line.expectedDate?.toISOString().slice(0, 10) ?? null,
              isDeposit: line.isDeposit,
            })),
          })
        } else {
          const template = available.find((item) => item.isDefault)
          setForm({
            ...initial,
            currency: settings.defaultCurrency,
            templateId: template?.id ?? null,
            termsMarkdown: template?.termsMarkdown ?? "",
          })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("agreements.error"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agreementId, t])
  function change<Key extends keyof Form>(key: Key, value: Form[Key]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }
  function changeLine(index: number, changes: Partial<EditorDeliverable>) {
    setForm((prev) => ({
      ...prev,
      deliverables: prev.deliverables.map((line, i) =>
        i === index ? { ...line, ...changes } : line,
      ),
    }))
  }
  const deferred = useDeferredValue(form)
  const preview = useMemo(() => {
    try {
      return {
        html: renderAgreementMarkdown(deferred.termsMarkdown, {
          "seller.name": sellerName,
          "buyer.name": contacts.find((item) => item.id === deferred.contactId)?.name ?? "",
          "agreement.title": deferred.title,
          "agreement.validUntil": deferred.validUntil,
          "agreement.total": `${offerFormatVersion === 2 ? previewDraft({ items: deferred.deliverables.filter(line => !line.isDeposit).map(line => ({ description: line.description || line.title || " ", quantity: line.quantity, unitPrice: line.unitPrice, vat: line.vat })), taxRate: deferred.taxRate, currency: deferred.currency, pricesIncludeTax }).result?.gross ?? "" : calculateLegacyDocument({
            items: deferred.deliverables.map(line => ({ description: line.description ?? "", quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) })), taxRate: Number(deferred.taxRate), pricesIncludeTax, fractionDigits: Math.min(currencyFractionDigits(deferred.currency), 2),
          }).totalGross.toFixed(2)} ${deferred.currency}`,
          deliverables: deferred.deliverables
            .map((line) => `${line.title}: ${line.description ?? ""}`)
            .join("\n"),
        }),
        error: null,
      }
    } catch (err) {
      return { html: "", error: err instanceof Error ? err.message : t("agreements.error") }
    }
  }, [deferred, sellerName, contacts, t, pricesIncludeTax, offerFormatVersion])
  async function save() {
    setError(null)
    const parsed = agreementCreateDraftDecimalInputSchema.safeParse(form)
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" "),
      )
      return
    }
    setSaving(true)
    try {
      const result = agreementId
        ? await trpc.agreements.updateDraftDecimal.mutate({ ...parsed.data, id: agreementId })
        : await trpc.agreements.createDraftDecimal.mutate(parsed.data)
      await navigate({ to: "/agreements/$agreementId", params: { agreementId: result.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : t("agreements.error"))
      setSaving(false)
    }
  }
  if (loading) return <div className="p-6">{t("agreements.loading")}</div>
  return (
    <div className="p-6 max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle>{t(agreementId ? "agreements.edit" : "agreements.new")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="title">{t("agreements.titleField")}</Label>
              <Input
                id="title"
                maxLength={200}
                value={form.title}
                onChange={(e) => change("title", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="customer">{t("agreements.customer")}</Label>
              <Select value={form.contactId} onValueChange={(id) => change("contactId", id)}>
                <SelectTrigger id="customer">
                  <SelectValue placeholder={t("agreements.customer")} />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="validUntil">{t("agreements.validUntil")}</Label>
              <LocalizedDateField
                id="validUntil"
                locale={locale}
                placeholder={t("docForm.selectDate")}
                value={form.validUntil}
                onChange={(value) => change("validUntil", value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="currency">{t("agreements.currency")}</Label>
              <Input
                id="currency"
                maxLength={3}
                value={form.currency}
                onChange={(e) => change("currency", e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="summary">{t("agreements.summary")}</Label>
            <Textarea
              id="summary"
              maxLength={5000}
              value={form.summary}
              onChange={(e) => change("summary", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("agreements.deliverables")}</Label>
            {form.deliverables.map((line, index) => (
              <div key={index} className="border rounded-md p-3 grid gap-3">
                <div className="flex gap-2">
                  <Input
                    aria-label={t("agreements.lineTitle")}
                    placeholder={t("agreements.lineTitle")}
                    value={line.title}
                    onChange={(e) => changeLine(index, { title: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("agreements.removeLine")}
                    onClick={() =>
                      change(
                        "deliverables",
                        form.deliverables.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Input
                  aria-label={t("agreements.lineDescription")}
                  placeholder={t("agreements.lineDescription")}
                  value={line.description ?? ""}
                  onChange={(e) => changeLine(index, { description: e.target.value })}
                />
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="grid gap-1">
                    <Label htmlFor={`qty-${index}`}>{t("agreements.quantity")}</Label>
                    <Input
                      id={`qty-${index}`}
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={line.quantity}
                      onChange={(e) => changeLine(index, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`price-${index}`}>{t("agreements.unitPrice")}</Label>
                    <Input
                      id={`price-${index}`}
                      type="number"
                      min="0"
                      step="0.0001"
                      value={line.unitPrice}
                      onChange={(e) => changeLine(index, { unitPrice: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`agreed-${index}`}>{t("agreements.agreedDate")}</Label>
                    <LocalizedDateField
                      id={`agreed-${index}`}
                      locale={locale}
                      placeholder={t("docForm.selectDate")}
                      value={line.agreedDate ?? ""}
                      onChange={(value) => changeLine(index, { agreedDate: value || null })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`expected-${index}`}>{t("agreements.expectedDate")}</Label>
                    <LocalizedDateField
                      id={`expected-${index}`}
                      locale={locale}
                      placeholder={t("docForm.selectDate")}
                      value={line.expectedDate ?? ""}
                      onChange={(value) => changeLine(index, { expectedDate: value || null })}
                    />
                  </div>
                </div>
                <Label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={line.isDeposit ?? false}
                    onChange={(e) => changeLine(index, { isDeposit: e.target.checked })}
                  />
                  {t(offerFormatVersion === 2 ? "agreements.scheduleLine" : "agreements.deposit")}
                </Label>
              </div>
            ))}
            <Button
              variant="outline"
              className="w-fit"
              disabled={form.deliverables.length >= 100}
              onClick={() => change("deliverables", [...form.deliverables, emptyLine()])}
            >
              <Plus className="size-4" />
              {t("agreements.addLine")}
            </Button>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="taxRate">{t("agreements.taxRate")}</Label>
              <Input
                id="taxRate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.taxRate}
                onChange={(e) => change("taxRate", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="dueInDays">{t("agreements.dueInDays")}</Label>
              <Input
                id="dueInDays"
                type="number"
                min="0"
                value={form.dueInDays}
                onChange={(e) => change("dueInDays", Number(e.target.value))}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("agreements.billingTrigger")}</Label>
              <Select
                value={form.billingTrigger}
                onValueChange={(value) => change("billingTrigger", value as Form["billingTrigger"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="on_acceptance">{t("agreements.onAcceptance")}</SelectItem>
                  <SelectItem value="on_delivery">{t("agreements.onDelivery")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {offerFormatVersion === 2 ? t("agreements.serviceTotal") : pricesIncludeTax ? t("docForm.summary.total") : t("docForm.summary.subtotal")}:{" "}
            {formatCurrency(
              offerFormatVersion === 2 ? Number(previewDraft({ items: form.deliverables.filter(line => !line.isDeposit).map(line => ({ description: line.description || line.title || " ", quantity: line.quantity, unitPrice: line.unitPrice, vat: line.vat })), taxRate: form.taxRate, currency: form.currency, pricesIncludeTax }).result?.[pricesIncludeTax ? "gross" : "net"] ?? "0") : calculateLegacyDocument({ items: form.deliverables.map((line) => ({ description: line.description ?? "", quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) })), taxRate: Number(form.taxRate), pricesIncludeTax, fractionDigits: Math.min(currencyFractionDigits(form.currency), 2) })[pricesIncludeTax ? "totalGross" : "subtotalNet"],
              form.currency.match(/^[A-Z]{3}$/) ? form.currency : "USD",
              locale,
            )}
          </p>
          <div className="grid gap-2">
            <Label>{t("agreements.template")}</Label>
            <Select
              value={form.templateId ?? "custom"}
              onValueChange={(id) => {
                const template = templates.find((item) => item.id === id)
                setForm((prev) => ({
                  ...prev,
                  templateId: template?.id ?? null,
                  termsMarkdown: template?.termsMarkdown ?? prev.termsMarkdown,
                }))
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">{t("agreements.custom")}</SelectItem>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{t("agreements.legalNotice")}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="terms">{t("agreements.terms")}</Label>
            <Textarea
              id="terms"
              rows={10}
              maxLength={50_000}
              value={form.termsMarkdown}
              onChange={(e) => change("termsMarkdown", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("agreements.preview")}</Label>
            {preview.error ? (
              <p role="alert" className="text-destructive">
                {preview.error}
              </p>
            ) : (
              <div
                className="border rounded-md p-4 space-y-3 break-words"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notes">{t("agreements.notes")}</Label>
            <Textarea
              id="notes"
              maxLength={5000}
              value={form.notes}
              onChange={(e) => change("notes", e.target.value)}
            />
          </div>
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate({ to: "/agreements" })}>
            {t("agreements.cancel")}
          </Button>
          <Button disabled={saving} onClick={save}>
            {t(saving ? "agreements.saving" : "agreements.save")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
