# Tell Quits what you did

Discovery for [#86](https://github.com/tielemans-dev/quits-oss/issues/86), checked 8 October 2026. This is a proposal with offline examples. It does not implement capture, parsing, billing, a provider integration or a screen.

Keep deterministic typed capture available to self-hosters. Test a cloud voice and structured-extraction option behind real subscription checks, after the privacy and accuracy gates below. Start with a bounded organization allowance; the estimated provider cost alone does not justify a separate tier. A higher tier needs evidence of customer value and the cost of supporting heavy use.

The result should be a customer-grouped work log with unresolved items, corrections and reviewed draft proposals. A captured statement is neither accepted work nor permission to invoice. Nothing in this flow sends, issues, charges, contacts a customer or accepts an agreement. An invoice proposal retains a null number. Issued financial values and artifacts stay frozen.

## Evidence and access

All external links below were checked on 2026-10-08. Dates shown on product pages describe those pages, not the date of this research. First-party help documents establish documented behavior, not a tested backend guarantee. No competitor account was opened or changed. Mobbin supplied archived screenshots, not a live product session. All work and customer examples here are synthetic.

The OSS baseline is [d81e67902ab98c2c7ac7340444ba5a54da6255d4](https://github.com/tielemans-dev/quits-oss/tree/d81e67902ab98c2c7ac7340444ba5a54da6255d4). Read-only source inspection established the reservation and extension facts below. K5 was supplied separately as an approved source snapshot; it is not on this baseline. No private hosted source was read or copied.

Current-main integration was checked on 2026-10-09 at [8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8](https://github.com/tielemans-dev/quits-oss/tree/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8). Main includes merged #96 [draft revisions and stable line keys](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/docs/agent-api.md#L289), #99 [buyer-supplied PO metadata](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/packages/contracts/src/invoices.ts#L63) and #72 [settlements separating funding from debt allocations](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/docs/architecture/settlement-receipts.md#L15). The [billable kinds](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/packages/contracts/src/billing.ts#L25) and managed capability/subscription contracts linked below are unchanged from the original baseline. Final K5, the #52 source adapter and supported #69 preview remain unavailable for runtime integration. Merged #76 [project association](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/docs/plans/2026-10-08-project-association-discovery-decision.md#L7) and #78 [retainer decisions](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/docs/plans/2026-10-08-retainer-model-decision.md#L10) keep reporting, capacity/fixed fees and monetary funding separate from captured work. These decisions add no work-log runtime; the original research date and source pins remain historical evidence.

### Capture and invoice-review comparison

| Product and evidence | Capture and matching | Correction and grouping | Duplicate and invoice boundary |
| --- | --- | --- | --- |
| [Invoice Ninja tasks](https://invoiceninja.github.io/docs/user-guide/tasks), first-party help | Timer or manual dated sessions; user selects client/project. A project supplies its client and rate, with documented rate fallback. | Edit task/session details. Tasks have client and project links; uninvoiced project tasks can be brought into an invoice. | Documented task-to-invoice link and invoiced state; deleting an invoice releases the task. No verified cross-channel content deduplication or concurrent-allocation guarantee. |
| [Clockify invoicing](https://clockify.me/help/projects/invoicing-tracked-time-expenses), first-party help | Import tracked time and expenses for a chosen client and period. | Detailed entries or grouped invoice display. User can inspect imported entries. | Imported entries become invoiced; deleting the invoice restores uninvoiced state. [Troubleshooting](https://clockify.me/help/troubleshooting/rate-issues/time-entries-not-importing) says an entry can be invoiced once. This is a product claim, not a database audit. |
| [Harvest locks](https://support.getharvest.com/hc/en-us/articles/4408204890381-Unlocking-invoiced-time-and-expenses), first-party help | Time/expenses pulled into invoices retain project identity. | Invoiced entries and the covered project period lock; editing requires marking entries uninvoiced. [Bulk editing](https://support.getharvest.com/hc/en-us/articles/360048687671-How-to-bulk-edit-time-entries) supports moving uninvoiced work. | Locked entries reduce accidental changes. [Invoice editing](https://support.getharvest.com/hc/en-us/articles/360048181012-Editing-and-deleting-invoices-and-estimates) documents differences between invoice edits and time records. No inspected guarantee for duplicate forwarded mail. |
| [Timely AutoSheet](https://www.timely.com/help/handbook/autosheet/timely-autosheet/), first-party help | Memory/integrations produce proposed entries. It can match integration work codes; this differs from resolving an ambiguous customer name. | Entry editor changes project, tags and AI notes; save/cancel are explicit. Documented manual overlap prevention and merging of adjacent matching entries are timeline behavior. | [Privacy page](https://www.timely.com/privacy/) says AI timesheet entries need review before sharing. This does not establish Quits-style invoice reservations or duplicate-source identity. |
| [Bonsai starting time tracking](https://mobbin.com/flows/d421b6de-84fd-4668-8279-10eb9613a5cf), Mobbin screenshots | Observed a project picker with client names, a date field, timer and description field. | Observed an active timer and a saved entry with client, project and duration. | Screens do not prove rate provenance, server-side deduplication, invoice immutability or concurrent writes. Those remain unverified. |

Mobbin searches also returned [Bonsai unbilled time](https://mobbin.com/flows/f1fb34d9-bb05-4b67-83ff-4a4100cfa33b), [Midday tracker](https://mobbin.com/flows/3fa70981-f667-4900-833d-09ecdb70be93) and [Square invoice preview](https://mobbin.com/flows/494475e6-5a98-43ed-a245-046e06678eee). These are reference leads only; their complete flows were not inspected. Bonsai's displayed example dates were February 2024. Mobbin did not establish a capture date or current-version match. No screenshots are redistributed in this PR.

Inference for Quits: make client assignment and correction explicit, retain an entry-to-draft link, and explain the difference between reserved and invoiced. A timer, continuous activity monitoring and automatic customer matching are not prerequisites. No reviewed source establishes that voice capture is more useful than a short text form for Quits customers.

## Existing contracts and dependencies

[#73](https://github.com/tielemans-dev/quits-oss/pull/73) and [#80](https://github.com/tielemans-dev/quits-oss/pull/80) are on the baseline. The current [billable contract](https://github.com/tielemans-dev/quits-oss/blob/d81e67902ab98c2c7ac7340444ba5a54da6255d4/packages/contracts/src/billing.ts) accepts only `deliverable`. `time_entry` and `expense` are reserved names, not implemented adapters. [Billable documentation](../billable-work.md) specifies transaction-bound reservation, unique source/generation identity, frozen line values and revision, and explicit reviewed release identity.

[#52](https://github.com/tielemans-dev/quits-oss/issues/52) remains a future source-adapter and reconciliation dependency. This discovery does not complete that importer or its pilot. Work included in a fixed fee/retainer must remain separate from hourly charges and reimbursable expenses. Capturing more hours does not expand accepted scope or create a new hourly entitlement.

[#69](https://github.com/tielemans-dev/quits-oss/pull/69) was inspected at `4831a8a430ee20e21156c4d9fbf831d5479bbbd0`, unmerged at research time. Its [validation notes](https://github.com/tielemans-dev/quits-oss/blob/4831a8a430ee20e21156c4d9fbf831d5479bbbd0/docs/consequence-preview-validation.md) require stale-review refusal and distinguish drafts, issuance, messages and manual steps. Its moderated comprehension study is still outstanding. A future work-log action needs its own supported preview; this proposal does not assert that #69 already supports it.

### K5 source inspection

Inspected approved OSS snapshot `91036b1de8a4f05ef8847238a1b355b99b4f8cf0`, branch `feat/command-parser`, while its final review was running. The public remote did not expose that branch when checked. These are pinned source findings, not a claim that a reviewed public dependency has landed. Final accepted/public SHA and any subsequent contract changes remain an integration gate.

Files inspected were `packages/shared/src/commands/parse.ts`, `packages/contracts/src/commands.ts`, `apps/oss/src/trpc/routers/commands.ts` and `apps/oss/src/lib/commands/suggest-draft.ts`. The `@quits/shared/commands` export and these contracts are absent from this discovery's main baseline.

- `parseCommand(input, context)` returns `ParsedCommand | null`. Context supplies authorized customer and catalog candidates. It emits one customer/candidate list and one line, not a batch of customers or dated work entries.
- The parser bounds input to 200 characters and 30 tokens. It reads Danish/English quantity words, unit aliases, price markers and customer name/CVR matches. It retains notes such as `unparsed_text`, `unparsed_number`, `price_conflict`, `ambiguous_number` and `input_truncated`.
- `ParsedCommand` includes `kind`, `customer`, `candidates`, `line`, `confidence`, `missing` and `notes`. The line records field sources. Quantity may default to `"1"`; price may come from catalog context.
- `DraftSuggestion` adds terms, price basis, currency, remembered document/line fallback and nullable `submit`. The server queries bounded organization context and readable issued history, then may suggest `invoices.createV2` or `quotes.createV2`. It requires the relevant create permission plus contact/catalog read permissions.

Do not call the single-line parser once on an entire paragraph: later work can be truncated or folded into the first suggestion. A future OSS wrapper should split explicit newline boundaries, preserve exact source spans, bound the total input, and call K5 once per supported work clause. It must retain every note and reject truncation. Do not split on commas in Danish decimal quantities. Do not carry a customer or price from the previous line. Unsupported prose stays available for manual correction.

The wrapper needs an explicit date and billing classification that K5 does not currently return. Default quantity `1`, previous-document prices, tax settings and high confidence must not make work accepted or invoice-ready. Offer provenance-labelled values for selection and confirmation. Do not execute `DraftSuggestion.submit` during extraction. No K5 API is copied, monkey-patched or extended here.

## Proposed model and lifecycle

These are proposed records, not current Prisma models or published contract additions.

| Record | Required identity and evidence | State and purpose |
| --- | --- | --- |
| Capture source | Organization, immutable source ID, kind, scoped external key, exact content digest, actor, captured time/timezone, original timestamp and source metadata | Text uses a generated submission key that survives retries. Voice uses an upload key and audio digest. Mail uses receiving mailbox/provider message identity; original Message-ID is advisory, not trusted or globally unique. |
| Extraction attempt | Source ID/revision, parser/model identifier and version, locale, attempt ID, bounded input digest, per-field source span, structured result, validation errors | Attempts are candidates only. Keep failed and superseded attempts distinguishable. Neither a repeated attempt nor a different model creates more billable work automatically. |
| Work entry | Immutable organization-scoped ID, source links, candidate description/date/quantity/unit, revision, candidate customers, explicit assigned customer, billing classification | `needs_review`, `confirmed`, `excluded` or `superseded` describe review, independently of allocation. Missing price/tax/customer/date stays unresolved. A correction creates revision history and invalidates confirmation. |
| Commercial decision | Authorized rate/catalog/agreement reference and revision, explicit quantity/unit, price, currency, tax treatment, price basis, human actor/time | Selection and confirmation determine billability. Do not infer CVR, bank, tax exemption, reverse charge or a price from prose. Required document facts must come from authorized validated records. |
| Allocation and line | Work-entry identity, source revision, generation, fresh allocation identity, holder invoice and line IDs; frozen commercial values; back-link to capture source and reviewed decision | A fresh allocation identity is proposed here, not a current published contract field. Future adapter follows the existing allocation contract and must also prevent retired confirmations from matching replacements. A line points to confirmed work, which points to evidence. Do not assign `deliverable` to unrelated work merely to call existing commands. |

An exact external-key replay returns the existing source. Changed bytes under the same key create a source-change review, never overwrite a confirmed entry. A matching content digest with another text/upload/mail key is a duplicate candidate, not proof of duplication. Two identical work descriptions can be legitimate separate days. Require a person to choose duplicate-of, distinct-work or correction with a reason; retain both source identities. Strip mail quoting for comparison only, retain the source and offsets. Cross-channel near matches are suggestions, never silent merging.

After confirmation, the future adapter must reserve the work and insert draft lines in the same database transaction. Compare expected entry revision and allocation state; enforce a unique source-kind/source-ID/generation key. Two operators cannot both consume one generation. A replay should return the original result or a visible holder conflict. Database race tests are required later; the in-memory prototype does not prove SQL behavior.

Corrections to unreserved entries create a new revision and require review. Bind confirmation to a retained snapshot of the work revision, source digest, selected customer and commercial facts. Before reservation, compare the current facts with that snapshot; changes invalidate confirmation and require another explicit review. A missing price or tax treatment still blocks that review. Copy the reviewed values into the line rather than reading mutable catalog values as its price.

A changed reserved entry shows a conflict; release the reviewed draft line before changing and reserving again. Current main's [release](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/apps/oss/src/domain/commands/billing-allocation.ts#L30) checks the reviewed invoice ID, invoice-item ID and generation, and increments `editRevision`. Its [input contract](https://github.com/tielemans-dev/quits-oss/blob/8d7740eb9abcbae07a5db8e8969c6c1edecd6ec8/packages/contracts/src/billing.ts#L41) accepts no `expectedRevision`; current release does not detect every unrelated draft edit. Future work-log confirmation must also bind the reviewed draft revision and proposed fresh allocation identity. Reuse merged revision support where available; any missing release input needs separate reviewed implementation. A stable line `clientKey` is not allocation identity. Releasing and re-reserving even the same draft and line IDs cannot make an old release confirmation valid again. The proposed allocation identity changes on every reservation; generation remains the existing rebill counter and does not advance on ordinary draft release. A production adapter needs persistent identities across restarts. Respect draft-send locks, permissions and the existing empty-draft issuance refusal. Keep the empty draft available with `number: null`.

Issued, partly credited and credited work remains consumed. A credit never reopens it automatically. #80 requires a human rebill decision with the exact reviewed issued, line-linked credit set covering the full line, accepted agreement, reason and next generation. Equivalent work-entry rebill rules need explicit future design; this prototype has no rebill or issuance action. Never rewrite source revisions on historical lines where the billed revision cannot be established.

Group proposals by explicit customer ID, currency, compatible tax/price basis and month. Do not combine customers that happen to share a name. Month-end means a reviewable proposal, not a scheduler or an automatic invoice. Multi-entry proposals need atomicity or explicit per-entry outcomes; the example implements only single-entry reservation.

## Deterministic and structured-extraction prototypes

[prototype.mjs](evidence/2026-10-08-work-log/prototype.mjs) is dependency-free and isolated under docs. It uses an intentionally strict notation to test the review model before K5 integration:

```text
Alpha | 2026-10-08 | 2 h | Design
Beta | 2026-10-08 | 1,5 h | Testing
Unknown | 2026-10-08 | 1 h | Advice
Nord | 2026-10-08 | 1 h | Meeting
```

Expected output is four candidates with source spans. Alpha has one matching customer candidate, Beta another, Unknown none and Nord two. Even a unique name remains unassigned until explicit selection. Alpha is corrected to three hours; the original two-hour revision remains in history. A synthetic authorized 800 DKK hourly rate and reviewed tax treatment are supplied separately. Beta's supplied rate lacks tax treatment and remains blocked. Unknown has no approved price/customer. All examples remain reviewable; none are automatically accepted.

The structured path uses a handwritten mock response with `entries`, each containing only `customerHint`, `date`, `quantity`, `unit`, `description` and `span`. It is an AI-output shape example, not an output from Haiku or an accuracy measurement. The validator rejects IDs, financial fields, commands, acceptance flags, extra keys, invalid dates/numbers, oversized input and invalid/overlapping spans. Nulls are allowed for unknown facts. A valid schema cannot prove semantic truth; the person still checks the source.

Future extraction instructions should request only these bounded candidates with verbatim supporting spans, null unknowns, separate items and no instructions followed from the source. Customer matching happens against authorized records after extraction; do not send the whole customer database to a model. Forwarded content is untrusted even if it says to change a bank account, accept work or send an invoice. Tool access and invoice commands must be absent from the extraction process. Record suspicious text for review; do not claim a prompt alone prevents injection.

The 32 pure scenarios exercise replayed text and email, cross-channel duplicates, changed-source conflicts, unknown/ambiguous customers, missing tax, corrections and review invalidation, stale revisions, same-holder replacement and distinct-holder release refusal, exclusive holder ownership, and changed commercial facts before reservation. They also check that later rate changes cannot alter a reserved line, synthetic issued-state refusal, and embedded instructions. [Recorded results](evidence/2026-10-08-work-log/prototype-results.json) contain the structured candidates and traceable draft-line example. Review snapshots and stored lines are frozen in this isolated model; returned lines are copies. Synthetic issued state is inserted directly only to test refusal, not through an issuance action.

Run from the repository root without installing dependencies:

```sh
bun docs/plans/evidence/2026-10-08-work-log/prototype.mjs
bun docs/plans/evidence/2026-10-08-work-log/cost-model.mjs
```

These do not test K5 execution, STT accuracy, a live model, an SQL race, durable allocation identities, authorization infrastructure or UI comprehension. The model's maps are process-local and exposed for fixture inspection; they do not establish persistence or a protected production store. The scripts contain no networking, provider SDK, sending, charging, database, or real financial write. Production parsing, permissions, transactions and invoice arithmetic must use the actual reviewed contracts later.

## Speech options for Danish work notes

No Danish work-note accuracy test was run. Language support and broad multilingual benchmarks do not prove that names, decimal hours, dates, negation or corrections are reliable enough for billing. Test dictation, not recorded client calls, first. Client-call recording would change the privacy and product scope.

| Path | Device and Danish evidence | Processing, retention and training | Price arithmetic checked 2026-10-08 |
| --- | --- | --- | --- |
| Apple on-device Speech | Native Apple integration, not a portable web capability. [Apple](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition) requires runtime support before `requiresOnDeviceRecognition` can be honored. Danish/offline support must be tested on each supported OS/device. | Fail closed if on-device support is unavailable. Do not silently fall back to server recognition. Local processing would remove the STT upload, not the later AI/transcript transfer. Local persistence/backup still needs a policy. | No per-minute API tariff established in inspected docs. Model zero marginal STT network spend only as an assumption, with device energy/storage and native engineering excluded. |
| Local whisper.cpp | [Upstream](https://github.com/ggml-org/whisper.cpp/blob/master/README.md) supports desktop/mobile and browser examples. Actual model size, download, memory, latency and Danish quality need device tests. Do not assume every mobile browser can run a useful model. | Fully local deployment is possible. Application telemetry, downloads and backups need separate inspection. Local execution does not grant a provider any audio for training. | No hosted inference tariff for running the code locally. Hardware, model distribution, battery and support costs remain. No benchmark was run. |
| Deepgram Nova-3, selected Danish language, pre-recorded | [Language docs](https://developers.deepgram.com/docs/models-languages-overview) list Danish `da`/`da-DK`. This is not evidence that the multilingual `multi` route supports Danish identically. Any client can upload through a future backend. | [Data policy](https://developers.deepgram.com/trust-security/your-data) requires the EU endpoint and `mip_opt_out=true` for full in-region processing without retained content. Default MIP retains content for improvement; opted-out content lasts only through processing. Usage metadata remains, including 90-day retrieval. EU region is not a Danish-country guarantee. | [Pricing](https://deepgram.com/pricing) lists monolingual batch $0.0043/min, or $0.258/hour; multilingual batch $0.0052/min, $0.312/hour. These are not streaming prices. Pay-as-you-go has no plan minimum; minimum top-up/charge remains to confirm. Billing is per second; exact per-request minimum is unresolved. |
| Speechmatics Melia / Enhanced batch | [Languages](https://docs.speechmatics.com/speech-to-text/languages) and [language page](https://www.speechmatics.com/languages) include Danish. Evaluate both short Danish notes and Danish/English code-switching; no work-note word-error rate established. | [Pricing page](https://www.speechmatics.com/pricing) offers EU location choice and no training logging by default. [Legacy SaaS docs](https://legacy.docs.speechmatics.com/en/cloud/introduction) describe seven-day batch retention and deletion. Current route-specific retention and DPA/subprocessor scope were not verified. Do not label this ZDR. | Public pricing and calculator disagree: page shows Melia $0.12/hour and Enhanced $0.38/hour, calculator shows $0.24/hour and $0.75/hour. [Calculator](https://www.speechmatics.com/pricing/calculator) gives no-contract/no-minimum PAYG and an optional training discount. Use undiscounted calculator values only as sensitivity estimates: $0.004 and $0.0125/min. Billing rounding/minimum and discrepancy need confirmation. |

Deepgram's [subprocessor list](https://deepgram.com/privacy/subprocessors) also discusses external benchmarking and opt-out/DPA controls. Verify the current applicable list and core-processing-only agreement before procurement. Speechmatics' current subprocessor list and exact batch-retention terms remain an access gap; a website privacy policy is insufficient. Apple's offline guarantee needs a runtime check, and whisper.cpp needs an application network audit. None of these inherits the LLM provider's residency contract.

Proposed audition, not conducted: at least 60 consented or synthetic Danish clips across short/long notes, Danish/English terms, regional accents, noisy rooms, customer-name collisions, decimal hours, "not billable" and self-correction. Have two Danish speakers annotate reference work facts. Compare field accuracy, omitted work, invented work, correction time, latency, upload size and failed offline cases. Reject any flow that hides uncertain billable facts. A Danish-language reviewer and a product owner must set acceptable error/correction thresholds before a pilot; this discovery does not invent acceptance results.

### EU/Denmark retention decision

Voice, transcripts, customer names and forwarded email can contain personal or confidential information. Under [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng), document purpose/legal basis, minimization, accuracy, retention, processor terms, security and any transfers. A microphone permission is not a legal basis for all processing. Review special-category content if users can dictate it. The [Danish authority's risk guidance](https://www.datatilsynet.dk/regler-og-vejledning/behandlingssikkerhed/risikovurdering) and [DPIA guidance](https://www.datatilsynet.dk/regler-og-vejledning/behandlingssikkerhed/konsekvensanalyse) require a risk-based decision; a DPIA is not automatically required for every work note.

Propose a maximum 24-hour encrypted audio retry buffer, with deletion on successful review where feasible, no audio in application logs/backups, and explicit user discard. Keep source metadata, digest, selected transcript evidence and corrections with access-controlled work records. Cost estimates use 30-day transcript retention; this is not an adopted accounting retention rule. Before implementation, determine which confirmed evidence must accompany retained invoice records and how deletion affects disputes. Use deletion tombstones instead of broken source links. A digest proves identity, not the truth of the work or a recoverable copy of deleted audio.

Default to no training, no provider prompt logging, no raw content in telemetry, and no regional fallback. Check storage/backup locations separately from STT and LLM. Record each processor/subprocessor, data categories, geography, access, retention and deletion verification. Financial record retention and optional audio retention are separate decisions. Obtain processor agreements and decide transfer safeguards before using customer data; no claim of blanket GDPR compliance follows from an EU hostname or a zero-retention label.

## Exact managed-model verification

The requested model was checked without substituting another Haiku version. [Anthropic's release page](https://www.anthropic.com/claude-haiku-5-5), dated 2026-10-07, identifies `claude-haiku-5-5` and prices prompts up to 100,000 tokens at $0.10 input/$0.50 output per million. Longer prompts use $0.50/$2.50. [OpenRouter's model page](https://openrouter.ai/anthropic/claude-haiku-5.5) identifies `anthropic/claude-haiku-5.5`, lists standard $0.10/$0.50 and additional provider rows at $0.11/$0.55. The text export does not establish which of those rows satisfies both EU and ZDR constraints. The [EU-filtered model page](https://openrouter.ai/models?region=eu) also lists Haiku 5.5, but does not prove simultaneous ZDR eligibility. The estimate uses the higher values as a planning allowance, not a confirmed EU route quote.

[OpenRouter Business](https://openrouter.ai/business) states an 8% fee on credit purchases with no monthly minimum. Its [regional guide](https://openrouter.ai/docs/guides/features/sovereign-ai) requires Business/Enterprise and the EU domain for in-region routing. [ZDR docs](https://openrouter.ai/docs/guides/features/zdr) make retention a separate endpoint filter, including `provider.zdr: true`. ZDR is specific to inference, excludes external tools, permits certain in-memory prompt caches and does not mean no billing metadata. Keep optional tools/plugins disabled for extraction.

Verified publicly: model existence, identifiers, published base/additional-provider price rows, Business fee, and the documented separate regional/ZDR controls. Unverified: the deployed model/version, account plan, exact EU provider endpoint, its simultaneous ZDR eligibility for this model, effective guardrails/fallback settings, prompt logging, negotiated terms and actual billed usage. A model page that lists EU providers does not prove the chosen account uses them. No authenticated configuration was inspected and no inference or provider API call was made. An owner must retain configuration and contract evidence, privately, before activation. If the selected route is unavailable, fail closed. Do not replace the model or route silently.

## Reproducible active-user cost estimate

The [cost model](evidence/2026-10-08-work-log/cost-model.mjs) exposes every input and writes [results](evidence/2026-10-08-work-log/cost-results.json). These are usage scenarios, not measured customers or supplier quotes. An active user submits work in the month. A paid organization can contain several active users; a seat subscription is a different billing unit.

Assumptions: USD 1 = DKK 6.50, an illustrative FX rate rather than a market quote. Model consumer prices with 25% Danish VAT, so 99 DKK gross gives 79.20 DKK revenue excluding VAT. Supplier cost is net of recoverable VAT; unrecoverable VAT is excluded. No customer invoice tax treatment follows from this pricing example. [Skattestyrelsen VAT guidance](https://skat.dk/erhverv/moms/i-gang-med-moms) should govern the actual business case.

Use Danish monolingual batch STT at $0.0043/min, Haiku 5.5 with a proposed regional allowance at $0.11/$0.55 per million, and an 8% credit fee allocated over consumed credits. Include all input context and output/reasoning tokens in the call budgets. No prompt caching, batch discount, training discount or introductory credit is assumed. Actual regional price/eligibility is still a gate. All requests stay below the 100k price breakpoint.

| Monthly active-user scenario | Audio minutes | Initial extraction calls | Input/output tokens per call | Extra correction/retry calls | STT retry audio | Total input/output tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Light | 20 | 20 | 1,200 / 300 | 2 | 2% | 26,400 / 6,600 |
| Typical | 120 | 80 | 2,000 / 500 | 12 | 5% | 184,000 / 46,000 |
| Heavy | 600 | 300 | 3,500 / 800 | 90 | 10% | 1,365,000 / 312,000 |

Audio is 32 kbit/s mono, 240,000 bytes/minute, retained one day. Store 12,000 transcript/structured bytes per original call for 30 days. Steady-state retained bytes equal monthly bytes multiplied by retention days/30. The model assumes uniform arrival and no duplicate retry blobs. Storage is a planning allowance of $0.03/decimal GB-month, not a verified storage tariff. Per-active-user infrastructure and support allowances are DKK 2 and DKK 5. Retries use the same token budgets as initial calls. Per-second rounding uses aggregate synthetic duration; real per-clip rounding/minimums must be added when measured.

| Scenario | New audio bytes | New text/structured bytes | Average retained bytes | STT USD | LLM USD with fee | Provider/storage DKK | Cost with operating allowances DKK |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Light | 4,800,000 | 240,000 | 400,000 | 0.08772 | 0.00706 | 0.62 | 7.62 |
| Typical | 28,800,000 | 960,000 | 1,920,000 | 0.54180 | 0.04918 | 3.84 | 10.84 |
| Heavy | 144,000,000 | 3,600,000 | 8,400,000 | 2.83800 | 0.34749 | 20.71 | 27.71 |

Formulas use billed minutes including STT retries, total tokens including extra calls, and retained bytes. Provider DKK equals FX times STT cost plus LLM cost with the credit fee plus storage cost. Operating cost adds the DKK 7 allowance. Contribution equals gross price/1.25, less payment cost and operating cost. Assume payment cost of 2% of gross plus DKK 1.80 per charge, purely as a planning allowance. Base invoicing, engineering, sales, refunds/chargebacks, corporate tax, provider top-up cash timing, email ingestion and attachments are excluded. Egress/request costs are covered only by the rough infrastructure allowance. These are contribution estimates, not business gross margins.

Sensitivity around the typical DKK 10.84 estimate:

| Change | DKK per active user/month |
| --- | ---: |
| Double audio, unchanged extraction call count | 14.36 |
| Four times output tokens, including any reasoning | 11.37 |
| 50% extra extraction calls and 50% STT retry audio | 12.45 |
| 30-day audio and 365-day transcript retention | 10.85 |
| FX 20% higher | 11.61 |
| Double STT tariff | 14.36 |
| Speechmatics calculator Melia tariff, route unverified | 10.60 |
| Speechmatics calculator Enhanced tariff, route unverified | 17.56 |

Longer retention looks cheap in byte costs, but it creates a separate privacy and operational burden. A 50% light/40% typical/10% heavy mix averages DKK 10.92 including allowances; the heaviest 10% account for 50.8% of audio. Do not sell unlimited organization use based only on the mean.

### Inclusion, tier and add-on proposals

These are hypothetical DKK prices, not current prices or billing changes. Caps are shared by an organization, not multiplied per active user. Prices include Danish VAT. The table assumes one active user and the typical call/minute ratio; both minute and token/call caps are needed.

| Proposal | Revenue basis excluding VAT | Included audio proposal | Contribution at cap | Cost-only break-even at typical mix |
| --- | ---: | ---: | ---: | ---: |
| Include in hypothetical 99 DKK base plan | 79.20 DKK full subscription revenue | 120 min/org/month | 64.58 DKK, 81.5%, before all base-product costs | 2,137 min for one active user, before base-product costs |
| Hypothetical 149 DKK higher tier, 50 DKK above base | 40.00 DKK incremental revenue | 600 min/org/month total | 10.99 DKK, 27.5%, charging the full feature cost against the increment | 943 min for one active user |
| Explicit 29 DKK usage pack | 23.20 DKK pack revenue | 300 min/org/pack | 4.22 DKK, 18.2%, conservatively charging the monthly active-user allowance again | 432 min for one active user |

The base option earns zero incremental revenue from inclusion; its full-subscription percentages cannot establish that the feature pays for itself. If a tier replaces the same base allowance, incremental cost is lower than this conservative table. Likewise, an add-on billed on the same subscription invoice may avoid another fixed payment fee. The model deliberately charges one full fee for each compared option. At heavy-profile token/retry ratios, the 50 DKK tier increment contributes 23.7%; supplying all 600 heavy minutes for one 29 DKK pack loses 29.7%. Enforce the 300-minute pack limit.

For a single 99 DKK organization with uncapped typical use, one/three/ten active users leave DKK 64.58/42.89/-33.00 after the modelled feature costs and payment allowance. Seven typical users already exceed that budget before base-product costs. Shared caps change the minute total but do not eliminate per-user support. Seat-based pricing would need explicit paid-seat counts and activation ratios, not reuse organization revenue for every active user.

Recommendation for a future test: base inclusion up to 120 minutes/org/month, 100 initial extraction calls, 250k input and 75k output tokens, and bounded individual uploads. These are proposed product caps, not provider limits. Account for operational retries in the cost budget without charging users for an automatic retry twice. Show remaining allowance before capture; retain deterministic text when allowance is exhausted. Pause managed processing at the cap. A person can explicitly choose a pack later; no automatic purchase or charge. Test willingness to pay for a larger allowance before creating a new tier. Reprice from measured correction time, p95 usage and support cost after the pilot.

## OSS/cloud responsibility and authorization

The public [runtime extension](https://github.com/tielemans-dev/quits-oss/blob/d81e67902ab98c2c7ac7340444ba5a54da6255d4/apps/oss/src/lib/runtime/extensions.ts) supports capability patches, including `aiInvoiceDraft`, with managed mode disabled by default. It has no work-log/voice capability today. Add any future neutral capability/contract in OSS through review, then release it before hosted integration. The shared work-entry model, deterministic parser, validation, source identity and reservation adapter belong in OSS. Hosted execution, metering, provider credentials and subscription enforcement belong in cloud. This does not remove existing OSS BYOK/local-provider behavior.

The current [AI router](https://github.com/tielemans-dev/quits-oss/blob/d81e67902ab98c2c7ac7340444ba5a54da6255d4/apps/oss/src/trpc/routers/ai.ts) calls `getBillingProvider().getSubscription(organizationId)` and requires `status === "active"` for managed access when the capability requires a subscription. The [billing interface](https://github.com/tielemans-dev/quits-oss/blob/d81e67902ab98c2c7ac7340444ba5a54da6255d4/apps/oss/src/lib/billing/types.ts) returns `status` and `priceId`. The OSS noop returns `free`. The organization schema has `subscriptionStatus`; public source alone does not prove any hosted synchronization policy.

Future managed capture must use the real billing provider backed by canonical subscription status. Recheck server-side for each paid action and retry. Free, canceled, past-due or unknown states must not pass as active. Map a future tier from canonical billing price/product configuration, not a second entitlement table or an always-active stub. Usage counters may record consumption and limits, never become a parallel subscription state. A capability controls availability; it is not per-organization authorization. Enforce organization membership, source-read and invoice-create permissions independently. Existing drafts remain readable according to their normal permissions if a subscription ends.

Separate authorization steps are capture, correction, work confirmation, and reviewed draft creation. No step accepts an agreement, adds to accepted scope or sends a document. Use #69's consequences pattern later to show which sources will be reserved, the customer, frozen financial facts, unresolved/excluded entries, draft-only result and no recipients. Bind confirmation to reviewed source/commercial revisions, allocation holders, actor permissions and proposed draft content; recompute/refuse after relevant changes. The issuance/send UI still requires its own authorization and preview.

## Kvit information and action handoff

UX owns the screen. This section specifies information and actions, not layout, typography or components.

Show each source type/time, the person's original text or retained transcript excerpt, parser/extraction notes, source revision, suggested versus selected customer, date/duration/unit, billing classification, rate/tax/currency provenance, missing facts, duplicates and current holder. Group confirmed work by customer and compatible month/currency. Show excluded work and work included in fixed fees separately. A reserved holder is a draft link with no legal number; redact invoice/credit identities when permission is absent.

Needed actions are add typed work, choose an optional voice upload after the privacy notice, paste/submit mail text, inspect source, select customer, correct/split an entry, mark duplicate or distinct with a reason, exclude/include-in-fixed-fee, select authorized commercial facts, confirm work, preview selected draft lines, create a draft and release its exact reviewed reservation. Preserve source and correction history. Reprocessing cannot approve work or reset consumed state.

Explain stale review, changed-source conflicts, unsupported prose, missing tax/rate, conflicting customer candidates, existing reservation, exhausted allowance, disabled regional provider, and deleted audio whose transcript remains. Keep source text visibly separate from actions. No chat interface, auto-accept, timer, send shortcut, final-screen design or production email forwarding address is part of this handoff.

## Phases and decision gates

1. Accept the discovery's scope, source limitations and cost assumptions. Confirm the final reviewed/public K5 SHA. Keep #86 open if any discovery acceptance remains; publication is a draft documentation review, not feature completion.
2. Run operator discovery with synthetic typed examples. Decide the first concrete work source under #52 and the required billing classes. UX designs the Kvit screen separately. Evaluate correction effort and whether voice solves a real problem.
3. Implement the OSS typed proposal, schema/adapter and reviewed allocation transaction after the final K5 contract and #52 source adapter are reviewed, reusing the merged #96 draft-revision and stable-line-key contracts. Integrate #69 only after its supported contract lands. Require database concurrency/replay, source revision and permission tests; do not assume these pure examples establish them.
4. Verify exact model/route, EU/ZDR policy intersection, STT DPA/subprocessors, retention/deletion and Danish device/provider accuracy. Resolve Speechmatics pricing discrepancy if shortlisted. Approve privacy assessment and support/cost budget before a separately authorized synthetic provider evaluation.
5. Consider a bounded hosted pilot with real canonical subscription status, cost/usage measurement and explicit human review. Publish/release the OSS contract before hosted wiring. Pilot reconciliation and customer comprehension remain human acceptance under [#85](https://github.com/tielemans-dev/quits-oss/issues/85); no pilot is authorized here.
6. Revisit price tier/add-on only after measuring active users per organization, p95 audio/tokens, retry/correction burden and willingness to pay. Any pricing change is separate work.

Excluded: provider purchases or setup, live inference, production email ingestion, customer data, customer contact, financial writes, automatic acceptance/issuance/sending/collection, timers, passive monitoring, a full project/expense ledger, tax advice, billing changes and a finished UI.

Remaining acceptance is explicit: final K5/public dependency review; actual EU+ZDR account/endpoint evidence; Danish accuracy and operator comprehension; lawful retention and processor approval; a chosen source and reconciliation pilot; measured costs and commercial approval. The research and offline checks cannot certify any of these.
