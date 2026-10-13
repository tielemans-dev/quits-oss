// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'
import { loginReturnDestination, loginReturnOnboarding, loginReturnSearchSchema, loginReturnTarget } from '../../lib/login-return'

const state = vi.hoisted(() => ({
  search: {} as Record<string, string>, cloud: false, active: false, v2: false,
  load: vi.fn(), navigate: vi.fn(), signIn: vi.fn(), list: vi.fn(), setActive: vi.fn(), create: vi.fn(),
  status: vi.fn(), complete: vi.fn(), draft: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => state.search }),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useNavigate: () => state.navigate,
}))
vi.mock('../../lib/page-navigation', () => ({ loadPage: state.load }))
vi.mock('../../lib/runtime-distribution', () => ({ useRuntimeDistribution: () => ({ isCloud: state.cloud }) }))
vi.mock('../../lib/auth-client', () => ({
  authClient: { signIn: { email: state.signIn }, organization: { list: state.list, setActive: state.setActive, create: state.create } },
  useSession: () => ({ data: { user: { id: 'user_1', email: 'user@example.test' }, session: { activeOrganizationId: state.active ? 'org_1' : null } } }),
}))
vi.mock('../../trpc/client', () => ({ trpc: {
  onboarding: { getStatus: { query: state.status }, saveDraft: { mutate: state.draft }, completeManual: { mutate: state.complete } },
  cvr: { available: { query: async () => ({ enabled: state.v2, suggestions: false }) } },
  runtime: { capabilities: { query: async () => ({ onboardingAi: { enabled: false } }) } },
} }))
vi.mock('../../components/onboarding-v2/client', () => ({ createOnboardingV2Client: () => ({}) }))
vi.mock('../../components/onboarding-v2/onboarding-v2', () => ({
  OnboardingV2: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>Complete V2</button>,
}))
import { Route as LoginRoute } from '../login'
import { Route as OnboardingRoute } from '../_app/onboarding'
import { asMockedRoute } from '../../test-utils/mocked-route'
const Login = asMockedRoute(LoginRoute).component
const Onboarding = asMockedRoute(OnboardingRoute).component
const orgs = [{ id: 'org_1', name: 'First org' }, { id: 'org_2', name: 'Second org' }]

function renderPage(Page: React.ComponentType, locale = "en") { return render(<I18nProvider initialLocale={locale}><Page /></I18nProvider>) }
function submitLogin(lang = 'en') {
  fireEvent.change(screen.getByLabelText(lang === 'da' ? 'E-mail' : 'Email'), { target: { value: 'user@example.test' } })
  fireEvent.change(screen.getByLabelText(lang === 'da' ? 'Adgangskode' : 'Password'), { target: { value: 'password123' } })
  fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Sign in' }).closest('form')!)
}
afterEach(() => {
  cleanup(); vi.resetAllMocks(); vi.restoreAllMocks()
  state.search = {}; state.cloud = false; state.active = false; state.v2 = false
})

