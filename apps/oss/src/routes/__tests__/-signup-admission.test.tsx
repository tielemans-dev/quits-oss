// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'

const { state, signUp, loadPage, getConfiguration } = vi.hoisted(() => ({
  state: { invite: undefined as string | undefined, mode: 'invite_only' as 'open' | 'invite_only', waitlist: { privacyVersion: '2026-10-09', privacyPath: '/privacy' } as { privacyVersion: string; privacyPath: string } | undefined },
  signUp: vi.fn(), loadPage: vi.fn(), getConfiguration: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options, useSearch: () => ({ invite: state.invite }), useLoaderData: () => ({ signupMode: state.mode, waitlist: state.waitlist }) }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock('../../lib/auth-client', () => ({ authClient: { signUp: { email: signUp } } }))
vi.mock('../../lib/page-navigation', () => ({ loadPage }))
vi.mock('../../lib/runtime/signup-config', () => ({ getSignupConfiguration: getConfiguration }))
import { SignupPage, Route } from '../signup'

function show(locale = 'en') { return render(<I18nProvider locale={locale}><SignupPage /></I18nProvider>) }
function submitSignup() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Person' } })
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'local-password123' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Sign up' }).closest('form')!)
}
async function blocked() {
  signUp.mockResolvedValue({ error: { code: 'not_invited', message: 'PRIVATE ACCOUNT DETAIL' } })
  show(); submitSignup()
  await screen.findByText('quits is invite-only for now')
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
beforeEach(() => { state.mode = 'invite_only'; state.invite = undefined; state.waitlist = { privacyVersion: '2026-10-09', privacyPath: '/privacy' }; signUp.mockReset(); loadPage.mockReset() })

describe('signup admission UI', () => {
  it('uses the server loader and preserves the open presentation', () => {
    expect((Route as unknown as { loader: unknown }).loader).toBeTypeOf('function')
    state.mode = 'open'; state.invite = 'PRIVATE'
    show()
    expect(screen.queryByLabelText(/Invite code/)).toBeNull()
    expect(screen.getByText('Sign up to start managing your invoices')).toBeTruthy()
  })
  it('prefills a code without validating and normalizes only on submission', async () => {
    state.invite = 'quits-7k4m-2p9x'
    signUp.mockResolvedValue({ data: { user: {} } }); show()
    expect((screen.getByLabelText(/Invite code/) as HTMLInputElement).value).toBe(state.invite)
    expect(signUp).not.toHaveBeenCalled()
    submitSignup()
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith('/onboarding'))
    expect(signUp.mock.calls[0]![1].body).toEqual({ inviteCode: 'QUITS-7K4M-2P9X' })
  })
  it('keeps values and focuses the code on invalid admission without showing server messages', async () => {
    signUp.mockResolvedValue({ error: { code: 'invite_invalid', message: 'PRIVATE ACCOUNT DETAIL' } })
    show(); submitSignup()
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain("This code doesn't work with this email")
    expect(screen.queryByText('PRIVATE ACCOUNT DETAIL')).toBeNull()
    expect(document.activeElement).toBe(screen.getByLabelText(/Invite code/))
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('local-password123')
  })
  it('blocks with prefilled email and returns to preserved signup values', async () => {
    await blocked()
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('person@example.test')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Test Person')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('local-password123')
    expect(document.activeElement).toBe(screen.getByLabelText(/Invite code/))
  })
  it('requires unticked consent and privacy navigation never ticks it', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await blocked()
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(fetcher).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('checkbox'))
    expect(screen.getByRole('alert').textContent).toContain('Tick the box')
    fireEvent.click(screen.getByRole('link', { name: 'Read the privacy notice.' }))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
  it('sends same-origin source/note/consent/version/locale and focuses joined title', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher); await blocked()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByText('You’re on the list')
    const [path, options] = fetcher.mock.calls[0]!
    expect(path).toBe('/api/waitlist'); expect(options.credentials).toBe('same-origin')
    expect(JSON.parse(options.body)).toEqual({ email: 'person@example.test', note: '', source: 'app-signup', consent: true, privacyVersion: '2026-10-09', locale: 'en', honeypot: '' })
    expect(document.activeElement?.tagName).toBe('H1')
  })
  it.each([['rate_limited', 'Too many attempts']])('maps %s without leaking account details', async (code, message) => {
    signUp.mockResolvedValue({ error: { code, message: 'PRIVATE ACCOUNT DETAIL' } }); show(); submitSignup()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message === 'Too many attempts' ? 'Too many attempts. Wait a minute, then try again.' : message))
  })
  it.each([['consent_required', 400, 'Tick the box'], ['invalid_email', 400, 'Enter a valid'], ['rate_limited', 429, 'Too many attempts'], ['OTHER', 500, 'Check your connection']])('keeps waitlist values on %s', async (error, status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error }, { status }))); await blocked()
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message))
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('person@example.test')
  })
  it('prevents concurrent waitlist requests and preserves values on network failure', async () => {
    let reject!: (value: unknown) => void
    const fetcher = vi.fn(() => new Promise((_resolve, fail) => { reject = fail })); vi.stubGlobal('fetch', fetcher); await blocked()
    fireEvent.click(screen.getByRole('checkbox'))
    const form = screen.getByRole('button', { name: 'Join the waitlist' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form); expect(fetcher).toHaveBeenCalledOnce()
    reject(new Error('offline'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Check your connection'))
  })
  it('renders final Danish invitation copy', () => {
    show('da'); expect(screen.getByText('quits kræver en invitation frem til lanceringen. Har du fået en, kan du oprette din konto her.')).toBeTruthy()
    expect(screen.getByLabelText(/Invitationskode/)).toBeTruthy()
  })
})
