// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'
import { loadPage } from '../../lib/page-navigation'

const { state, signUp, requestReset, resetPassword } = vi.hoisted(() => ({
  state: { search: {} as Record<string, string> }, signUp: vi.fn(), requestReset: vi.fn(), resetPassword: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options, useSearch: () => state.search,
    useLoaderData: () => ({ signupMode: 'invite_only' }),
  }),
  Link: ({ children, to, search, ...props }: {
    children: React.ReactNode; to: string; search?: Record<string, string> | ((value: Record<string, string>) => Record<string, string>)
  }) => {
    const query = typeof search === 'function' ? search(state.search) : search
    const params = new URLSearchParams(Object.entries(query ?? {}).filter(([, value]) => value !== undefined))
    return <a {...props} href={to + (params.size ? '?' + params : '')}>{children}</a>
  },
}))
vi.mock('../../lib/auth-client', () => ({ authClient: { signUp: { email: signUp }, requestPasswordReset: requestReset, resetPassword } }))
vi.mock('../../lib/page-navigation', () => ({ loadPage: vi.fn() }))
vi.mock('../../lib/runtime/signup-config', () => ({ getSignupConfiguration: vi.fn() }))
import { SignupPage } from '../signup'
import { Route as ForgotRoute } from '../forgot-password'
import { Route as ResetRoute } from '../reset-password'
import { asMockedRoute } from '../../test-utils/mocked-route'
const ForgotPage = asMockedRoute(ForgotRoute).component
const ResetPage = asMockedRoute(ResetRoute).component

afterEach(() => { cleanup(); state.search = {}; signUp.mockReset(); requestReset.mockReset(); resetPassword.mockReset(); vi.mocked(loadPage).mockReset(); vi.restoreAllMocks() })

