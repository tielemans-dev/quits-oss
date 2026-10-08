import { createAuthClient } from "better-auth/react"
import { organizationClient } from "better-auth/client/plugins"
import { invalidateAppLayoutSession } from "./app-layout-session"
import { ac, admin, member, accountant } from "./permissions"

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      ac,
      roles: { admin, member, accountant },
    }),
  ],
})

export const { signIn, signUp, signOut, useSession } = authClient

// better-auth flips this signal after every sign-in, sign-up, sign-out, user update and session
// revocation made through this client. Whatever caused it, the layout's cached answer may now name
// the wrong user, so drop it. Browser only: the layout cache does not exist on the server.
if (!import.meta.env.SSR) {
  // A subscription reports the current value straight away; only later changes are news.
  let initial = true
  authClient.$store.listen("$sessionSignal", () => {
    if (initial) {
      initial = false
      return
    }
    invalidateAppLayoutSession()
  })
}
