# Event envelope and consumers

Every persisted domain event has a positive `schemaVersion`. Existing events are v1. A payload
shape never changes without a version bump, including additions and removals of fields. The
registry in `apps/oss/src/domain/events/registry.ts` describes the serialized payloads written
by today's emitters. The writer validates after JSON serialization and preserves that value.

To add an event type, add its version and strict Zod schema to the registry, then add a serialized
fixture under `events/__tests__/fixtures/`. Reconstruct the actual emitter's payload expression in
the inventory tests, including conditional variants. Only persisted open JSON should have an open
schema. The command pipeline uses a test-only registration hook guarded by `NODE_ENV=test`; test
events are absent from the production registry.

`upcastEvent` leaves current events unchanged. When introducing a later version, add a pure,
total N-to-N+1 transform for that type. Unsupported versions and missing transforms throw
`UnsupportedEventVersion`. A sparse historical event must never acquire facts that were not
recorded. Upcasting does not make existing v1 money events sufficient for posting.

## Consumer lifecycle

Each organization and consumer key has separate scanned and acknowledged positions:

1. Call `scan` with the consumer's interested types and a bounded limit. It reads the log in
   sequence order without a type filter, persists interested events as `pending` and others as
   `skipped`, then advances `scannedSequence`. Existing deliveries keep their id and state.
2. Call `claim` with a limit, lease duration and current time. It claims pending or expired claimed
   deliveries in order. Each claim gets a fresh token and increments attempts.
3. Use the delivery row's **id as the remote idempotency key**, on every attempt. If a process
   crashes after remote success, look up that id remotely before repeating the side effect. A
   provider without idempotency or lookup cannot guarantee once-only external delivery.
4. Call `complete` with the delivery id, claim token and external reference, or `fail` with the id,
   token and JSON error. Both fence every write by the token. `{ fenced: true }` means the worker
   no longer owns the row and must stop. Failed deliveries require explicit operator recovery;
   `claim` does not silently retry them.
5. Call `advance`. It acknowledges only a contiguous run of `done` or `skipped` rows. A gap,
   pending, claimed or failed row stops it even when later deliveries succeeded.

Scan and advance run in transactions and compare-and-set the cursor's `version` with
`updateMany`, checking the count. `EventConsumerCursorConflict` means retry the whole transaction.
When passing a transaction client, let that error escape so the enclosing transaction rolls back.
Callers must not catch it inside the same transaction and commit partial work.

`readEvents` is an ordered reader with optional type filtering and opt-in upcasting. It returns
`schemaVersion`, as do the domain activity reader, export activity reader and agent activity tool.
Filtered reads do not drive consumer cursors. All-skipped tails still advance through `scan` and
`advance`.

The v1 inventory preserves existing differences: invoice creation can include `quoteId`; sent
payloads can omit `emailSent`; credit note re-email uses `credit_note.sent`; agreement acceptance
has internal and customer-link variants; manual offer issuance can have a null recipient; reminder skips have command and delivery variants; and
`deliverable.updated` can include prior acceptance. Money fields retain their current numeric or
string representation. Recurring failure events carry structured command errors. No document payload or user-visible behavior changes in this phase.

## A3b money facts

`invoice.issued` v1 freezes the issuance candidate's dates, inputs, parties, valued VAT groups,
reporting-only VAT data, artifact identities and origin references. `Money.minor` is an integer
string. Group and total components reuse the pricing contracts' decimal strings in major units;
`currency`, `exponent` and `baseExponent` identify their units. Consumers must convert those
components at the declared exponent. Signed components, including negative derived base net,
are preserved. No positions or posting function are introduced here.

`credit_note.issued` v2 records the credited portion and cumulative entitlement against frozen
invoice groups. Its Phase A discharge is known only for an unpaid sale with sufficient open
balance after prior credits and no advance or deposit application. Payment-linked credits have
`allocationsReleased: null` and `postable: false`; an empty array would claim reconciliation that
has not happened. v1 upcasts add only `postable: false` and
`incompleteReason: historical_payload_incomplete`. The original v1 fixtures remain unchanged.

`invoice.base_valuation_recorded` v1 adds a human-reviewed historical rate and groups. It does
not rewrite historical events, amounts, artifacts or supply dates, and it does not manufacture an
`invoice.issued` event. Issued documents without reviewed valuation remain `unknown` even when
invoice and base currency coincide.

All new issuance requires `RuntimeServices.documentRenderer` and
`RuntimeServices.documentArtifactStore`. The self-host entry supplies both. Cloud consumers must
supply both adapters before upgrading. Issued PDF and UBL downloads verify stored bytes against
the frozen hash; missing bytes or missing artifacts refuse. Draft PDF previews render live.
