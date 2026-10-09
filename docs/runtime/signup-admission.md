# Signup admission extensions

Self-host signup stays open when `SIGNUP_MODE` is unset and no admission hook is supplied.
`SIGNUP_MODE=invite_only` loads the invitation presentation from the server. An explicit
restricted mode without an admission policy denies account creation. Unknown nonempty values
also fail closed. The browser's mode never authorizes account creation.

`AuthHooks`, exported from `@quits/oss/runtime/auth-config`, has these optional additions:

```ts
authorizeSignUp(input: {
  email: string
  inviteCode?: string
  request?: Request
}): Promise<
  | { ok: true; consumeInvite?: (transaction: Prisma.TransactionClient) => Promise<void> }
  | { ok: false; code: "not_invited" | "invite_invalid" | "rate_limited"; retryAfter?: number }
>
admitSignUpAttempt?(input: SignupInput): Promise<SignupDecision>
signupWaitlist?: { privacyVersion: string; privacyPath?: string }
```

Admission runs before the email endpoint looks up an account and at every auth adapter user
insert, including internal and OAuth creation. Emails are trimmed and lowercased; codes have
whitespace removed and are uppercased. Better Auth 1.5.4 preserves the extra `inviteCode` body
field. The UI supplies it through the client's typed fetch-options `body`. `x-quits-invite` is
also supported when no string body code is present. No code validation happens during load;
links contain the code alone. The login signup link remains available.

The authorization hook is read-only. It may be called twice, so it must not consume or count
attempts. Put per-client/per-email rate admission in `admitSignUpAttempt`, using authenticated
connection metadata. Email attempts call it before account lookup; other creation paths call it
before admission. Denial returns stable `not_invited`, `invite_invalid`, or `rate_limited` codes;
rate denial includes `Retry-After`. Use `assertSignupDecision` to raise a typed denial from the
consumption callback. These hooks grant account admission only, with no organization entitlement.

For one-use admission, return `consumeInvite(transaction)`. It must use that exact transaction
client for every read/write, recheck email binding, expiry, revocation and unused status, and claim
one use atomically. Expiry must use the current wall clock at consumption, rather than the
transaction-start timestamp when password hashing took time. A lost claim must throw `invite_invalid`. Do not close over another database
client, send email, or start an independent transaction. An external store cannot participate in
this database transaction. An allowlisted address can return `{ ok: true }` without a callback.

The wrapper uses an explicit Prisma transaction and creates a Better Auth adapter against its
client. Native email signup and `createOAuthUser` already call `runWithTransaction`; the wrapper
binds their user/account/session operations to that client. A standalone adapter user insert also
starts a protected transaction. Consumption and insertion therefore roll back together on insert
or COMMIT failure. A custom database adapter must supply `createTransactionDatabaseAdapter`
that binds all queries to the supplied transaction, including session reads. The default uses
the ordinary Prisma adapter. Do not replace this with a no-argument consumption callback or a
post-commit database hook. Better Auth 1.5.4 queues its create-after hooks after transactions.

The installation administrator path also runs admission before lookup and consumes within its
existing setup transaction when a policy is configured. Ordinary installation setup stays open;
hosted setup already rejects all installation initialization requests.

Existing social logins do not create a user and remain available. OAuth creation is protected
at insertion even if the provider obtains the email only during its callback. Providers may
translate an admission exception into their native OAuth error/redirect. The email form's typed
errors are preserved; no external provider or live OAuth credentials are used in the tests.

The optional waitlist UI always posts to `/api/waitlist` on the same origin. OSS installs no
waitlist endpoint, table or sender. The runtime supplies the consent version shared with its
endpoint/privacy page and may supply a same-origin privacy path, default `/privacy`. The form
sends `note: ""`, `source: "app-signup"`, page locale, honeypot, explicit consent and that version.
Consent starts unticked. Without waitlist configuration the blocked panel offers code/login and
self-host links, without a form. Final DA/EN invitation strings are preserved in the catalogs.

## Integration and release gates

The consuming runtime must implement allowlist/invite storage, code generation/hash verification,
atomic conditional consumption, and a shared per-client/per-email rate limiter. An allowlisted
address wins over an invalid code. Expired, revoked, unknown, used and wrong-email codes must all
return `invite_invalid`. Test that adapter factories and operational tables use the same database
transaction and that callback revocation races cannot consume a grant incorrectly.

Wire `signupWaitlist.privacyVersion` from the same consent constant as the same-origin endpoint
and privacy page. Deploy both hosts with that endpoint and set `SIGNUP_MODE=invite_only` only after
the released extension is installed and tested. A published release and adoption are separate
approval gates; this prerequisite does not publish an artifact or alter a consuming dependency.
