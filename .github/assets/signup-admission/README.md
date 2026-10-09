# Signup state evidence

Actual React components and existing UI primitives rendered in Chromium at 1440×1000 and
390×1000 CSS pixels, in DA/EN. Each state has four captures. `0-open` is the unchanged open
presentation, `1-default`, `1b-prefilled`, `2-blocked`, `2b-consent-error`, `3-invalid` and
`4-joined` cover the invitation flow. Synthetic admission/waitlist responses drive the states;
transactional API behavior is separately verified against disposable PostgreSQL. No real addresses,
customers, emails or OAuth credentials are used. Browser assertions check no horizontal overflow,
unticked consent, preserved payload and focus on invalid code/joined heading.

These captures use main's current typography and omit the separately pending wordmark styling.
Rebase with the wordmark change before combined visual acceptance; retain the optional form and
wider blocked card beneath the existing wordmark wrapper.