describe('login return contract', () => {
  it.each(['da', 'en'])('returns from V2 confirmation with the exact target and %s language', async lang => {
    state.cloud = true; state.active = true; state.v2 = true
    state.search = { next: '/invoices?filter=a%20b#review', lang }
    state.status.mockResolvedValue({ isComplete: false, missing: [], values: {} })
    renderPage(Onboarding)
    fireEvent.click(await screen.findByRole('button', { name: 'Complete V2' }))
    expect(state.load).toHaveBeenCalledWith(`/invoices?filter=a%20b&lang=${lang}#review`)
    expect(state.navigate).not.toHaveBeenCalled()
  })
  it('validates both aliases and DA/EN with deterministic next precedence', () => {
    expect(loginReturnSearchSchema.parse({ next: '/a', redirect: '/b', lang: 'da' })).toEqual({ next: '/a', redirect: '/b', lang: 'da' })
    expect(loginReturnTarget({ next: '/a', redirect: '/b' })).toBe('/a')
    expect(loginReturnTarget({ next: 'https://evil.example', redirect: '/b' })).toBeNull()
    expect(loginReturnSearchSchema.parse({ lang: 'de' }).lang).toBeUndefined()
  })
  for (const alias of ['next', 'redirect']) for (const value of ['123', 'true', 'false', 'null', '%5B1%5D', '%7B%7D']) for (const cloud of [false, true]) {
    it(`renders login and uses the ${cloud ? 'cloud' : 'selfhost'} default for parsed ${alias}=${value}`, async () => {
      const { defaultParseSearch } = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
      const parsed = defaultParseSearch(`?${alias}=${value}`) as Record<string, unknown>
      expect(typeof parsed[alias]).not.toBe('string')
      state.search = loginReturnSearchSchema.parse(parsed)
      expect(loginReturnTarget(state.search)).toBeNull()
      state.cloud = cloud
      state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: [orgs[0]] }); state.setActive.mockResolvedValue({ data: {} })
      renderPage(Login); submitLogin()
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(cloud ? '/onboarding' : '/'))
    })
  }
  it('keeps an invalid non-string next ahead of a valid redirect alias', () => {
    expect(loginReturnTarget(loginReturnSearchSchema.parse({ next: 123, redirect: '/invoices' }))).toBeNull()
  })
  it('preserves exact query encoding and hash while updating only the language', () => {
    expect(loginReturnDestination('/hosted/account?filter=a%20b&item=x%2Fy&lang=da#vat', 'en'))
      .toBe('/hosted/account?filter=a%20b&item=x%2Fy&lang=en#vat')
    expect(loginReturnDestination('/hosted/account?filter=a%20b#vat')).toBe('/hosted/account?filter=a%20b#vat')
    expect(loginReturnDestination('/hosted/account?lang=en&tab=vat', 'en')).toBe('/hosted/account?lang=en&tab=vat')
  })
  for (const alias of ['next', 'redirect']) for (const cloud of [false, true]) for (const lang of ['da', 'en']) {
    it(`returns ${cloud ? 'cloud' : 'selfhost'} ${lang} login via ${alias} after setting the org`, async () => {
      state.search = { [alias]: '/hosted/account?filter=a%20b&tab=vat#details', lang }
      state.cloud = cloud
      state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: [orgs[0]] })
      state.setActive.mockResolvedValue({ data: {} })
      renderPage(Login); submitLogin(lang)
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(`/hosted/account?filter=a%20b&tab=vat&lang=${lang}#details`))
      expect(state.setActive).toHaveBeenCalledWith({ organizationId: 'org_1' })
      expect(state.load).toHaveBeenCalledTimes(1)
    })
  }
  for (const alias of ['next', 'redirect']) for (const target of ['https://evil.example', '//evil.example', '/\\evil.example', '/x/..//evil.example']) for (const cloud of [false, true]) {
    it(`rejects ${alias}=${target} and retains ${cloud ? 'cloud' : 'selfhost'} default`, async () => {
      state.cloud = cloud; state.search = { [alias]: target }
      state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: [orgs[0]] }); state.setActive.mockResolvedValue({ data: {} })
      renderPage(Login); submitLogin()
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(cloud ? '/onboarding' : '/'))
    })
  }
  for (const count of [0, 2]) for (const cloud of [false, true]) {
    it(`carries target through required org ${count ? 'choice' : 'creation'} in ${cloud ? 'cloud' : 'selfhost'}`, async () => {
      state.cloud = cloud; state.search = { next: '/hosted/account?tab=vat', lang: 'da' }
      state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: orgs.slice(0, count) })
      renderPage(Login); submitLogin('da')
      await waitFor(() => expect(state.load).toHaveBeenCalledWith('/onboarding?next=%2Fhosted%2Faccount%3Ftab%3Dvat&lang=da'))
      expect(state.setActive).not.toHaveBeenCalled()
    })
  }
  for (const cloud of [false, true]) for (const count of [0, 1, 2]) {
    it(`keeps no-target default in ${cloud ? 'cloud' : 'selfhost'} with ${count} orgs`, async () => {
      state.cloud = cloud; state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: orgs.slice(0, count) }); state.setActive.mockResolvedValue({ data: {} })
      renderPage(Login); submitLogin()
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(count === 1 && !cloud ? '/' : '/onboarding'))
    })
  }
  it('retains a safe target if org listing fails so page guards can recover', async () => {
    state.cloud = true; state.search = { next: '/hosted/account?lang=en', lang: 'en' }
    state.signIn.mockResolvedValue({ data: {} }); state.list.mockRejectedValue(new Error('Unavailable'))
    renderPage(Login); submitLogin()
    await waitFor(() => expect(state.load).toHaveBeenCalledWith('/hosted/account?lang=en'))
  })
})

