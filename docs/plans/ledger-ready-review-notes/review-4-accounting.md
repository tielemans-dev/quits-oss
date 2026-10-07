# Review 4, accounting lens (Codex, 2026-10-07) on rev 4 Phase A. Verdict: deny as written; three arithmetic blockers plus scope guards.

1. BLOCKER inclusive pricing: redistributing net then line tax = gross - net yields total line VAT 0.00 for two 0.01 lines (group VAT 0.01). Allocate group VAT to lines independently; payable rounding is a separate group component, not in lines; cancellation reverses frozen components incl. rounding.
2. BLOCKER partial credits: proportional historical reversal rounded independently does not reconcile (net 0.06 VAT 0.02 gross 0.08, credit 0.02 -> net 0.02 VAT 0.01 vs discharge 0.02). Define component allocation reconciling to credited gross, cumulative limits, final-credit residual absorption; never route to FX. Or refuse partial credits.
3. BLOCKER base-currency rounding: EUR 0.03/0.01/0.04 at 7.45 -> 0.22/0.07/0.30, off by 0.01. Define deterministic base component rounding and residual ownership; separate base equation; reuse frozen components on credits; do not classify translation rounding as FX. Alternative: refuse foreign-currency postings.
4. Grouping by (treatment, rate, country) merges K and AE; include peppol category and reason in the group key.
5. Evidence: VIES must be `valid`; export evidence typed; AE needs seller and buyer ids (BR-AE-02); domestic_construction alone must not authorize DK reverse charge; refuse DK zero_rated; S needs rate > 0; O no-rate/no-mix.
6. Tax point: no confidence in a 15-day window; null supplyDate must not bypass review; validate taxPointDate vs reason; refuse assessment_required; `none` only for applicable treatments.
7. Credit transition guards: postable only if correctsPurpose = sale, open balance includes prior credits, debtorDischarge = credited gross, customerCreditCreated null, allocationsReleased empty, no unexplained difference to FX.
8. Known open issues missing specifics from round-3 findings 29, 31, 32, 34, 40.
Q1 refuse earlier supply dates until approved; null must not bypass. Q2 keep zero_rated in vocabulary, refuse in Phase A. Q3 require strings for new agent calls; toFixed erases precision.
