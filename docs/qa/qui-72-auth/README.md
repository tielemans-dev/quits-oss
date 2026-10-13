# QUI-72 / QUI-73 auth evidence

These captures show the actual OSS login, forgot-password, signup and reset-password route components, shared header, catalogs, app stylesheet and loaded local Geist fonts. The browser used 1440×900 and 390×844 CSS viewports. T3 saves desktop captures at 1280×800 and mobile captures at 780×1688; the recorded layout measurements are CSS pixels. Every captured form had no horizontal overflow.

SYNTHETIC FIXTURE: the test-only harness in `apps/oss/tests/visual/auth/` replaces router boot, signup configuration and auth responses. The forms and their state transitions are real components. Emails, invitation codes and reset tokens are synthetic. These captures verify presentation and client behavior; they do not prove database admission, reset-token delivery or full-app SSR. No accounts, mail, payments or production data were used.

## Form captures for Ines

| Screen | DA desktop | EN desktop | DA 390px | EN 390px |
| --- | --- | --- | --- | --- |
| Login | [DA](screenshots/login-da-1440.png) | [EN](screenshots/login-en-1440.png) | [DA](screenshots/login-da-390.png) | [EN](screenshots/login-en-390.png) |
| Forgot password | [DA](screenshots/forgot-password-da-1440.png) | [EN](screenshots/forgot-password-en-1440.png) | [DA](screenshots/forgot-password-da-390.png) | [EN](screenshots/forgot-password-en-390.png) |
| Signup | [DA](screenshots/signup-da-1440.png) | [EN](screenshots/signup-en-1440.png) | [DA](screenshots/signup-da-390.png) | [EN](screenshots/signup-en-390.png) |
| Reset password | [DA](screenshots/reset-password-da-1440.png) | [EN](screenshots/reset-password-en-1440.png) | [DA](screenshots/reset-password-da-390.png) | [EN](screenshots/reset-password-en-390.png) |

## Interaction states

- Forgot confirmation interpolates the email and uses the approved neutral copy: [DA](screenshots/forgot-confirmation-da-390.png), [EN](screenshots/forgot-confirmation-en-390.png).
- Invalid invite code uses the approved error, focuses the code field and displays uppercase. Its stored value remains unchanged until the existing submission normalization: [EN](screenshots/signup-invalid-code-en-390.png).
- Blocked signup stays light with a stored dark preference, using the existing theme seam. Measured background is `rgb(250, 250, 249)`, with no dark class or horizontal overflow: [DA](screenshots/signup-blocked-da-390-dark-preference.png), [EN](screenshots/signup-blocked-en-390-dark-preference.png).

The new full-app Playwright auth locale scenarios cover both languages and viewports, recovery/signup links, return-target preservation, password attributes and reset language toggling. They require the existing disposable database setup and remain assigned to CI.

## Verification and ownership

Required repository lint and full typecheck passed. The repository test command passed with one worker per Vitest pool and serialized Turbo tasks. OSS reported 1,969 passing tests, 1,029 skipped tests in the normal suite and seven skipped global tests. Database-backed tests were skipped because no disposable database was configured. All 207 final affected regressions passed in 10 files with one worker. They also cover the consumed reset token being removed from language links.

The shared `pdf.paymentReference` catalog seam now says Betalingsbesked / Payment message. Existing public invoice, PDF and Settings preview tests verify the new label while retaining their amount, VAT and reference-value assertions. Money and admission behavior are unchanged.

The small QUI-5 signup-light and uppercase-code follow-ups are included. VPS QUI-5 work remains with its existing owner. Seller VAT confirmation belongs in authenticated onboarding/Settings through the separately owned OSS extension and release; this PR does not implement that flow or change a Cloud dependency.

The owned Fleet/Vite evidence server was stopped with SIGINT after captures. Ines approval and new-head CI are required before READY-FOR-KAI. Kai owns the Codex request. No new issue, schedule, merge, deployment or release is part of this task.

## Maintenance against merged login return contract

On 2026-10-13, main at `f610c11f06d97c8291e818596592275280aae222` was integrated into the published branch with a merge, preserving its history. Login retains AuthPage, its header and approved copy. The auth navigation helper now delegates validation and destination construction to `login-return.ts`, so recovery/signup links honor `next` precedence and retain exact query encoding. Login and onboarding retain the merged explicit return/language contract and the existing defaults when no target or language is supplied.

The 21 screenshots and capture metrics above are historical evidence from the original #142 implementation, included at `4da65c06528d6f737acbdf55bd7a8b22786971d8`. They were not refreshed for this maintenance because the AuthPage layout and approved copy did not materially change. They do not establish current-head browser or onboarding behavior.

Maintenance validation passed with one Vitest worker through Fleet: 241 tests in the initial 13-file auth/login/onboarding/redirect/copy run, then 108 tests in six files including the final 76-case login-return suite and session/SSR locale regressions. These runs cover 274 distinct tests in 18 files. Application typecheck and scoped lint passed. All eight targeted login-return/auth-locale Playwright scenarios collected successfully. Full repository lint/typecheck, suites, build and actual browser execution remain current-head CI gates. No disposable database or browser base URL was configured locally. Ines approval remains required, and Kai owns the exact-head Codex request after CI is green. This maintenance does not establish READY.
