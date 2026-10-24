import { describe, expect, it } from 'vitest'
import approvedCopy from './auth-approved-copy.json'
import { translate } from '../translate'
import type { TranslationKey } from '../messages'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../auth/password-policy'

describe('approved auth copy', () => {
  it.each(approvedCopy)('%s matches the approved DA/EN copy', (key, da, en) => {
    expect(translate(key as TranslationKey, 'da')).toBe(da)
    expect(translate(key as TranslationKey, 'en')).toBe(en)
  })
  it.each(['da', 'en'])('interpolates email and policy bounds in %s', (locale) => {
    expect(translate('auth.forgotPassword.confirmation', locale, { email: 'synthetic@example.test' })).toContain('synthetic@example.test')
    expect(translate('auth.signup.passwordHelp', locale, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })).toContain('12')
    expect(translate('auth.resetPassword.policy', locale, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })).toContain('128')
  })
})
