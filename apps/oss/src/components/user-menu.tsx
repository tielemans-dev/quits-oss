import { Link, useNavigate, useRouterState, type LinkProps } from '@tanstack/react-router'
import { CreditCard, LogOut, Monitor, Moon, Sun } from 'lucide-react'

import { authClient, useSession } from '../lib/auth-client'
import { invalidateAppLayoutSession } from '../lib/app-layout-session'
import { loadPage } from '../lib/page-navigation'
import { parseThemePreference, useTheme, type ThemePreference } from '../lib/theme'
import { Avatar, AvatarFallback } from './ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { useRuntimeDistribution } from '../lib/runtime-distribution'
import { useI18n } from '../lib/i18n/react'
import { resolveLanguage } from '../lib/i18n/translate'
import { parseUiLanguage, saveUiLanguage, uiLanguageLocale } from '../lib/i18n/ui-language'
import { loginReturnDestination } from '../lib/login-return'
import type { TranslationKey } from '../lib/i18n/messages'

const themeOptions: Array<{
  value: ThemePreference
  labelKey: TranslationKey
  icon: typeof Monitor
}> = [
  { value: 'system', labelKey: 'user.theme.system', icon: Monitor },
  { value: 'light', labelKey: 'user.theme.light', icon: Sun },
  { value: 'dark', labelKey: 'user.theme.dark', icon: Moon },
]

// Each language is named in itself, so it can be found from either.
const languageOptions = [
  { value: 'da', label: 'Dansk' },
  { value: 'en', label: 'English' },
] as const

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

/** The avatar at the right end of the top bar: who is signed in, language, theme, billing and sign out. */
export function UserMenu() {
  const { t, locale, setLocale } = useI18n()
  const navigate = useNavigate()
  const href = useRouterState({ select: (state) => state.location.href })
  const urlLanguage = useRouterState({ select: (state) => parseUiLanguage((state.location.search as { lang?: unknown }).lang) })
  const { billingEnabled } = useRuntimeDistribution()
  const { data: session } = useSession()
  const { preference: themePreference, setPreference: setThemePreference } = useTheme()

  const user = session?.user

  async function handleSignOut() {
    await authClient.signOut()
    // Mainly matters for a back/forward-cache restore; see `invalidateAppLayoutSession`.
    invalidateAppLayoutSession()
    // A new page load, so nothing of this session's organization survives in this tab.
    loadPage('/login')
  }

  function chooseLanguage(value: string) {
    const language = parseUiLanguage(value)
    if (!language) return
    saveUiLanguage(language)
    // Keep the organization's regional locale when it already speaks the chosen language.
    setLocale(resolveLanguage(locale) === language ? locale : uiLanguageLocale(language))
    // A `?lang` in the address would otherwise hold this page in the language it names.
    if (urlLanguage) void navigate({ href: loginReturnDestination(href, language), replace: true })
  }

  if (!user) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('user.menu')}
        className="flex size-8 shrink-0 items-center justify-center rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar className="size-7">
          <AvatarFallback className="bg-(--neutral-10) text-xs font-medium text-foreground">
            {getInitials(user.name ?? user.email)}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-60" align="end" sideOffset={6}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">
                    {getInitials(user.name ?? user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {user.name ?? t('user.defaultName')}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
              {t('user.language')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={resolveLanguage(locale)} onValueChange={chooseLanguage}>
              {languageOptions.map(({ value, label }) => (
                <DropdownMenuRadioItem key={value} value={value} lang={value}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
              {t('user.theme')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={themePreference}
              onValueChange={(value) => setThemePreference(parseThemePreference(value))}
            >
              {themeOptions.map(({ value, labelKey, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon className="text-muted-foreground" />
                  {t(labelKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {billingEnabled && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to={'/billing' as LinkProps['to']}>
                    <CreditCard />
                    {t('nav.billing')}
                  </Link>
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut />
              {t('user.signOut')}
            </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
