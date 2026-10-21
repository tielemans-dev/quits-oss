import type { AuthSearch } from '../../lib/auth/navigation'
import { Link } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { useI18n } from '../../lib/i18n/react'
import { WaitlistForm } from './waitlist-form'

export function InviteOnlyPanel({ email, waitlist, onUseCode, onJoined, search }: {
  search?: AuthSearch
  email: string; waitlist?: { privacyVersion: string; privacyPath: string }
  onUseCode: () => void; onJoined: (email: string) => void
}) {
  const { t } = useI18n()
  const body = t('auth.inviteOnly.body', { email: '\u0000' }).split('\u0000')
  return <Card className="w-full max-w-[440px]">
    <CardHeader>
      <CardTitle className="text-2xl">{t('auth.inviteOnly.title')}</CardTitle>
      <CardDescription>{body[0]}<span className="font-medium text-foreground">{email}</span>{body[1]}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      {waitlist && <WaitlistForm initialEmail={email} {...waitlist} onJoined={onJoined} />}
      <div className="flex flex-col gap-2 border-t pt-4 text-sm text-muted-foreground">
        <p className="flex items-center justify-between gap-2">{t('auth.inviteOnly.haveCode')} <button type="button" onClick={onUseCode} className="min-h-11 underline text-foreground">{t('auth.inviteOnly.useCode')}</button></p>
        <p>{t('auth.inviteOnly.selfHost')}{' '}<a href={t('auth.inviteOnly.selfHostHref')} target="_blank" rel="noopener" className="underline text-foreground">{t('auth.inviteOnly.selfHostLink')} ↗</a></p>
        <Link to="/login" search={search} className="flex min-h-11 items-center underline">← {t('auth.inviteOnly.backToLogin')}</Link>
      </div>
    </CardContent>
  </Card>
}