describe('return after required organization flow', () => {
  for (const cloud of [false, true]) for (const create of [false, true]) {
    it(`returns after ${create ? 'create' : 'choose'} in ${cloud ? 'cloud' : 'selfhost'}, retaining cloud setup`, async () => {
      state.cloud = cloud; state.search = { next: '/hosted/account?tab=vat', lang: 'en' }
      state.list.mockResolvedValue({ data: create ? [] : orgs }); state.setActive.mockResolvedValue({ data: {} }); state.create.mockResolvedValue({ data: { id: 'org_1' } })
      renderPage(Onboarding)
      if (create) {
        const input = await screen.findByLabelText('Organization name')
        fireEvent.change(input, { target: { value: 'New org' } })
        fireEvent.submit(screen.getByRole('button', { name: 'Create organization' }).closest('form')!)
      } else fireEvent.click(await screen.findByText('Second org'))
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(cloud ? loginReturnOnboarding(state.search) : '/hosted/account?tab=vat&lang=en'))
      expect(state.setActive).toHaveBeenCalled()
    })
  }
  for (const cloud of [false, true]) for (const create of [false, true]) for (const lang of ['da', 'en']) {
    it(`pins ${lang} over browser/org defaults through ${create ? 'create' : 'choose'} in ${cloud ? 'cloud' : 'selfhost'}`, async () => {
      const fallback = lang === 'da' ? 'en-US' : 'da-DK'
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(fallback)
      state.cloud = cloud; state.search = { next: '/hosted/account?tab=vat', lang }
      state.list.mockResolvedValue({ data: create ? [] : orgs }); state.setActive.mockResolvedValue({ data: {} }); state.create.mockResolvedValue({ data: { id: 'org_1' } })
      renderPage(Onboarding, fallback)
      expect(await screen.findByText(create ? (lang === 'da' ? 'Opret din organisation' : 'Create your organization') : (lang === 'da' ? 'Vælg din organisation' : 'Choose your organization'))).toBeTruthy()
      if (create) {
        fireEvent.change(await screen.findByLabelText(lang === 'da' ? 'Organisationsnavn' : 'Organization name'), { target: { value: 'New org' } })
        fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Opret organisation' : 'Create organization' }).closest('form')!)
      } else fireEvent.click(await screen.findByText('Second org'))
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(cloud ? loginReturnOnboarding(state.search) : `/hosted/account?tab=vat&lang=${lang}`))
    })
  }
  it('resumes after completing required cloud setup', async () => {
    state.cloud = true; state.active = true; state.search = { next: '/hosted/account?tab=vat', lang: 'da' }
    state.status.mockResolvedValue({ isComplete: false, missing: [] }); state.draft.mockResolvedValue({ missing: [] }); state.complete.mockResolvedValue({})
    renderPage(Onboarding)
    await waitFor(() => expect(screen.queryByText('Loading onboarding state…')).toBeNull())
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Return target ApS' } })
    fireEvent.change(screen.getByLabelText('Company address'), { target: { value: 'Testvej 1, 2100 København' } })
    fireEvent.change(screen.getByLabelText('Billing email'), { target: { value: 'billing@example.test' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Finish onboarding' }).closest('form')!)
    await waitFor(() => expect(state.load).toHaveBeenCalledWith('/hosted/account?tab=vat&lang=da'))
    expect(state.complete).toHaveBeenCalledWith({ method: 'manual' })
  })
})
