// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../lib/i18n/react'
import { loginRedirectHref, loginReturnDestination, loginReturnOnboarding, loginReturnSearchSchema, loginReturnTarget, onboardingShellLanguage } from '../../lib/login-return'

const state = vi.hoisted(() => ({
  search: {} as Record<string, string>, cloud: false, active: false, fallback: false,
  load: vi.fn(), navigate: vi.fn(), signIn: vi.fn(), list: vi.fn(), setActive: vi.fn(), create: vi.fn(),
  checkSlug: vi.fn(), searchCvr: vi.fn(),
  status: vi.fn(), complete: vi.fn(), draft: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => state.search }),
  Link: ({ children, to, search, ...props }: { children: React.ReactNode; to: string; search?: Record<string, string | undefined> }) => {
    const query = new URLSearchParams(Object.entries(search ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return <a {...props} href={to + (query.size ? '?' + query : '')}>{children}</a>
  },
  useNavigate: () => state.navigate,
}))
vi.mock('../../lib/page-navigation', () => ({ loadPage: state.load }))
vi.mock('../../lib/runtime-distribution', () => ({ useRuntimeDistribution: () => ({ isCloud: state.cloud }) }))
vi.mock('../../lib/auth-client', () => ({
  authClient: { signIn: { email: state.signIn }, organization: { list: state.list, setActive: state.setActive, create: state.create, checkSlug: state.checkSlug } },
  useSession: () => ({ data: { user: { id: 'user_1', email: 'user@example.test' }, session: { activeOrganizationId: state.active ? 'org_1' : null } } }),
}))
vi.mock('../../trpc/client', () => ({ trpc: {
  onboarding: { getStatus: { query: state.status }, saveDraft: { mutate: state.draft }, completeManual: { mutate: state.complete }, searchCvr: { query: state.searchCvr } },
  cvr: { available: { query: async () => ({ enabled: false, suggestions: false }) }, setupAvailable: { query: async () => ({ enabled: false }) } },
  runtime: { capabilities: { query: async () => ({ onboardingAi: { enabled: false }, onboardingV2: { enabled: state.fallback }, sellerVatConfirmation: { enabled: state.fallback } }) } },
} }))
vi.mock('../../components/onboarding/company-setup', () => ({ CompanySetup: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>Complete fallback</button> }))
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
  fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Log ind' : 'Log in' }).closest('form')!)
}
afterEach(() => {
  cleanup(); vi.resetAllMocks(); vi.restoreAllMocks()
  state.search = {}; state.cloud = false; state.active = false; state.fallback = false
})

