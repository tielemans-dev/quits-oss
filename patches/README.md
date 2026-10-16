# Dependency patches

The pinned Nitro nightly throws when a Vite environment takes longer than its
3.1-second grace period to initialize. Its worker traps the rejection without
completing the HTTP response. Playwright's readiness GET then hangs until the
entire webServer startup times out, even if the environment becomes ready.

The node-runner patch returns Nitro's existing error response instead, so the
probe receives HTTP 503 and can retry. Keep this patch until an upstream version
passes `node --test scripts/__tests__/nitro-vite-readiness.test.mjs` without it.
