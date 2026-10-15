import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useI18n } from '../../lib/i18n/react'

function validEmail(value: string) {
  const email = value.trim()
  return email.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && email.slice(email.lastIndexOf('.') + 1).length >= 2
}

export function WaitlistForm({ initialEmail, privacyVersion, privacyPath, onJoined }: {
  initialEmail: string
  privacyVersion: string
  privacyPath: string
  onJoined: (email: string) => void
}) {
  const { t, locale } = useI18n()
  const [email, setEmail] = useState(initialEmail)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [emailError, setEmailError] = useState(false)
  const [consentError, setConsentError] = useState(false)
  const [banner, setBanner] = useState<'rate' | 'network' | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ field: 'email' | 'consent' } | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const consentRef = useRef<HTMLInputElement>(null)
  const honeypotRef = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const validated = useRef(false)

  useLayoutEffect(() => {
    // Each failed submit requests focus, even if blur already set the same error.
    // Wait for React to re-enable the checkbox after a server rejection.
    if (focusRequest && !busy) {
      const ref = focusRequest.field === 'email' ? emailRef : consentRef
      ref.current?.focus()
    }
  }, [focusRequest, busy])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current) return
    validated.current = true
    const valid = validEmail(email)
    setEmailError(!valid)
    setConsentError(!consent)
    setBanner(null)
    if (!valid) { setFocusRequest({ field: 'email' }); return }
    if (!consent) { setFocusRequest({ field: 'consent' }); return }
    setFocusRequest(null)
    pending.current = true
    setBusy(true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email.trim(), consent: true, privacyVersion,
          locale: locale.toLowerCase().startsWith('da') ? 'da' : 'en', source: 'app-signup',
          note: '', honeypot: honeypotRef.current?.value ?? '' }),
      })
      if (response.ok) { onJoined(email.trim()); return }
      const body = await response.json().catch(() => null)
      if ((response.status === 400 || response.status === 422) && body?.error === 'consent_required') {
        setConsent(false); setConsentError(true); setFocusRequest({ field: 'consent' })
      } else if (response.status === 400 || (response.status === 422 && body?.error === 'invalid_email')) {
        setEmailError(true); setFocusRequest({ field: 'email' })
      } else setBanner(response.status === 429 ? 'rate' : 'network')
    } catch { setBanner('network') }
    finally { clearTimeout(timer); pending.current = false; setBusy(false) }
  }

  return <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-busy={busy}>
    <div className="flex flex-col gap-2">
      <Label htmlFor="waitlist-email">{t('auth.waitlist.emailLabel')}</Label>
      <Input id="waitlist-email" ref={emailRef} type="email" autoComplete="email" autoCapitalize="none"
        spellCheck={false} maxLength={254} value={email} readOnly={busy} required
        aria-invalid={emailError || undefined} aria-describedby={emailError ? 'waitlist-email-error' : undefined}
        onChange={(event) => {
          setEmail(event.target.value)
          // Once validation starts, update before a pointer press can blur the
          // field and insert an error that moves the submit button mid-click.
          if (validated.current) setEmailError(!validEmail(event.target.value))
        }}
        onBlur={() => { if (validated.current) setEmailError(!validEmail(email)) }} />
      {emailError && <p id="waitlist-email-error" role="alert" className="text-xs text-destructive">▪ {t('auth.waitlist.errInvalid')}</p>}
    </div>
    <div className="absolute -left-[10000px]" aria-hidden="true">
      <label htmlFor="waitlist-website">Website</label>
      <input id="waitlist-website" name="website" ref={honeypotRef} tabIndex={-1} autoComplete="off" />
    </div>
    <div>
      <div className="grid grid-cols-[44px_1fr] items-start -ml-3">
        <label htmlFor="waitlist-consent" className="flex size-11 cursor-pointer items-center justify-center">
          <input id="waitlist-consent" ref={consentRef} type="checkbox" checked={consent} disabled={busy}
            aria-invalid={consentError || undefined} aria-describedby={consentError ? 'waitlist-consent-error' : undefined}
            onChange={(event) => { setConsent(event.target.checked); setConsentError(false) }} />
        </label>
        <div className="pt-3 text-xs leading-relaxed text-muted-foreground">
          <label htmlFor="waitlist-consent">{t('auth.waitlist.consent')}</label>{' '}
          <a href={privacyPath} className="underline" target="_blank" rel="noopener">{t('auth.waitlist.privacyLink')}</a>
        </div>
      </div>
      {consentError && <p id="waitlist-consent-error" role="alert" className="text-xs text-destructive">▪ {t('auth.waitlist.errConsent')}</p>}
    </div>
    {banner && <p role="alert" className={banner === 'rate' ? 'text-xs text-tone-warning' : 'text-xs text-destructive'}>▪ {t(banner === 'rate' ? 'auth.waitlist.errRate' : 'auth.waitlist.errNetwork')}</p>}
    <Button type="submit" className="w-full bg-foreground text-background hover:bg-foreground/90" disabled={busy}>{t(busy ? 'auth.waitlist.submitting' : 'auth.waitlist.submit')}</Button>
    <span className="sr-only" role="status">{busy ? t('auth.waitlist.submitting') : ''}</span>
  </form>
}
