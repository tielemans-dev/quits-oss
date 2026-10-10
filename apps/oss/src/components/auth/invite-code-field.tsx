import type { RefObject } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useI18n } from '../../lib/i18n/react'

export function InviteCodeField({ value, onChange, fromLink, invalid, inputRef }: {
  value: string; onChange: (value: string) => void; fromLink: boolean; invalid: boolean
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const { t } = useI18n()
  return <div className="flex flex-col gap-2">
    <Label htmlFor="invite-code">{t('auth.signup.inviteCode.label')} <span className="text-muted-foreground">{t('auth.signup.inviteCode.optional')}</span></Label>
    <Input id="invite-code" ref={inputRef} value={value} onChange={(event) => onChange(event.target.value)}
      className="font-mono" placeholder={t('auth.signup.inviteCode.placeholder')} autoComplete="off"
      autoCapitalize="characters" spellCheck={false} maxLength={32} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? 'invite-code-error' : 'invite-code-help'} />
    {invalid ? <p id="invite-code-error" role="alert" className="text-xs text-destructive">▪ {t('auth.signup.error.inviteInvalid')}</p>
      : <p id="invite-code-help" className="text-xs text-muted-foreground">{fromLink ? '▪ ' : ''}{t(fromLink ? 'auth.signup.inviteCode.fromLink' : 'auth.signup.inviteCode.help')}</p>}
  </div>
}
