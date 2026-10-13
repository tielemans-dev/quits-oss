import { z } from 'zod'
import type { TranslationKey } from '../i18n/messages'

export function authFieldError(values: { email: string; password?: string; name?: string }): TranslationKey | null {
  if (values.name !== undefined && !values.name.trim()) return 'auth.signup.error.nameRequired'
  if (!values.email.trim()) return 'auth.error.emailRequired'
  if (!z.email().safeParse(values.email.trim()).success) return 'auth.error.emailFormat'
  if (values.password !== undefined && !values.password) return 'auth.error.passwordRequired'
  return null
}
