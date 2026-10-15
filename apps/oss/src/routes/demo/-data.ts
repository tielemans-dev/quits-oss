import type { DocumentLineInput } from '@quits/contracts/invoices'
import type { CatalogItemOption } from '../../lib/catalog'

// Fixed, fictional fixtures. Never seed a database or attach an authenticated client here.
export const demoCatalog: CatalogItemOption[] = [
  { id: 'demo-design', name: 'Design', description: 'Example design workshop', defaultUnitPrice: 800 },
  { id: 'demo-support', name: 'Support', description: 'Example support session', defaultUnitPrice: 400 },
]

export function createDemoLines(): (DocumentLineInput & { quantity: string; unitPrice: string })[] {
  return [
    { description: 'Example design workshop', quantity: '2', unitPrice: '800' },
    { description: 'Example support session', quantity: '1', unitPrice: '400' },
  ]
}

export const demoInvoice = {
  number: 'DEMO-2026-001', recipient: 'accounts@example.com',
  amount: 'DKK 2,500.00', dueDate: 'October 29, 2026',
} as const

export const demoPrototypes = [
  { to: '/demo/invoice-editor', title: 'Invoice editor', description: 'Edit example lines, choose catalog items and check totals.' },
  { to: '/demo/send-review', title: 'Send review', description: 'Open, cancel and confirm the invoice send sheet without sending email.' },
] as const
