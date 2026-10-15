import { z } from 'zod'
import { toInternalRedirectPath } from './redirect-target'

export const loginReturnSearchSchema = z.object({
  // TanStack's JSON-first search parser can produce non-strings. Keep an invalid supplied
  // alias as an empty target so `next` still wins over `redirect`, without blocking login.
  next: z.string().optional().catch(''),
  redirect: z.string().optional().catch(''),
  lang: z.enum(['da', 'en']).optional().catch(undefined),
})

type LoginReturnSearch = z.infer<typeof loginReturnSearchSchema>

/** Onboarding speaks the `lang` it was opened with, so the app shell around it must speak it too. */
export function onboardingShellLanguage(pathname: string, search: unknown): 'da' | 'en' | undefined {
  if (pathname !== '/onboarding' && !pathname.startsWith('/onboarding/')) return undefined
  return loginReturnSearchSchema.safeParse(search).data?.lang
}

/** Returning to the login page after logging in would only loop. */
function isLoginPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0]
  return pathname === '/login' || pathname.startsWith('/login/')
}

/** `next` wins when both aliases are supplied, even if it is invalid. */
export function loginReturnTarget(search: LoginReturnSearch): string | null {
  const target = toInternalRedirectPath(search.next ?? search.redirect)
  return target && !isLoginPath(target) ? target : null
}

/** Where a signed-out visitor to `path` (including search) logs in before resuming it. */
export function loginRedirectHref(path: string, lang?: 'da' | 'en'): string {
  const target = loginReturnTarget({ redirect: path })
  const query = new URLSearchParams()
  if (target && target !== '/') query.set('redirect', target)
  if (lang) query.set('lang', lang)
  return `/login${query.size ? `?${query}` : ''}`
}

/** Carry language without re-encoding the destination's other query parameters. */
export function loginReturnDestination(path: string, lang?: 'da' | 'en'): string {
  const safePath = toInternalRedirectPath(path) ?? '/'
  if (!lang) return safePath
  const hashIndex = safePath.indexOf('#')
  const beforeHash = hashIndex < 0 ? safePath : safePath.slice(0, hashIndex)
  const hash = hashIndex < 0 ? '' : safePath.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  const pathname = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex)
  const query = queryIndex < 0 ? [] : beforeHash.slice(queryIndex + 1).split('&')
  let hasLanguage = false
  const params = query.flatMap((part) => {
    if (!new URLSearchParams(part).has('lang')) return [part]
    if (hasLanguage) return []
    hasLanguage = true
    return [`lang=${lang}`]
  })
  if (!hasLanguage) params.push(`lang=${lang}`)
  return `${pathname}?${params.join('&')}${hash}`
}

export function loginReturnOnboarding(search: LoginReturnSearch): string {
  const target = loginReturnTarget(search)
  const query = new URLSearchParams()
  if (target) query.set('next', target)
  if (search.lang) query.set('lang', search.lang)
  return `/onboarding${query.size ? `?${query}` : ''}`
}
