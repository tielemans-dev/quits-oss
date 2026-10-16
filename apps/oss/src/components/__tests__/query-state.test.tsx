// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../lib/i18n/react'
import { QueryError, QuerySkeleton, MutationErrors } from '../query-state'
import { translate } from '../../lib/i18n/translate'
import { reportMutationError } from '../../lib/query-refresh'

afterEach(cleanup)
describe('request states', () => {
  it.each([['en-US', 'Try again'], ['da-DK', 'Prøv igen']])('offers a working retry and the server message in %s', (locale, label) => {
    const retry = vi.fn()
    render(<I18nProvider locale={locale}><QueryError error={new Error('Connection refused')} retry={retry} /></I18nProvider>)
    expect(screen.getByRole('alert').textContent).toContain('Connection refused')
    fireEvent.click(screen.getByRole('button', {name:label}))
    expect(retry).toHaveBeenCalledOnce()
  })
  it('renders a skeleton while loading', () => {
    const {container} = render(<I18nProvider><QuerySkeleton /></I18nProvider>)
    expect(container.querySelector('[data-slot="list-skeleton"]')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['en-US', 'da-DK'])('keeps raw validation payloads out of the fallback in %s', locale => {
    render(<I18nProvider locale={locale}><MutationErrors /></I18nProvider>)
    act(() => reportMutationError(new Error(JSON.stringify([{code:'too_small',path:['items',0,'description'],message:'Raw schema failure'}])), null))
    expect(screen.getByRole('alert').textContent).toContain(translate('validation.line.description.required', locale))
    expect(screen.getByRole('alert').textContent).not.toContain('Raw schema failure')
    expect(screen.getByRole('alert').textContent).not.toContain('"path"')
  })
  it('shows previously swallowed mutation errors and lets the user dismiss them', () => {
    render(<I18nProvider><MutationErrors /></I18nProvider>)
    act(() => reportMutationError(new Error('Cannot delete an issued invoice'), null))
    expect(screen.getByRole('alert').textContent).toContain('Cannot delete an issued invoice')
    fireEvent.click(screen.getByRole('button', {name:'Close'}))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
