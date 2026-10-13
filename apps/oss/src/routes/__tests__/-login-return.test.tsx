// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'
import { loginReturnDestination, loginReturnOnboarding, loginReturnSearchSchema, loginReturnTarget } from '../../lib/login-return'

const state = vi.hoisted(() => ({
  search: {} as Record<string, string>, cloud: false, active: false,
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
  useSession: () => ({ data: { session: { activeOrganizationId: state.active ? 'org_1' : null } } }),
}))
vi.mock('../../trpc/client', () => ({ trpc: {
  onboarding: { getStatus: { query: state.status }, saveDraft: { mutate: state.draft }, completeManual: { mutate: state.complete } },
  runtime: { capabilities: { query: async () => ({ onboardingAi: { enabled: false } }) } },
} }))
import { Route as LoginRoute } from '../login'
import { Route as OnboardingRoute } from '../_app/onboarding'
import { asMockedRoute } from '../../test-utils/mocked-route'
const Login = asMockedRoute(LoginRoute).component
const Onboarding = asMockedRoute(OnboardingRoute).component
const orgs = [{ id: 'org_1', name: 'First org' }, { id: 'org_2', name: 'Second org' }]

function renderPage(Page: React.ComponentType) { return render(<I18nProvider locale="en"><Page /></I18nProvider>) }
function submitLogin(lang = 'en') {
  fireEvent.change(screen.getByLabelText(lang === 'da' ? 'E-mail' : 'Email'), { target: { value: 'user@example.test' } })
  fireEvent.change(screen.getByLabelText(lang === 'da' ? 'Adgangskode' : 'Password'), { target: { value: 'password123' } })
  fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Sign in' }).closest('form')!)
}
afterEach(() => {
  cleanup(); vi.resetAllMocks()
  state.search = {}; state.cloud = false; state.active = false
})

describe('login return contract', () => {
  it('validates both aliases and DA/EN with deterministic next precedence', () => {
    expect(loginReturnSearchSchema.parse({ next: '/a', redirect: '/b', lang: 'da' })).toEqual({ next: '/a', redirect: '/b', lang: 'da' })
    expect(loginReturnTarget({ next: '/a', redirect: '/b' })).toBe('/a')
    expect(loginReturnTarget({ next: 'https://evil.example', redirect: '/b' })).toBeNull()
    expect(loginReturnSearchSchema.parse({ lang: 'de' }).lang).toBeUndefined()
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
  it('resumes after completing required cloud setup', async () => {
    state.cloud = true; state.active = true; state.search = { next: '/hosted/account?tab=vat', lang: 'da' }
    state.status.mockResolvedValue({ isComplete: false, missing: [] }); state.draft.mockResolvedValue({ missing: [] }); state.complete.mockResolvedValue({})
    renderPage(Onboarding)
    await waitFor(() => expect(screen.queryByText('Loading onboarding state…')).toBeNull())
    fireEvent.submit(screen.getByRole('button', { name: 'Finish onboarding' }).closest('form')!)
    await waitFor(() => expect(state.load).toHaveBeenCalledWith('/hosted/account?tab=vat&lang=da'))
    expect(state.complete).toHaveBeenCalledWith({ method: 'manual' })
  })
})
