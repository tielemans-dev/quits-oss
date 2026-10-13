import { resolveLanguage } from '../i18n/translate'
import { loginReturnSearchSchema, loginReturnTarget, loginReturnDestination } from '../login-return'
import type { z } from 'zod'

export const authSearchSchema = loginReturnSearchSchema

export type AuthSearch = z.infer<typeof authSearchSchema>

export function authLinkSearch(search: AuthSearch, locale: string): AuthSearch {
  return { lang: search.lang ?? resolveLanguage(locale), redirect: loginReturnTarget(search) ?? undefined }
}

export const authDestination = loginReturnDestination
