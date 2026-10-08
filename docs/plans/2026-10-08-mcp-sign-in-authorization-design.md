# MCP sign-in authorization: discovery and prototype (issue #31)

Status: **prototype for review, off by default.** Nothing here is production support. While
`QUITS_MCP_OAUTH_PROTOTYPE` is unset, `/api/mcp` accepts only agent keys, exactly as before, and
every endpoint below answers `404`.

## Problem

Connecting an AI app today means creating an agent key and pasting a long-lived bearer secret into
the client's configuration. That is awkward, and it nudges people toward broad keys. Hosted AI apps
(claude.ai, ChatGPT) cannot take a custom header at all for most users. The goal is a sign-in
connection that keeps every server-side control agent keys already have: scopes intersected with
the owner's live role, `approval_required` gating, stale-review checks, revocation, and per-caller
idempotency receipts.

## Decision summary

1. **A connection is an agent key.** Consent creates an ordinary agent key (the "installation")
   with the mode and scopes the person chose. OAuth tokens authenticate to that key's agent actor.
   Approvals, receipts (`agent:<keyId>`), revocation, the creator-membership check and role
   intersection therefore run through the existing code unchanged. No new authorization path
   reaches `executeCommand`.
2. **Scopes are Quits permissions** (`invoice:read`, `invoice:send`, ...). The mode is chosen by
   the person on the consent page from presets; a client cannot request a mode. `agent:*` is never
   grantable.
3. **Registration:** Client ID Metadata Documents first, Dynamic Client Registration as a fallback
   that operators can turn off, public clients only (PKCE S256 + refresh-token rotation). No
   pre-registered clients in the prototype.
4. **Built-in authorization server on the app origin**, so self-hosters get the whole flow with no
   extra service. A token-verifier extension lets a deployment put its own issuer or gateway in
   front, but every token still resolves to a consented agent key.
5. **Bearer keys stay.** They are the compatibility path for any client that cannot do OAuth, and
   they behave exactly as before with the prototype on or off.

## Specifications checked (8 October 2026)

- MCP Authorization, revision **2026-07-28** (`/specification/latest/basic/authorization` and its
  sub-pages: authorization server discovery, client registration, security considerations). The
  installed `@modelcontextprotocol/sdk` 1.32.1 implements the 2025-11-25 revision; the
  differences relevant here (DCR deprecated in favour of CIMD, `iss` response parameter) are
  handled server-side.
- OAuth 2.1 (draft-ietf-oauth-v2-1-13), RFC 6750, RFC 7591, RFC 7009, RFC 8252 section 7.3,
  RFC 8414, RFC 8707, RFC 9207, RFC 9728, draft-ietf-oauth-client-id-metadata-document-00.

