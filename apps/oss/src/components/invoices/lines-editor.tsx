import { useId } from "react"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import type { FieldIssue } from "@quits/contracts/agent"
import { Plus, Trash2 } from "lucide-react"
import type { CatalogItemOption } from "../../lib/catalog"
import { invoiceIssueKey } from "../../lib/invoice-field-issues"
import { invoiceQuantityInput } from "../../lib/invoice-quantity"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { LineVatSelect } from "./line-vat-select"

type EditableLine = DocumentLineInput & { catalogItemId?: string; deliverableId?: string }
const columnsWithVat = "@min-[760px]:grid-cols-[minmax(90px,1fr)_minmax(140px,2fr)_60px_90px_160px_100px_32px]"
const columnsWithoutVat = "@min-[760px]:grid-cols-[minmax(90px,1fr)_minmax(140px,2fr)_60px_90px_100px_32px]"

/** One editor for invoice creation and draft edits; lines stack with labels on phones. */
export function InvoiceLinesEditor<Line extends EditableLine>({ items, onItemsChange, catalogItems, onCatalogItem, onAdd, onRemove, amounts, taxRate, standardVatRate, defaultCountry, momsRegistered, showVat = true, issues = [] }: {
  items: Line[]; onItemsChange: (items: Line[]) => void; catalogItems: CatalogItemOption[];
  onCatalogItem: (index: number, id: string) => void; onAdd: () => void; onRemove: (index: number) => void;
  amounts: string[]; taxRate: string; standardVatRate?: string | null; defaultCountry?: string | null; momsRegistered?: boolean | null; /** The compact VAT column suits a policy-fixed rate; otherwise the full classification editor sits below the lines. */ showVat?: boolean; issues?: FieldIssue[];
}) {
  const { t, locale } = useI18n()
  const prefix = useId()
  const columns = showVat ? columnsWithVat : columnsWithoutVat
  const patch = (index: number, field: "description" | "quantity" | "unitPrice", value: string) => onItemsChange(items.map((line, i) => i === index ? { ...line, [field]: value } : line))
  const issueFor = (index: number, field: string) => issues.find(issue => issue.field === `items.${index}.${field}`)
  const errorText = (index: number, field: string) => {
    const issue = issueFor(index, field)
    return issue ? <p role="alert" className="text-sm text-destructive">{t(invoiceIssueKey(issue.code), issue.params)}</p> : null
  }
  return <div className="@container grid gap-3">
    <Label>{t("docForm.lineItems")}</Label>
    <div className="rounded-md border">
      <div aria-hidden="true" className={`hidden @min-[760px]:grid ${columns} gap-2 p-3 border-b bg-muted/50 text-sm font-medium`}>
        <span>{t("docForm.column.item")}</span><span>{t("docForm.column.description")}</span><span>{t("docForm.column.qty")}</span>
        <span>{t("docForm.column.unitPrice")}</span>{showVat && <span>{t("invoiceVat.column")}</span>}<span className="text-right">{t("docForm.column.total")}</span><span />
      </div>
      {items.map((item, index) => <div key={index} className={`grid grid-cols-2 ${columns} gap-3 @min-[760px]:gap-2 p-3 border-b last:border-0 items-start`}>
        <div className="grid gap-1">
          <Label className="@min-[760px]:sr-only" htmlFor={`${prefix}-${index}-catalog`}>{t("docForm.column.item")}</Label>
          <Select disabled={!!item.deliverableId} value={item.catalogItemId} onValueChange={value => onCatalogItem(index, value)}>
            <SelectTrigger id={`${prefix}-${index}-catalog`} className="w-full min-w-0"><SelectValue placeholder={t(catalogItems.length ? "docForm.selectItem" : "docForm.noSavedItems")} /></SelectTrigger>
            <SelectContent>{catalogItems.map(option => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label className="@min-[760px]:sr-only" htmlFor={`${prefix}-${index}-description`}>{t("docForm.column.description")}</Label>
          <Textarea data-validation-field={`items.${index}.description`} id={`${prefix}-${index}-description`} className="min-w-0 [overflow-wrap:anywhere]" disabled={!!item.deliverableId} value={item.description} aria-invalid={!!issueFor(index, "description")} onChange={event => patch(index, "description", event.target.value)} />
          {errorText(index, "description")}
        </div>
        <div className="grid gap-1">
          <Label className="@min-[760px]:sr-only" htmlFor={`${prefix}-${index}-quantity`}>{t("docForm.column.qty")}</Label>
          <Input data-validation-field={`items.${index}.quantity`} id={`${prefix}-${index}-quantity`} type="text" inputMode="decimal" disabled={!!item.deliverableId} value={item.quantity || ""} aria-invalid={!!issueFor(index, "quantity") || !invoiceQuantityInput(locale).safeParse(item.quantity).success} onChange={event => patch(index, "quantity", event.target.value)} />
          {errorText(index, "quantity")}
        </div>
        <div className="grid gap-1">
          <Label className="@min-[760px]:sr-only" htmlFor={`${prefix}-${index}-price`}>{t("docForm.column.unitPrice")}</Label>
          <Input data-validation-field={`items.${index}.unitPrice`} id={`${prefix}-${index}-price`} type="number" min="0" step="0.0001" disabled={!!item.deliverableId} value={item.unitPrice || ""} aria-invalid={!!issueFor(index, "unitPrice")} onChange={event => patch(index, "unitPrice", event.target.value)} />
          {errorText(index, "unitPrice")}
        </div>
        {showVat && <div className="grid gap-1">
          <span className="@min-[760px]:sr-only text-sm font-medium">{t("invoiceVat.column")}</span>
          <LineVatSelect item={item} index={index} taxRate={taxRate} standardVatRate={standardVatRate} defaultCountry={defaultCountry} momsRegistered={momsRegistered} disabled={!!item.deliverableId}
            onChange={vat => onItemsChange(items.map((line, i) => i === index ? { ...line, vat } : line))} />
          {errorText(index, "vat")}
        </div>}
        <div className="grid gap-1 text-right">
          <span id={`${prefix}-${index}-total`} className="@min-[760px]:sr-only text-sm font-medium">{t("docForm.column.total")}</span>
          <output aria-labelledby={`${prefix}-${index}-total`} className="num text-sm @min-[760px]:py-2">{amounts[index]}</output>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("invoiceLines.remove", { number: index + 1 })} onClick={() => onRemove(index)} disabled={items.length <= 1}><Trash2 className="size-4 text-muted-foreground" /></Button>
      </div>)}
    </div>
    <Button type="button" variant="outline" size="sm" onClick={onAdd} className="w-fit"><Plus className="size-4" />{t("docForm.action.addItem")}</Button>
  </div>
}
