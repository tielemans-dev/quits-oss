import { describe, expect, it } from 'vitest'
import { authDestination, authLinkSearch, authSearchSchema } from '../auth/navigation'

describe('auth language and return navigation', () => {
  it('accepts carried DA/EN language and ignores unsupported input', () => {
    expect(authSearchSchema.parse({ lang: 'da', redirect: '/invoices' })).toEqual({ lang: 'da', redirect: '/invoices' })
    expect(authSearchSchema.parse({ lang: 'de' }).lang).toBeUndefined()
    expect(authLinkSearch({}, 'da-DK').lang).toBe('da')
    expect(authLinkSearch({ lang: 'en' }, 'da-DK').lang).toBe('en')
  })
  it('carries the return path including query and hash through auth links', () => {
    const redirect = '/invoices/inv_1?tab=payments#details'
    expect(authLinkSearch({ lang: 'da', redirect }, 'en')).toEqual({ lang: 'da', redirect })
    expect(authDestination(redirect, 'da')).toBe('/invoices/inv_1?tab=payments&lang=da#details')
  })
  it('uses next precedence through recovery links without re-encoding the target', () => {
    const target = '/invoices?filter=a%20b&item=x%2Fy#details'
    expect(authLinkSearch({ next: target, redirect: '/ignored' }, 'en')).toEqual({ lang: 'en', redirect: target })
    expect(authDestination(target, 'da')).toBe('/invoices?filter=a%20b&item=x%2Fy&lang=da#details')
    expect(authLinkSearch(authSearchSchema.parse({ next: 123, redirect: '/ignored' }), 'en').redirect).toBeUndefined()
  })
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/x/..//evil.example'])('rejects an external return path %s', (redirect) => {
    expect(authLinkSearch({ redirect }, 'en').redirect).toBeUndefined()
    expect(authDestination(redirect, 'en')).toBe('/?lang=en')
  })
})
