// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { previewDraft } from '@quits/shared/pricing'
import { I18nProvider } from '../../lib/i18n/react'
import { createDemoLines, demoCatalog, demoInvoice } from '../demo/-data'

vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: unknown) => options }))
import { InvoiceEditorDemo } from '../demo/invoice-editor'
import { SendReviewDemo } from '../demo/send-review'

afterEach(cleanup)

describe('demo examples', () => {
  it('creates independent, deterministic seeds with the real pricing calculation', () => {
    const lines = createDemoLines()
    lines[0]!.description = 'Changed'
    expect(createDemoLines()[0]!.description).toBe('Example design workshop')
    expect(demoInvoice.recipient).toBe('accounts@example.com')
    expect(demoCatalog.every(item => item.id.startsWith('demo-'))).toBe(true)
    expect(previewDraft({ items: createDemoLines(), taxRate: '25', pricesIncludeTax: false, currency: 'DKK' }).result?.gross).toBe('2500.00')
  })

  it('edits, adds, removes and resets lines locally using the real editor', () => {
    render(<I18nProvider locale="en-US"><InvoiceEditorDemo /></I18nProvider>)
    fireEvent.change(screen.getByDisplayValue('Example design workshop'), { target: { value: 'Changed' } })
    expect(screen.getByDisplayValue('Changed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /add item/i }))
    expect(screen.getAllByRole('textbox')).toHaveLength(6)
    fireEvent.click(screen.getByRole('button', { name: /remove.*3/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset example' }))
    expect(screen.getByDisplayValue('Example design workshop')).toBeTruthy()
    expect(screen.queryByDisplayValue('Changed')).toBeNull()
  })

  it('cancels and confirms the real send sheet without a transport', () => {
    render(<I18nProvider locale="en-US"><SendReviewDemo /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Review example invoice' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review example invoice' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /send/i }))
    expect(screen.getByRole('status').textContent).toBe('Demo confirmed. No email was sent.')
  })
})
