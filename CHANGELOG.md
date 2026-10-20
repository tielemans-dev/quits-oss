# Changelog

## Unreleased

## [0.14.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.14.0)

Changes since the published v0.13.0 tag, covering 36 merged PRs.

- **Breaking runtime contract:** billing providers must return the server-resolved `organizationAccess` decision and explicit `access` billing capabilities. Writes are refused when the decision is missing. The trial hook now runs on every successful onboarding with a `cvrVerified` flag.
- Return safe, localized client errors for expected managed sending-domain rejections. Export the typed rejection contract for runtime providers; unexpected failures remain server errors.
- Restyle the app shell, sidebar, top bar, Overblik and Settings, with Settings split into its own pages.
- Grow the command palette out of the Overblik field: complete half-typed requests, open request cards for what is typed, and optionally read whole sentences with a decision model when the operator configures one.
- Report whether email delivery is configured, refuse email jobs without delivery configuration, and run scheduler ticks during local development.
- Refresh document lists, details, Settings and financial panels after changes.
- Adopt the Vite+ toolchain and pin the Nitro build dependency.

See the [release notes](docs/releases/v0.14.0.md) for upgrade requirements.

[Compare with v0.13.0](https://github.com/tielemans-dev/quits-oss/compare/v0.13.0...v0.14.0).

## [0.13.0](https://github.com/tielemans-dev/quits-oss/releases/tag/v0.13.0)

Changes since the published v0.12.4 tag, covering 39 merged PRs.

- Add manual purchase VAT entries for reporting periods.
- Add e-conomic and Dinero payload mapping, accounting connection and mapping Settings, scheduled delivery through injectable transports, and delivery safeguards.
- Localize built-in fixed-price and milestone agreement templates in Danish and English.
- Add seller SE numbers and Danish VAT exemption and reverse-charge explanations to documents.
- Add an eight-second command-bar undo action and persist repeat-invoice send actions.
- Improve form validation, accessibility, mobile layouts, document colors and shared motion timings.
- Repair CI and test fixtures, and add nightly visual, accessibility and design reports.

See the [release notes](docs/releases/v0.13.0.md) for upgrade requirements and accounting integration limits.

[Compare with v0.12.4](https://github.com/tielemans-dev/quits-oss/compare/v0.12.4...v0.13.0).