describe('login return contract', () => {
  it('keeps the preferred alias through language switching and recovery/signup links', () => {
    const target = '/invoices?filter=a%20b&item=x%2Fy#details'
    state.search = { next: target, redirect: '/ignored', lang: 'en' }
    renderPage(Login)
    const language = new URL(screen.getByRole('link', { name: 'Dansk' }).getAttribute('href')!, window.location.origin)
    expect(language.searchParams.get('next')).toBe(target)
    expect(language.searchParams.get('lang')).toBe('da')
    for (const name of ['Forgot password?', 'Sign up']) {
      const link = new URL(screen.getByRole('link', { name }).getAttribute('href')!, window.location.origin)
      expect(link.searchParams.get('redirect')).toBe(target)
      expect(link.searchParams.get('next')).toBeNull()
      expect(link.searchParams.get('lang')).toBe('en')
    }
  })
  it('validates both aliases and DA/EN with deterministic next precedence', () => {
    expect(loginReturnSearchSchema.parse({ next: '/a', redirect: '/b', lang: 'da' })).toEqual({ next: '/a', redirect: '/b', lang: 'da' })
    expect(loginReturnTarget({ next: '/a', redirect: '/b' })).toBe('/a')
    expect(loginReturnTarget({ next: 'https://evil.example', redirect: '/b' })).toBeNull()
    for (const unsafe of ['//evil.example', '/\\evil.example', 'https://evil.example/x', '/login', '/login?redirect=%2Fa', '/login/', '/LOGIN', '/Login?x=1', '/%6Cogin', '/%6cOGIN/', '/login//', '/login/%2e', '/lo%09gin', '/login%00', '/lo%7Fgin']) {
      expect(loginReturnTarget({ redirect: unsafe })).toBeNull()
    }
  })
  it('builds the login address a signed-out visitor is sent to', () => {
    expect(loginRedirectHref('/invoices/new?a=b#c')).toBe('/login?redirect=%2Finvoices%2Fnew%3Fa%3Db%23c')
    expect(loginRedirectHref('/settings', 'da')).toBe('/login?redirect=%2Fsettings&lang=da')
    expect(loginRedirectHref('/')).toBe('/login')
    expect(loginRedirectHref('/login?redirect=%2Fsettings')).toBe('/login')
    expect(loginRedirectHref('/%6Cogin')).toBe('/login')
    expect(loginRedirectHref('/LOGIN/')).toBe('/login')
    expect(loginRedirectHref('/lo%09gin')).toBe('/login')
    expect(loginRedirectHref('/loginx')).toBe('/login?redirect=%2Floginx')
    expect(loginRedirectHref('//evil.example')).toBe('/login')
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

describe('first login after sign-out (QUI-76)', () => {
  it('does not navigate into a bounce while the server cannot see the new session', async () => {
    state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ error: { status: 401 } })
    renderPage(Login); submitLogin()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("couldn't confirm the session"), { timeout: 4000 })
    expect(state.load).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Log in' })).toHaveProperty('disabled', false)
  })

  it('continues once the session becomes visible on a retry', async () => {
    state.signIn.mockResolvedValue({ data: {} }); state.setActive.mockResolvedValue({ data: {} })
    state.list.mockResolvedValueOnce({ error: { status: 401 } }).mockResolvedValue({ data: [orgs[0]] })
    renderPage(Login); submitLogin()
    await waitFor(() => expect(state.load).toHaveBeenCalledWith('/'), { timeout: 4000 })
  })

  it('does nothing more after the page is left while the session is still settling', async () => {
    state.signIn.mockResolvedValue({ data: {} }); state.setActive.mockResolvedValue({ data: {} })
    let release!: () => void
    state.list.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ data: [orgs[0]] }) }))
    const view = renderPage(Login); submitLogin()
    await waitFor(() => expect(state.list).toHaveBeenCalled())
    view.unmount()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(state.setActive).not.toHaveBeenCalled()
    expect(state.load).not.toHaveBeenCalled()
  })

  it('does not load a page after leaving during the organization switch', async () => {
    state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: [orgs[0]] })
    let release!: () => void
    state.setActive.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ error: { message: 'no' } }) }))
    const view = renderPage(Login); submitLogin()
    await waitFor(() => expect(state.setActive).toHaveBeenCalled())
    view.unmount()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(state.load).not.toHaveBeenCalled()
  })

  it('keeps the form locked while the page load is on its way', async () => {
    state.signIn.mockResolvedValue({ data: {} }); state.list.mockResolvedValue({ data: [orgs[0]] }); state.setActive.mockResolvedValue({ data: {} })
    renderPage(Login); submitLogin()
    await waitFor(() => expect(state.load).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Logging in…' })).toHaveProperty('disabled', true)
  })
})

