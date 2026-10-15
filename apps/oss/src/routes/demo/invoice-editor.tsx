import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { previewDraft } from '@quits/shared/pricing'
import { InvoiceLinesEditor } from '../../components/invoices/lines-editor'
import { DocumentTotals } from '../../components/documents/document-totals'
import { PageHeader } from '../../components/kvit/page-header'
import { Button } from '../../components/ui/button'
import { applyCatalogItemToLineItem } from '../../lib/catalog'
import { formatCurrency } from '../../lib/i18n/format'
import { normalizeInvoiceQuantity } from '../../lib/invoice-quantity'
import { createDemoLines, demoCatalog } from './-data'

export const Route = createFileRoute('/demo/invoice-editor')({ component: InvoiceEditorDemo })

export function InvoiceEditorDemo() {
  const [items, setItems] = useState(createDemoLines)
  const preview = previewDraft({ items: items.map(item => normalizeInvoiceQuantity(item, 'en-US')), taxRate: '25', currency: 'DKK', pricesIncludeTax: false })
  const result = preview.result
  return <>
    <PageHeader title="Invoice editor" subtitle="Example Studio · DEMO-2026-001" actions={<Button variant="outline" onClick={() => setItems(createDemoLines())}>Reset example</Button>} />
    <InvoiceLinesEditor items={items} onItemsChange={setItems} catalogItems={demoCatalog}
      onCatalogItem={(index, id) => setItems(current => current.map((line, i) => i === index ? applyCatalogItemToLineItem(line, id, demoCatalog) : line))}
      onAdd={() => setItems(current => [...current, { description: '', quantity: '1', unitPrice: '0' }])}
      onRemove={index => setItems(current => current.filter((_, i) => i !== index))}
      amounts={items.map((_, index) => result ? formatCurrency(Number(result.lines[index]?.net ?? '0'), 'DKK', 'en-US') : '—')}
      taxRate="25" standardVatRate="25" defaultCountry="DK" momsRegistered />
    {result ? <div className="ml-auto mt-8 grid max-w-sm gap-2 text-sm">
      <DocumentTotals priceBasis="net" subtotal={Number(result.net)} taxAmount={Number(result.tax)} total={Number(result.gross)} currency="DKK" />
    </div> : <p role="status" className="mt-4 text-sm text-muted-foreground">Enter valid quantities and amounts to preview totals.</p>}
  </>
}
