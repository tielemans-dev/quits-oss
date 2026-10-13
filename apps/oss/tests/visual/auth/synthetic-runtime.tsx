// SYNTHETIC FIXTURE ONLY. Actual auth components, inert router/config and deterministic responses.
import type { ComponentProps, ReactNode } from 'react'
const search = () => Object.fromEntries(new URLSearchParams(window.location.search))
export function createFileRoute(_path: string) {
  return (options: Record<string, unknown>) => ({
    ...options, useSearch: search,
    useLoaderData: () => ({ signupMode: 'invite_only', waitlist: { privacyVersion: 'synthetic', privacyPath: '/privacy' } }),
  })
}
export function Link({ to, search: query, children, ...props }: Omit<ComponentProps<'a'>, 'href'> & {
  to: string; search?: Record<string, string | undefined>; children: ReactNode
}) {
  const params = new URLSearchParams(Object.entries(query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return <a {...props} href={to + (params.size ? '?' + params : '')}>{children}</a>
}
export const useRuntimeDistribution = () => ({ isCloud: false })
export const useSession = () => ({ data: null, isPending: false })
export const getSignupConfiguration = async () => ({ signupMode: 'invite_only' })
export const authClient = {
  signIn: { email: async () => ({ error: { code: 'INVALID_CREDENTIALS', message: 'PRIVATE SYNTHETIC DETAIL' } }) },
  signUp: { email: async () => ({ error: { code: search().fixture === 'invalid-code' ? 'invite_invalid' : 'not_invited' } }) },
  requestPasswordReset: async () => ({ data: { status: true } }),
  resetPassword: async () => ({ data: { status: true } }),
}