describe('return after required organization flow', () => {
  for (const cloud of [false, true]) for (const create of [false, true]) {
    it(`returns after ${create ? 'create' : 'choose'} in ${cloud ? 'cloud' : 'selfhost'}, retaining cloud setup`, async () => {
      state.cloud = cloud; state.search = { next: '/hosted/account?tab=vat', lang: 'en' }
      state.list.mockResolvedValue({ data: create ? [] : orgs }); state.setActive.mockResolvedValue({ data: {} }); state.create.mockResolvedValue({ data: { id: 'org_1' } })
      state.checkSlug.mockResolvedValue({ data: { status: true } })
      renderPage(Onboarding)
      if (create) {
        if (cloud) fireEvent.click(await screen.findByRole('button', { name: 'Enter manually' }))
        const input = await screen.findByLabelText('Company name')
        fireEvent.change(input, { target: { value: 'New org' } })
        fireEvent.change(screen.getByLabelText('CVR number'), { target: { value: '24256790' } })
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
      state.checkSlug.mockResolvedValue({ data: { status: true } })
      renderPage(Onboarding, fallback)
      const creationTitle = cloud
        ? (lang === 'da' ? 'Slå dit eget CVR op' : 'Look up your own CVR')
        : (lang === 'da' ? 'Indtast virksomhedsnavnet' : 'Enter your company name')
      expect(await screen.findByText(create ? creationTitle : (lang === 'da' ? 'Vælg din organisation' : 'Choose your organization'))).toBeTruthy()
      if (create) {
        if (cloud) fireEvent.click(screen.getByRole('button', { name: lang === 'da' ? 'Indtast manuelt' : 'Enter manually' }))
        fireEvent.change(await screen.findByLabelText(lang === 'da' ? 'Virksomhedsnavn' : 'Company name'), { target: { value: 'New org' } })
        fireEvent.change(screen.getByLabelText(lang === 'da' ? 'CVR-nr.' : 'CVR number'), { target: { value: '24256790' } })
        fireEvent.submit(screen.getByRole('button', { name: lang === 'da' ? 'Opret organisation' : 'Create organization' }).closest('form')!)
      } else fireEvent.click(await screen.findByText('Second org'))
      await waitFor(() => expect(state.load).toHaveBeenCalledWith(cloud ? loginReturnOnboarding(state.search) : `/hosted/account?tab=vat&lang=${lang}`))
    })
  }
  it('creates the organization from the confirmed CVR company and skips people who already have one', async () => {
    state.cloud = true
    state.list.mockResolvedValue({ data: [] })
    state.checkSlug.mockImplementation(async ({ slug }: { slug: string }) => ({ data: { status: slug !== 'nordlys-studio-aps' } }))
    state.create.mockResolvedValue({ data: { id: 'org_1' } })
    state.setActive.mockResolvedValue({ data: {} })
    state.searchCvr.mockResolvedValue({
      available: true,
      companies: [{ cvr: '24256790', name: 'Nordlys Studio ApS', address: 'Vestergade 1' }],
    })
    renderPage(Onboarding)
    expect(screen.queryByLabelText('Slug')).toBeNull()
    fireEvent.change(await screen.findByLabelText('Company name or CVR'), { target: { value: 'Nordlys' } })
    expect(screen.getByRole('button', { name: 'Look up' }).closest('form')?.className).toContain('gap-6')
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }))
    fireEvent.click(await screen.findByRole('button', { name: /Use Nordlys Studio ApS/ }))
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ name: 'Nordlys Studio ApS', slug: 'nordlys-studio-aps-2', metadata: { cvr: '24256790', onboardingAutoSlug: 'nordlys-studio-aps-2' } }))
    expect(state.load).toHaveBeenCalledWith('/')

    cleanup()
    state.list.mockResolvedValue({ data: orgs })
    renderPage(Onboarding)
    expect(await screen.findByText('Choose your organization')).toBeTruthy()
    expect(screen.queryByText('Look up your own CVR')).toBeNull()
  })
  it.each<Record<string, string> & { lang?: 'da' | 'en' }>([
    { next: '/invoices?filter=a%20b#details', lang: 'da' },
    { redirect: '/contacts#details', lang: 'en' },
    { lang: 'da' },
    {},
  ])('preserves the fallback onboarding return destination for %j', async search => {
    state.cloud = true; state.active = true; state.fallback = true; state.search = search
    state.status.mockResolvedValue({ isComplete: false, missing: [] })
    renderPage(Onboarding)
    fireEvent.click(await screen.findByRole('button', { name: 'Complete fallback' }))
    if (Object.keys(search).length) {
      expect(state.load).toHaveBeenCalledWith(loginReturnDestination(loginReturnTarget(search) ?? '/', search.lang))
      expect(state.navigate).not.toHaveBeenCalled()
    } else {
      expect(state.navigate).toHaveBeenCalledWith({ to: '/' })
      expect(state.load).not.toHaveBeenCalled()
    }
  })
  it('resumes after completing required cloud setup', async () => {
    state.cloud = true; state.active = true; state.search = { next: '/hosted/account?tab=vat', lang: 'da' }
    state.status.mockResolvedValue({ isComplete: false, missing: [] }); state.draft.mockResolvedValue({ missing: [] }); state.complete.mockResolvedValue({})
    renderPage(Onboarding)
    await waitFor(() => expect(screen.queryByText('Indlæser opsætning…')).toBeNull())
    fireEvent.change(screen.getByLabelText('Virksomhedsnavn'), { target: { value: 'Return target ApS' } })
    fireEvent.change(screen.getByLabelText('Adresse'), { target: { value: 'Testvej 1, 2100 København' } })
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'billing@example.test' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Afslut opsætning' }).closest('form')!)
    await waitFor(() => expect(state.load).toHaveBeenCalledWith('/hosted/account?tab=vat&lang=da'))
    expect(state.complete).toHaveBeenCalledWith({ method: 'manual' })
  })
})

describe('onboarding shell language (QUI-56)', () => {
  it('gives the app shell the language onboarding was opened with, and only on onboarding', () => {
    expect(onboardingShellLanguage('/onboarding', { lang: 'da' })).toBe('da')
    expect(onboardingShellLanguage('/onboarding/', { lang: 'en', next: '/invoices' })).toBe('en')
    expect(onboardingShellLanguage('/onboarding', {})).toBeUndefined()
    expect(onboardingShellLanguage('/onboarding', { lang: 'xx' })).toBeUndefined()
    expect(onboardingShellLanguage('/invoices', { lang: 'da' })).toBeUndefined()
    expect(onboardingShellLanguage('/onboardingx', { lang: 'da' })).toBeUndefined()
  })
})
