import { z } from 'zod'
import { toInternalRedirectPath } from './redirect-target'

export const loginReturnSearchSchema = z.object({
  next: z.string().optional(),
  redirect: z.string().optional(),
  lang: z.enum(['da', 'en']).optional().catch(undefined),
})

type LoginReturnSearch = z.infer<typeof loginReturnSearchSchema>

/** `next` wins when both aliases are supplied, even if it is invalid. */
export function loginReturnTarget(search: LoginReturnSearch): string | null {
  return toInternalRedirectPath(search.next ?? search.redirect)
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
