# Runtime operation policy

A distribution may inject `RuntimeServices.operationPolicy`. The default is absent, so self-host
behavior remains unchanged. This policy can restrict an authenticated organization operation;
it cannot grant actor permissions or select another organization.

`authorize(operation)` returns `{ allowed: true }` or `{ allowed: false, message }`.
The operation contains organizationId, kind, name, parsed command input or job payload,
actorKind and phase. Commands call it before issuance preparation and again inside the command
transaction immediately before execution. Jobs call it after claiming and before their handler.
Authorized organization mutations outside commands also call it after ordinary membership and
permission checks. Queries, public document reads and exports retain their existing authorization.

A command policy refusal has code `operation_not_allowed`. It leaves no failed idempotency receipt
for a new request, so the same request can succeed after policy recovery. Recurring generation stops
without advancing or pausing the schedule. Refused jobs return to pending, retain their retry budget
and defer using the existing job polling backoff. An unexpected policy exception fails closed.

Policies must distinguish jobs for new work from delivery/reconciliation of existing documents.
They must not blanket refuse reminders or suppress completion of uncertain external effects.
The hook runs at the execution boundary rather than filtering organizations once at tick start.
It does not hold a distribution's authorization state stable throughout a long external call.

Billing providers may return optional `BillingSubscription.access` presentation flags. A paid-only
view omits the legacy free-plan offer and uses the existing localized Checkout/Portal actions.
Activation feedback requires the server subscription to be active; a success URL cannot grant access.
The server must still enforce every operation. This view does not supply commercial copy or prices.

Admission to account creation is independent and belongs to the authentication extension contract.
Invoice validity policies remain independent of this authorization policy.
