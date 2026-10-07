# Review 3, accounting lens (Codex, 2026-10-07) on rev 3. Verdict: still not executable for A4 unless A4 refuses the hard cases.

Resolved: 6, 23. Not resolved: 28 (Peppol mapping). All else partial.

New
29. Covered advances cross-currency: freeze receipt quantity, covered invoice quantity, agreed conversion, recognition/base components, residual ownership; distinguish face gross, covered gross, outstanding gross; refuse currency changes until defined.
30. BLOCKER deposit conservation contradicts refund: funded 50, funded credit 10 -> customer credit 10, applicable 40; refund of that credit must leave 40, invariant gives 30; full cancellation makes applicable 0 so refund requirement rejects it. Separate advance liability, credit-created refund liability, refunds discharging each; allow full discharge to zero.
31. BLOCKER credits against prepayment invoices must debit prepayments_received (and VAT), not revenue: prepayment 125, paid 50, unpaid 25 credited -> Dr prepayments 20, Dr VAT 5, Cr debtor 25. Purpose-specific historical reversal. Decide whether allocation releases are metadata or journals (double customer credit risk). Bound partial application releases by credited portion.
32. BLOCKER final-invoice FX: EUR 125 advance at 7.45 (745 net + 186.25 VAT), final at 7.50 credits revenue 750 + VAT 187.50, debtor 0; applications debit 931.25; 6.25 missing. Define the bridge against final-invoice components; distinguish fixed-service (non-monetary) advances from monetary refund obligations; keep historical VAT components.
33. Reversal valuation when positions are exhausted (qty 0): proportional rule undefined; define restored-position valuation explicitly. Void vs refund are different facts; void after revaluation requires reversing dependent adjustments, not converting to a refund.
34. Fee postings need base values and FX for every treatment when clearing carrying != valuation; assert deductible + non-deductible = assessed tax.
35. `delivery` tax point has no command producing it; invoice-vs-delivery precedence (delivery 30 Sep, invoice 15 Nov cannot use Nov automatically); define qualifying invoicing, advance precedence, delivery evidence, accrual/reconciliation event, or refuse scope explicitly. Free-text supply reference is weak identification.
36. Peppol: intra-community = K, export = G, Z is distinct (UNCL5305). Freeze evidence refs, statements, verification results in payloads.
37. Rounding: two inclusive 0.01 lines at 25% -> net 0.02, tax 0.01, rounding -0.01; define redistribution of group net to lines; full cancellation needs opposite rounding entry; historicalReversal must include rounding; never route through FX.
38. Agreement model: state whether total and advance include VAT; schedule entries need attributed VAT groups for mixed treatments; freeze advance refs and application intent; existing accepted snapshots remain immutable.
39. Retention: transitive propagation to PDF, agreement, approval, email referenced indirectly; purge-time checks; holds; backups vs active store.
40. Tests: partial covered advances, cross-currency recognition, funded credit then refund, full cancellation/refund, partial application release, exhausted-position reversal, false-receipt correction after revaluation, foreign reverse-charge fee, delivery before late invoice, inclusive rounding cancellation, transitive retention.

Open questions: Q1 keep confirmation, auto-suggest match. Q2 redating too blunt; preserve economic date with chronological recomputation or explicit correction workflow. Q3 fine to change PDF wording; version model and renderer; keep accepted snapshots.
A4 minimum: K/G mapping + frozen evidence; inclusive line/base reconciliation; historical rounding reversal; exact credit/allocation-release semantics; tax-point derivation; A4 explicitly refuses prepayments, covered advances, deposit applications/releases, unsupported corrections, with numeric fixtures proving the boundaries.
