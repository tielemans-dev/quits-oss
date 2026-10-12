import { z } from 'zod'
import { resolveLanguage } from '../i18n/translate'
import { toInternalRedirectPath } from '../redirect-target'

export const authSearchSchema = z.object({
  lang: z.enum(['da', 'en']).optional().catch(undefined),
  redirect: z.string().optional(),
})

export type AuthSearch = z.infer<typeof authSearchSchema>

export function authLinkSearch(search: AuthSearch, locale: string): AuthSearch {
  return { lang: search.lang ?? resolveLanguage(locale), redirect: toInternalRedirectPath(search.redirect) ?? undefined }
}

export function authDestination(path: string, lang?: 'da' | 'en'): string {
  const safePath = toInternalRedirectPath(path) ?? '/'
  if (!lang) return safePath
  const url = new URL(safePath, 'http://internal.invalid')
  url.searchParams.set('lang', lang)
  return url.pathname + url.search + url.hash
}
