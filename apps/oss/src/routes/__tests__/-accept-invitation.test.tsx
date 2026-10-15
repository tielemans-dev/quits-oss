// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'

const state = vi.hoisted(() => ({ accept: vi.fn(), navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ invitationId: 'inv_1' }) }),
  useNavigate: () => state.navigate,
}))
vi.mock('../../lib/auth-client', () => ({ authClient: { organization: { acceptInvitation: state.accept } } }))
vi.mock('../../lib/active-organization', () => ({ switchActiveOrganization: vi.fn() }))
import { Route } from '../accept-invitation.$invitationId'
import { asMockedRoute } from '../../test-utils/mocked-route'
const Page = asMockedRoute(Route).component

afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('accept invitation errors', () => {
  for (const [locale, text] of [
    ['en', 'This invitation has already been used or is no longer valid.'],
    ['da', 'Denne invitation er allerede brugt eller gælder ikke længere.'],
  ] as const) {
    it(`explains a used invitation in ${locale}`, async () => {
      state.accept.mockResolvedValue({ error: { status: 400, code: 'INVITATION_NOT_FOUND', message: 'Invitation not found' } })
      render(<I18nProvider initialLocale={locale}><Page /></I18nProvider>)
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text))
    })
  }

  it('still shows other server errors as sent', async () => {
    state.accept.mockResolvedValue({ error: { status: 403, code: 'X', message: 'Not for you' } })
    render(<I18nProvider initialLocale="en"><Page /></I18nProvider>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not for you'))
  })
})