describe('auth locale rendering and admission', () => {
  it.each([undefined, 'da', 'en'] as const)('carries only an explicit signup language %s to onboarding', async (lang) => {
    state.search = lang ? { lang } : {}
    signUp.mockResolvedValue({ data: { user: {} } })
    render(<I18nProvider locale={lang === 'en' ? 'da' : 'en'}><SignupPage /></I18nProvider>)
    const danish = lang === 'da'
    fireEvent.change(screen.getByLabelText(danish ? 'Navn' : 'Name'), { target: { value: 'Synthetic Person' } })
    fireEvent.change(screen.getByLabelText(danish ? 'E-mail' : 'Email'), { target: { value: 'allowed@example.test' } })
    fireEvent.change(screen.getByLabelText(danish ? 'Adgangskode' : 'Password'), { target: { value: '12345678' } })
    fireEvent.submit(screen.getByRole('button', { name: danish ? 'Opret konto' : 'Create account' }).closest('form')!)
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(lang ? `/onboarding?lang=${lang}` : '/onboarding'))
  })
  it.each([
    ['/invoices?tab=paid#details', '/onboarding?next=%2Finvoices%3Ftab%3Dpaid%23details&lang=en'],
    ['https://evil.example', '/onboarding?lang=en'],
    ['//evil.example', '/onboarding?lang=en'],
    ['/\\evil.example', '/onboarding?lang=en'],
    ['/x/..//evil.example', '/onboarding?lang=en'],
  ])('preserves only a safe signup return target %s', async (redirect, destination) => {
    state.search = { lang: 'en', redirect }
    signUp.mockResolvedValue({ data: { user: {} } })
    render(<I18nProvider><SignupPage /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic Person' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'allowed@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '12345678' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!)
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(destination))
  })
  it('uses the browser default and lets carried language override it', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('da-DK')
    const first = render(<I18nProvider><SignupPage /></I18nProvider>)
    await screen.findByLabelText('Adgangskode')
    expect(screen.getByPlaceholderText('navn@firma.dk')).toBeTruthy()
    first.unmount()
    state.search = { lang: 'en', redirect: '/invoices?tab=paid' }
    render(<I18nProvider><SignupPage /></I18nProvider>)
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Dansk' }).getAttribute('href')).toContain('lang=da')
    expect(screen.getByRole('link', { name: 'Dansk' }).getAttribute('href')).toContain('redirect=%2Finvoices%3Ftab%3Dpaid')
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login?lang=en&redirect=%2Finvoices%3Ftab%3Dpaid')
  })
  it('submits an allowlisted email with no code and uses neutral duplicate copy', async () => {
    signUp.mockResolvedValue({ error: { code: 'USER_ALREADY_EXISTS', message: 'User already exists' } })
    render(<I18nProvider locale="en"><SignupPage /></I18nProvider>)
    expect(screen.getByLabelText('Invite code').hasAttribute('required')).toBe(false)
    expect(screen.queryByText('(optional)')).toBeNull()
    expect(screen.getByText("You'll find the code in your invitation.")).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic Person' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'allowed@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '12345678' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!)
    await screen.findByRole('alert')
    expect(signUp.mock.calls[0]![1]).toEqual({ body: { inviteCode: '' } })
    expect(screen.getByRole('alert').textContent).toBe("We couldn't create your account right now. Try again in a moment.")
    expect(screen.queryByText('User already exists')).toBeNull()
  })
  it.each(['da', 'en'])('shows the wordmark and interpolated forgot confirmation in %s', async (lang) => {
    state.search = { lang, redirect: '/invoices' }
    requestReset.mockResolvedValue({ data: {} })
    render(<I18nProvider><ForgotPage /></I18nProvider>)
    expect(screen.getByRole('img', { name: 'quits' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText(lang === 'da' ? 'E-mail' : 'Email'), { target: { value: 'synthetic@example.test' } })
    fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Send link' : 'Send reset link' }).closest('form')!)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('synthetic@example.test'))
    expect(screen.getByRole('status').textContent).not.toContain('{email}')
    expect(requestReset.mock.calls[0]![1]).toEqual({ headers: { 'accept-language': lang } })
    expect(requestReset.mock.calls[0]![0].redirectTo).toBe(window.location.origin + '/reset-password?lang=' + lang + '&redirect=%2Finvoices')
  })
  it('preserves token and return target on the reset language toggle', () => {
    state.search = { token: 'synthetic-token', lang: 'da', redirect: '/invoices' }
    render(<I18nProvider><ResetPage /></I18nProvider>)
    expect(screen.getByLabelText('Gentag adgangskode')).toBeTruthy()
    expect(screen.getByText('Brug mellem 8 og 128 tegn.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'English' }).getAttribute('href')).toBe('/reset-password?token=synthetic-token&lang=en&redirect=%2Finvoices')
  })
  it.each([7, 8, 128, 129])("uses policy bounds for signup length %s with optional code", async (length) => {
    signUp.mockResolvedValue({ data: { user: {} } })
    render(<I18nProvider locale="en"><SignupPage /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic Person' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'allowed@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'p'.repeat(length) } })
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form')!)
    if (length === 7 || length === 129) {
      expect(signUp).not.toHaveBeenCalled()
      expect(screen.getByRole('alert').textContent).toBe(length === 7 ? 'Use at least 8 characters' : '128 characters max')
    } else {
      await waitFor(() => expect(signUp).toHaveBeenCalledOnce())
      expect(signUp.mock.calls[0]![1]).toEqual({ body: { inviteCode: '' } })
    }
  })

  it('removes the consumed token from language-toggle links after reset', async () => {
    state.search = { token: 'synthetic-token', lang: 'en', redirect: '/invoices' }
    resetPassword.mockResolvedValue({ data: {} })
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    render(<I18nProvider><ResetPage /></I18nProvider>)
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password' } })
    fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'new-password' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save new password' }).closest('form')!)
    await screen.findByRole('status')
    expect(screen.getByRole('link', { name: 'Dansk' }).getAttribute('href')).toBe('/reset-password?lang=da&redirect=%2Finvoices')
  })

})