| Requirement (MCP 2026-07-28) | Prototype |
| --- | --- |
| Server MUST implement RFC 9728 PRM with `authorization_servers` | `/.well-known/oauth-protected-resource/api/mcp` and the root form; `401` carries `resource_metadata` |
| `scope` in the `401` challenge SHOULD guide least privilege; PRM `scopes_supported` is the minimal set | Both list the read-only set. `offline_access` is not in PRM (spec SHOULD NOT) but is in AS metadata so Claude asks for refresh |
| AS MUST offer RFC 8414 or OIDC discovery | RFC 8414 at `/.well-known/oauth-authorization-server`; issuer is the app origin with no path |
| PKCE S256, `code_challenge_methods_supported` present | Required; `plain` and missing challenges are refused |
| `resource` (RFC 8707) in authorize and token requests; server MUST validate audience | Authorize refuses a missing or foreign `resource` (`invalid_target`); every access token stores its resource and `/api/mcp` rejects a token for any other resource |
| Invalid/expired tokens → `401`; insufficient scope → `403` with `error="insufficient_scope"`, `scope`, `resource_metadata` | Implemented. All missing scopes for the call are sent in one challenge (one tool, one permission) |
| Clients and AS SHOULD support CIMD; DCR deprecated, MAY | CIMD on, DCR on by default, each switchable |
| AS MUST validate CIMD `client_id` equality, structure, redirect URIs; SHOULD guard SSRF, cache per HTTP headers | No redirects followed; at most 5 KiB retained for parsing, streaming cancellation on overflow; one 5 s deadline for DNS, fetch and body; non-public addresses refused, including canonical hexadecimal IPv4-mapped IPv6; cache 5 min to 24 h from `max-age` |
| AS MUST show redirect hostname; SHOULD warn for loopback-only redirects | Consent shows the return host, the client id and how the client identified itself, and a warning for loopback redirects |
| Exact redirect matching; loopback port-agnostic | Exact string match; for `http://localhost`, `127.0.0.1` and `[::1]` only the port is ignored, host/path/query must match |
| Redirect URIs only `https` or `localhost` | Enforced at DCR and CIMD validation and at authorize |
| AS SHOULD return `iss` (RFC 9207) and advertise it | `iss` on every redirect, success and error; `authorization_response_iss_parameter_supported: true` (needed for ChatGPT's stable callback) |
| Public clients: AS MUST rotate refresh tokens | Rotated on every use; reuse of a rotated token revokes the whole token family |
| Short-lived access tokens SHOULD | 15 minutes |
| No token passthrough; accept only own tokens | Opaque `quits_at_` tokens, hashed at rest; never forwarded |
| AS endpoints MUST be HTTPS | Configuration refuses a non-HTTPS issuer except `http://localhost`-style origins for local proofs |

## Client support matrix

Danish small-business usage data for AI assistants was not available to this research. The
targets were chosen from the competitor evidence in the research (HoneyBook, FreshBooks and others
ship Claude connectors; ChatGPT apps are the other mass-market surface) and general availability.
**Validating which assistants Danish target users actually use is still open.**

| Client | How it identifies itself | Redirect | Needs from Quits | Prototype status |
| --- | --- | --- | --- | --- |
| Claude Code | CIMD `https://claude.ai/oauth/claude-code-client-metadata` (public, refresh) | Loopback, random port: `http://localhost:<port>/callback` | Port-agnostic loopback match for `localhost` and `127.0.0.1`; CIMD only if AS lists `client_id_metadata_document_supported` **and** `none` | **Claude Code 2.1.293 connected locally** using its own discovery, CIMD and browser sign-in. CLI health showed Connected; Settings revocation changed it to Needs authentication. SDK profile tests remain as regression coverage |
| claude.ai, Claude Desktop, mobile, Cowork | CIMD (Anthropic-hosted) or DCR | `https://claude.ai/api/mcp/auth_callback` (may move to `claude.com`) | Public HTTPS server reachable from Anthropic's egress range; `401` to start; first `authorization_servers` entry only; 10 s discovery/token budget, 30 s for refresh; `invalid_grant` on dead refresh tokens | DCR path tested with the SDK client. **Not tested with the real hosted client**: it cannot reach a local server without a public HTTPS tunnel |
| ChatGPT (apps / connectors) | CIMD `https://chatgpt.com/oauth/client.json` (prefers `private_key_jwt`, accepts `none`), or DCR | Stable `https://chatgpt.com/connector_platform_oauth_redirect` when `iss` is supported, else `https://chatgpt.com/connector/oauth/{callback_id}` | `iss` on success and error; S256; `resource` copied into the token; no machine-to-machine grants | **Profile tested locally** by a raw-HTTP client written from the specs with the real metadata document as a fixture. Real ChatGPT not tested (needs a public HTTPS server and a developer-mode workspace). Quits authenticates it as a public client; `private_key_jwt` is not supported. ChatGPT's per-tool `_meta["mcp/www_authenticate"]` step-up is not implemented |
| Clients without OAuth, or stdio-only via `mcp-remote` | Agent key | none | `Authorization: Bearer quits_ak_...` | Unchanged; covered by the existing endpoint tests and one test with the prototype switched on |
| VS Code / GitHub Copilot, Cursor, Microsoft Copilot Studio | not researched | Cursor has used a custom-scheme redirect, which the MCP spec does not allow | | Unknown. Custom-scheme redirects are refused by design |

The profile tests complete without pasting a long-lived general-purpose key. A separate local
proof now covers the shipping Claude Code client. **The acceptance criterion requiring two
selected shipping clients remains partial**; profile fixtures do not count as a second client.

## Grant model

### Presets (consent page)

| Preset | Mode | Scopes (narrowed to the person's role) |
| --- | --- | --- |
| Read only | `read_only` | the read scopes of the "Read-only bookkeeper" key preset |
| Draft only | `approval_required` | reads + create/update contacts, invoices, quotes, agreements, deliverables. **No send, credit note or payment scope** |
| Draft, and send with approval | `approval_required` | the existing "Drafting assistant" key preset, including `invoice:send` |
| Full access | `full_access` | every scope the person holds except `agent:*` |

- The narrowest preset covering the client's requested scopes is preselected. Full access is never
  preselected, and approving it requires ticking a statement that the app can send documents,
  issue credit notes and record payments without approval.
- Approval never supplies a missing permission. A draft-only grant calling `invoice_send` gets
  `403 insufficient_scope` before the MCP server runs, and `executeCommand` would refuse it anyway
  (`actorCan` fails before approval gating). Commands queued for approval are re-authorized when
  approved, as the agent, with the owner's role at that moment.
- Consenting requires `agent:create`, the same permission as creating a key (admins by default).
  Whether members should be able to connect their own assistant is a **product decision left
  open**; it would need a separate owner model, not just a looser check.

### Lifecycle

| Event | Effect |
| --- | --- |
| Access token | 15 minutes, opaque, stored hashed, bound to resource, client, token family and agent key |
| Refresh | Rotated on every use; may narrow scopes, never widen (`invalid_scope`); the new token's scope is recomputed from the owner's current role, so a refresh cannot restore removed permissions |
| Refresh-token reuse | Revokes the token family (the attacker's and the legitimate client's tokens) |
| Authorization code | 5 minutes, single use, bound to client, redirect URI, PKCE challenge and resource; reuse revokes what it issued |
| Revoking the agent key (Settings, Agent keys) | Next MCP call `401`; refresh `invalid_grant`; pending approvals from the key expire (existing behaviour) |
| Owner removed from the organization | Same: calls `401`, refresh `invalid_grant`, approving queued work fails `Forbidden` |
| Owner demoted | Calls go on with only what the new role allows; queued work needing a lost permission fails when approved; refresh returns the reduced scope |
| Client revokes either token (RFC 7009) | Disconnects that installation: token family revoked, agent key revoked, pending approvals and their receipts expired. The key stays listed as revoked. An unrelated installation is unchanged |
| Re-consent (step-up) | Creates a second installation. Production should replace the earlier one for the same person, organization and client |

### Organization binding

The first consent render binds the request to the authenticated user, session id and active
organization. Each render gets a new random review id and a digest of the displayed client,
organization, requested scopes and role-filtered preset modes/scopes. Submission must present that
review id through the same session and organization, and the recomputed view must still match.
Another render invalidates the earlier review. The store compares and consumes the review
atomically, so concurrent decisions cannot create two installations. Changes fail closed and ask
the person to restart from the client. An organization picker remains future work.

Tokens carry no organization choice; the consented agent key fixes it. Switching organizations
in another browser tab after reading consent cannot change where that consent grants access.

## Settings flow

Today's prototype: connections appear in **Settings → Agent keys** with a "Connected app" badge,
the app name, the return host in the key column (`connector:claude.ai…`), the mode badge, the scope
count with the full scope list on hover, last use, and the existing **Revoke** action.

Proposed for production: a "Connected apps" section listing client name and verified host, how the
client identified itself, the person who connected it, the preset and full scope list, granted and
last-used dates, and Revoke (which ends the agent key, its token families and its pending
approvals together). Agent keys and connected apps stay in one list model so the approval inbox
keeps naming the agent the same way.

## Threat review

| Threat | Mitigation in the prototype | Residual / production work |
| --- | --- | --- |
| Authorization code interception/replay | PKCE S256; 5 min codes bound to redirect/client. Code consumption and family creation are atomic. Both stale concurrent reads and replays during live membership lookup revoke the winning family; token issuance checks revocation again | Durable storage must implement the atomic store contract transactionally |
| Open redirect / code sent to attacker | Client and redirect validated before any redirect; exact match; error page instead of redirect on mismatch | none |
| Localhost impersonation (any local process can bind the loopback port) | Loopback warning on consent; host shown | Inherent to native clients; MAY add attestation later |
| Consent phishing with a look-alike DCR client name | Consent says the name is self-asserted for DCR clients and shows the client id and return host | Production may restrict DCR or allowlist CIMD domains |
| SSRF via CIMD fetch | HTTPS only; `ipaddr.js` normalizes mapped IPv6 and rejects non-public addresses, with conservative exclusions for special-purpose ranges absent from its installed version. Every DNS answer must be public; no redirects; bounded streaming and a total deadline | DNS rebinding between check and fetch remains; production should pin the resolved address or use an egress proxy. Runtimes without a DNS lookup API need another guard |
| DCR abuse (unbounded registrations) | Field limits; switch to disable | Production needs rate limits and expiry of unused registrations |
| Token theft | Short access tokens, rotated refresh tokens with reuse detection, hashing at rest, `no-store` | Sender-constrained tokens (DPoP) not attempted |
| Token for another resource / confused deputy | `resource` required and validated at authorize, token, and every MCP call | none |
| Mix-up attacks | `iss` on all redirects; single issuer | none |
| Scope escalation by the client | Mode chosen by the person; scopes capped by role; refresh cannot widen; `agent:*` never grantable | none |
| Escalation by role change after consent | Role is read live on every call and at approval time | none |
| Duplicate execution | Receipts keyed per installation; refresh keeps the key; separate installations never share receipts | none |
| Consent changed in another tab/session | Random single-use request and review ids; first render binds user, session and organization; decision compares the displayed client/grant digest and atomically consumes that review | Production must preserve the same compare-and-consume contract in durable storage |
| Browser DNS rebinding against `/api/mcp` | Existing `Origin` check runs before authentication | none |
| In-memory prototype store | n/a | Single process only, lost on restart. Must become database tables before any deployment |

## Self-host configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `QUITS_MCP_OAUTH_PROTOTYPE` | `false` | Turns the prototype on. Requires a single app process |
| `QUITS_MCP_OAUTH_ISSUER` | `QUITS_APP_ORIGIN`, then `BETTER_AUTH_URL` | Public origin used as issuer; the MCP resource is `<issuer>/api/mcp`. Must be HTTPS except `localhost` |
| `QUITS_MCP_OAUTH_DYNAMIC_REGISTRATION` | `true` | Offer RFC 7591 registration |
| `QUITS_MCP_OAUTH_CLIENT_METADATA_DOCUMENTS` | `true` | Accept HTTPS URL client ids. Needs outbound HTTPS from the server |

`YAIP_`-prefixed names are read as fallbacks, as for every product variable. If the flag is on but the issuer is missing or not HTTPS, the prototype stays off and logs
`mcp_oauth.config_invalid`; agent keys keep working. Behind a reverse proxy,
the proxy must route `/.well-known/oauth-protected-resource*`,
`/.well-known/oauth-authorization-server`, `/api/mcp/oauth/*` and `/oauth/consent` to the app.
Hosted AI apps (claude.ai, ChatGPT) must reach the server from the internet; a server only reachable
on a LAN can still be used by local clients such as Claude Code.

### Local proof runbook

1. Start the app with `QUITS_MCP_OAUTH_PROTOTYPE=true QUITS_APP_ORIGIN=http://localhost:3000`.
2. `claude mcp add --transport http quits-local http://localhost:3000/api/mcp`, then run `/mcp` in
   Claude Code and choose to authenticate. A browser opens the Quits consent page.
3. For claude.ai or ChatGPT, expose the app on a public HTTPS hostname, set
   `QUITS_MCP_OAUTH_ISSUER` to it, and add `https://<host>/api/mcp` as a custom connector.

Claude Code 2.1.293 completed the local proof on 8 October 2026 against the HTTP loopback issuer
`http://127.0.0.1:4311`, with its own `http://localhost:54101/callback` redirect. Browser sign-in and
consent completed; the CLI reported Connected, then Needs authentication after Settings revocation.
The evidence is recorded below. Shipping claude.ai and ChatGPT connections remain unverified;
SDK and raw-HTTP profiles do not satisfy the required second selected shipping client.

## Extension contract (hosted issuer or gateway)

`apps/oss/src/domain/agent-oauth/extension.ts` (prototype, not yet exported from the package):

```ts
type McpAccessTokenGrant = { agentKeyId: string; scopes: string[]; clientId: string; resource: string }
type McpAccessTokenVerifier = (token: string, context: { resource: string; now: Date }) =>
  Promise<McpAccessTokenGrant | null>
setMcpAccessTokenVerifiers(verifiers: McpAccessTokenVerifier[]): void
```

A verifier is consulted only for bearer values that are neither agent keys nor built-in tokens.
Whatever it returns, the core still requires `resource` to equal this server, loads the agent key
as it is now (revoked, expired, departed owner → `401`) and narrows the key's scopes to the
token's. A verifier therefore cannot create authority; it can only map a token to a consented
installation. A deployment that uses its own issuer must also publish that issuer in protected
resource metadata (a configuration hook not yet added) and run consent that creates the
installation through the same core function.

Hosted-specific dependencies, all outside this repository: a persistent multi-instance store for
grants, the public issuer hostname and its TLS, an outbound fetch policy for metadata documents on
runtimes without DNS lookup, rate limiting on the registration, authorization and token
endpoints, and allowing the AI vendors' published egress ranges through any firewall in front of
discovery and token endpoints.

## Implementation plan (production, bounded)

1. **Schema.** Tables for registered clients, authorization codes, token families, refresh
   tokens and access tokens (all secrets hashed), plus `agent_key.kind` (`key` | `connection`) and
   `agent_key.oauthClientId`, replacing the `connector:` display-prefix marker. Migrations only add.
2. **Store.** A Prisma implementation of `McpOAuthStore`; transactional code and refresh rotation
   (`UPDATE ... WHERE rotatedAt IS NULL`); cleanup of expired rows on the scheduler tick.
3. **Consent.** Persist the prototype's session-bound review and digest checks; organization picker; replace an earlier
   installation of the same client for the same person and organization on step-up; Danish copy
   reviewed by a native speaker.
4. **Settings.** "Connected apps" section described above.
5. **Hardening.** Rate limits; DCR registration expiry; CIMD domain trust policy option; DNS
   pinning for metadata fetches; structured logs for grant, refresh, reuse detection and revocation.
6. **Client polish.** `_meta["mcp/www_authenticate"]` on refused tool calls for ChatGPT's
   step-up UI; optional `private_key_jwt` for ChatGPT's CIMD client.
7. **Verification.** Retain browser regression tests for login, consent, rejection, callback,
   organization changes and Settings revocation. Extend the local Claude Code evidence to a
   second selected shipping client and test claude.ai and ChatGPT against a public test deployment.
8. **Release.** Remove the prototype flag only after 1 to 7; document the sign-in path in
   `docs/agent-api.md` next to agent keys, which remain supported.

## What was tested

Automated, in `apps/oss/src/domain/agent-oauth/__tests__/` (database-backed tests use a disposable
PostgreSQL):

- Discovery documents, `401`/`403` challenges, and that everything is off while the flag is unset.
- Claude Code profile (MCP SDK client, CIMD, loopback random port), DCR profile (MCP SDK client),
  ChatGPT profile (raw HTTP, CIMD, `iss` checking).
- Draft-only grant: drafts succeed, `invoice_send` gets `403 insufficient_scope`, no approval is
  queued, refresh cannot add the scope.
- Approval-mode grant: `invoice_send` creates the approval item; editing after the request makes
  approval fail with `changed_since_review`; a fresh request then sends.
- Revocation, membership removal and demotion against live tokens, refresh and queued approvals.
- Redirect validation, foreign `resource`, PKCE method, ungrantable scopes, audience mismatch,
  access-token expiry, refresh rotation and reuse revocation, code replay, grant isolation and
  `clientRequestId` receipts across connections and across refresh, cross-organization reads,
  agent keys with the prototype on, and the extension verifier's limits.
- Unit tests for redirect matching, presets and scope parsing, CIMD validation, SSRF refusal and
  size limits, and DCR validation.

Browser regressions are in `tests/shared/mcp-oauth.spec.ts`. The shared disposable runner enables
the prototype only for its test app. It captures consent, stale-consent and Settings screenshots.
Round-2 verification also checks mapped IP literals and mixed DNS answers before fetch, early
stream cancellation, stalled DNS/body deadlines, both code-replay interleavings, authenticated
organization switching, and RFC 7009 disconnect with pending approvals.

The metadata parser retains at most 5 KiB. It rejects the first chunk that crosses that limit
and cancels the stream. The transport can deliver that crossing chunk and prefetch another;
5 KiB is not a claim that only 5 KiB can cross the socket or enter transport buffers. The parent
32 KiB probe now stops after two chunks read plus one prefetched, 12 KiB total produced. A test
stream with prefetch disabled stops at the second 4 KiB chunk. DNS lookup itself may finish after
the deadline because the platform lookup is not cancellable; the result cannot initiate a fetch.
DNS rebinding between validation and the network connection remains a deployment blocker.

RFC 7009 disconnect deliberately ends pending work, including when the owner has left the
organization. A supplied token hash and matching client id authorize only that installation's
revocation. Settings and client revocation both keep an auditable revoked key. Replay detection
ends the token family; it does not itself withdraw separately queued approvals. Those remain
subject to the live installation, owner-role and stale-review checks. Use disconnect or Settings
revocation to withdraw pending work.

On 8 October 2026, the installed **Claude Code 2.1.293** completed a local connection to
`http://127.0.0.1:4311/api/mcp`. Its `mcp login --no-browser` command generated the authorization
request using its real CIMD identity and opened a random-port localhost callback. Quits fetched
the metadata document from Anthropic. A browser signed in
to a disposable test organization and granted read-only access. The callback displayed
“Authentication successful”; the CLI reported that authentication succeeded and `mcp get`
showed “Connected.” Revoking the connection in Settings changed that same CLI check to
“Needs authentication.” No bearer key was pasted, no model was invoked and no vendor account
credentials were needed. The client configuration was isolated and deleted after verification.
This proves local HTTP issuer acceptance for that version, not hosted-client support.

Still unverified: shipping hosted Claude and ChatGPT clients, multi-process deployment and
performance under the clients' endpoint time budgets. Protocol fixtures do not prove client
support, and client selection still needs evidence from Danish target users. The verifier hook
remains non-exported and lacks an issuer-metadata override; a stable hosted contract is not yet
accepted. Keep hosted implementation queued pending review.
