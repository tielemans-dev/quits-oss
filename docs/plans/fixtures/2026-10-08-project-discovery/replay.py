"""Pure synthetic decision fixtures. No Quits runtime imports or external effects."""
import argparse
import copy
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def association(protected, reporting, target, expected_revision):
    # Proposed rule only. There is no such command in the audited application.
    if expected_revision != reporting["revision"]:
        raise ValueError("association_changed")
    if protected["invoice"]["status"] == "draft" or protected["invoice"]["number"] is None:
        raise ValueError("invoice_not_issued")
    if target is not None:
        if target["organizationId"] != protected["invoice"]["organizationId"]:
            raise ValueError("project_not_found")
    # This synthetic ID models corroborated historical identity, not a field in
    # Quits' BuyerSnapshot contract or an identity inferred from today's contact.
    snapshot = protected["invoice"].get("issuanceSnapshot")
    buyer = snapshot.get("buyer") if isinstance(snapshot, dict) else None
    frozen_id = buyer.get("id") if isinstance(buyer, dict) else None
    if (not isinstance(frozen_id, str) or not frozen_id.strip() or
            frozen_id != protected["invoice"]["contactId"]):
        raise ValueError("historical_buyer_review_required")
    if target is not None:
        if target["contactId"] != protected["invoice"]["contactId"]:
            raise ValueError("customer_mismatch")
    return {"projectId": target["id"] if target else None,
            "revision": reporting["revision"] + 1}


def reminder_basis(protected):
    invoice = protected["invoice"]
    debt = max(invoice["grossMinor"] - invoice["creditedMinor"] - invoice["paidMinor"], 0)
    open_balance = invoice["status"] in ("sent", "viewed", "overdue") and debt > 0
    ready = (open_balance and not invoice["remindersPaused"] and
             invoice["policyEnabled"] and invoice["recipientValid"] and invoice["dueSlot"])
    return {"outstandingMinor": debt, "openBalanceEligible": open_balance,
            "automaticReminderReadyUnderFixturePolicy": ready}


def invoice_fixture(name, status, paid, credited, receipt_gross, receipt_net, fee, due_slot):
    invoice_id = "invoice-" + name
    protected = {
        "invoice": {"id": invoice_id, "organizationId": "org-A", "contactId": "buyer-A",
                    "number": "INV-" + name, "currency": "DKK", "exponent": 2,
                    "issueDate": "2026-09-20", "supplyDate": "2026-09-20",
                    "grossMinor": 100000, "paidMinor": paid, "creditedMinor": credited,
                    "status": status, "remindersPaused": False, "policyEnabled": True,
                    "recipientValid": True, "dueSlot": due_slot,
                    "dueDate": "2026-10-01" if due_slot else "2026-10-31",
                    "agreementId": "agreement-A", "deliverableId": "work-" + name,
                    "allocationGeneration": 0, "publicPaymentKeyVersion": 1,
                    "paymentDetailsSnapshot": {"reference": "PAY-" + name},
                    "issuanceSnapshot": {"buyer": {"id": "buyer-A", "name": "Synthetic A"},
                                         "seller": {"id": "org-A"}, "gross": "1000.00",
                                         "currency": "DKK", "pricesIncludeTax": False,
                                         "vatRate": "0.25", "net": "800.00", "tax": "200.00"}},
        "artifacts": [], "receipts": [], "allocations": [], "credits": [],
        "refunds": [], "reminderHistory": [], "cashNetMinor": receipt_net,
    }
    for kind in ("pdf", "ubl"):
        raw = ("SYNTHETIC-OPAQUE-ARTIFACT-NOT-A-VALID-" + kind.upper() + ":" + invoice_id).encode()
        protected["artifacts"].append({"kind": kind, "ref": "fixture/" + invoice_id + "." + kind,
                                       "bytesHex": raw.hex(), "sha256": hashlib.sha256(raw).hexdigest()})
    if receipt_gross:
        assert receipt_gross == receipt_net + fee
        receipt_id = "receipt-" + name
        protected["receipts"].append({"id": receipt_id, "organizationId": "org-A", "contactId": "buyer-A",
                                     "currency": "DKK", "grossMinor": receipt_gross, "netMinor": receipt_net,
                                     "feeMinor": fee, "reference": "bank-" + name, "paidAt": "2026-09-30",
                                     "evidence": "fixture-only", "availableMinor": receipt_gross - paid})
        protected["allocations"].append({"id": "payment-" + name, "receiptId": receipt_id,
                                        "invoiceId": invoice_id, "currency": "DKK", "amountMinor": paid,
                                        "receiptAmountMinor": paid, "voidedAt": None})
    if credited:
        raw = ("SYNTHETIC-CREDIT-ARTIFACT:" + name).encode()
        protected["credits"].append({"id": "credit-" + name, "invoiceId": invoice_id,
                                    "grossMinor": credited, "status": "issued", "buyerId": "buyer-A",
                                    "artifactBytesHex": raw.hex(), "artifactSha256": hashlib.sha256(raw).hexdigest()})
    assert sum(row["amountMinor"] for row in protected["allocations"]) == paid
    assert sum(row["grossMinor"] for row in protected["credits"]) == credited
    assert sum(row["netMinor"] for row in protected["receipts"]) == protected["cashNetMinor"]
    for credit in protected["credits"]:
        assert hashlib.sha256(bytes.fromhex(credit["artifactBytesHex"])).hexdigest() == credit["artifactSha256"]
    return protected


def association_replays():
    configurations = [
        ("paid", "paid", 100000, 0, 100000, 98500, 1500, True),
        ("partly-paid", "sent", 40000, 0, 45000, 45000, 0, False),
        ("credited", "credited", 0, 100000, 0, 0, 0, True),
        ("overdue", "overdue", 20000, 10000, 20000, 20000, 0, True),
    ]
    projects = [{"id": "project-A", "organizationId": "org-A", "contactId": "buyer-A"},
                {"id": "project-B", "organizationId": "org-A", "contactId": "buyer-A"}]
    results = []
    for config in configurations:
        original = invoice_fixture(*config)
        current = copy.deepcopy(original)
        reporting = {"projectId": None, "revision": 0}
        steps = []
        for label, target in [("assign", projects[0]), ("correct", projects[1]), ("remove", None)]:
            before = {"protected": copy.deepcopy(current), "reporting": reporting.copy()}
            reporting = association(current, reporting, target, reporting["revision"])
            after = {"protected": copy.deepcopy(current), "reporting": reporting.copy()}
            assert canonical(before["protected"]) == canonical(after["protected"]) == canonical(original)
            for artifact in current["artifacts"]:
                assert hashlib.sha256(bytes.fromhex(artifact["bytesHex"])).hexdigest() == artifact["sha256"]
            basis = reminder_basis(current)
            steps.append({"operation": label, "before": before, "after": after,
                          "protectedSha256Before": digest(before["protected"]),
                          "protectedSha256After": digest(after["protected"]),
                          "settlementBefore": basis, "settlementAfter": basis.copy()})
        failures = []
        for target, revision, error in [
            ({"id": "wrong-customer", "organizationId": "org-A", "contactId": "buyer-B"}, 3, "customer_mismatch"),
            ({"id": "wrong-org", "organizationId": "org-B", "contactId": "buyer-A"}, 3, "project_not_found"),
            (projects[0], 0, "association_changed"),
        ]:
            frozen = canonical({"protected": current, "reporting": reporting})
            try:
                association(current, reporting, target, revision)
                raise AssertionError("Expected refusal")
            except ValueError as exc:
                assert str(exc) == error
            assert frozen == canonical({"protected": current, "reporting": reporting})
            failures.append({"expected": error, "stateUnchanged": True})
        results.append({"case": config[0], "steps": steps, "refusals": failures})
    return results


def draft_association_replays():
    """Refuse the proposed label around a buyer edit, without simulating the app editor."""
    cases = [
        ("assign-before-buyer-change", "buyer-A", None, "project-A"),
        ("assign-after-buyer-change", "buyer-B", None, "project-B"),
        ("correct-invalid-draft-association", "buyer-A", "project-A", "project-B"),
        ("remove-invalid-draft-association", "buyer-A", "project-A", None),
    ]
    results = []
    for name, buyer, previous, next_project in cases:
        protected = {"invoice": {"id": "draft-1", "status": "draft", "number": None,
                                  "organizationId": "org-A", "contactId": buyer}}
        reporting = {"projectId": previous, "revision": 0}
        target = {"id": next_project, "organizationId": "org-A", "contactId": buyer} if next_project else None
        before = {"protected": copy.deepcopy(protected), "reporting": reporting.copy()}
        try:
            association(protected, reporting, target, 0)
        except ValueError as exc:
            assert str(exc) == "invoice_not_issued"
        else:
            raise AssertionError("Draft association must refuse")
        after = {"protected": protected, "reporting": reporting}
        assert before == after
        results.append({"case": name, "expected": "invoice_not_issued", "before": before,
                        "after": after, "stateUnchanged": True})
    return results


def effort(actual, complete, low, high):
    if actual < 0:
        raise ValueError("negative_actual")
    if complete:
        if low not in (None, 0) or high not in (None, 0):
            raise ValueError("completed_has_remaining")
        return {"remainingLowHours": 0, "remainingHighHours": 0,
                "totalLowHours": actual, "totalHighHours": actual, "state": "complete"}
    if low is None or high is None:
        return {"remainingLowHours": None, "remainingHighHours": None,
                "totalLowHours": None, "totalHighHours": None, "state": "unknown_remaining"}
    if low < 0 or high < low:
        raise ValueError("invalid_range")
    return {"remainingLowHours": low, "remainingHighHours": high,
            "totalLowHours": actual + low, "totalHighHours": actual + high, "state": "owner_scenario"}


def frozen_buyer_replays():
    results = []
    for evidence_case in ("changed-link", "missing-snapshot", "missing-buyer",
                          "missing-identity", "empty-identity", "null-snapshot"):
        for operation, previous, next_id in (("assign", None, "project-A"),
                                             ("correct", "project-A", "project-B"),
                                             ("remove", "project-A", None)):
            protected = invoice_fixture("paid", "paid", 100000, 0, 100000, 98500, 1500, True)
            invoice = protected["invoice"]
            if evidence_case == "changed-link":
                invoice["contactId"] = "buyer-B"
            elif evidence_case == "missing-snapshot":
                del invoice["issuanceSnapshot"]
            elif evidence_case == "null-snapshot":
                invoice["issuanceSnapshot"] = None
            elif evidence_case == "missing-buyer":
                del invoice["issuanceSnapshot"]["buyer"]
            elif evidence_case == "missing-identity":
                del invoice["issuanceSnapshot"]["buyer"]["id"]
            else:
                invoice["issuanceSnapshot"]["buyer"]["id"] = ""
            reporting = {"projectId": previous, "revision": 0}
            target = {"id": next_id, "organizationId": "org-A", "contactId": invoice["contactId"]} if next_id else None
            before = copy.deepcopy((protected, reporting, target))
            try:
                association(protected, reporting, target, 0)
            except ValueError as exc:
                assert str(exc) == "historical_buyer_review_required"
            else:
                raise AssertionError("Uncorroborated frozen buyer must require review")
            assert before == (protected, reporting, target)
            results.append({"case": evidence_case, "operation": operation,
                            "expected": "historical_buyer_review_required", "stateUnchanged": True,
                            "protectedSha256Before": digest(before[0]), "protectedSha256After": digest(protected)})
    return results


def warning_outcome(episode):
    """Illustrate the proposed dated-evidence rubric; no pilot observations."""
    def timestamp(value):
        if value is None:
            return None
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed

    try:
        warned = timestamp(episode.get("warningAt"))
        risk = timestamp(episode.get("riskAt"))
        action = timestamp(episode.get("correctiveActionAt"))
    except (ValueError, TypeError, AttributeError):
        return "unresolved"
    if warned is None:
        return "unresolved"
    known_events = [time for time in (risk, action) if time is not None]
    if known_events and warned >= min(known_events):
        return "late"
    if risk is not None or (action is not None and episode.get("avoidanceEvidenced") is True):
        return "timely"
    return "false" if episode.get("confirmedNoRisk") is True else "unresolved"


def warning_quality_replays():
    early = {"warningAt": "2026-10-01T09:00:00Z", "riskAt": "2026-10-02T09:00:00Z"}
    late = {"warningAt": "2026-10-03T09:00:00Z", "riskAt": "2026-10-02T09:00:00Z"}
    false = {"warningAt": "2026-10-01T09:00:00Z", "confirmedNoRisk": True}
    boundary_inputs = [
        ("before-risk", early, "timely"), ("after-risk", late, "late"),
        ("at-risk", {**early, "warningAt": early["riskAt"]}, "late"),
        ("before-evidenced-action", {"warningAt": early["warningAt"], "correctiveActionAt": early["riskAt"], "avoidanceEvidenced": True}, "timely"),
        ("after-action-before-risk", {**early, "correctiveActionAt": "2026-09-30T09:00:00Z", "avoidanceEvidenced": True}, "late"),
        ("missing-warning-time", {"riskAt": early["riskAt"]}, "unresolved"),
        ("undated-action", {"warningAt": early["warningAt"], "avoidanceEvidenced": True}, "unresolved"),
        ("unverified-avoidance", {"warningAt": early["warningAt"], "correctiveActionAt": early["riskAt"]}, "unresolved"),
        ("invalid-risk-time", {**early, "riskAt": "unknown"}, "unresolved"),
        ("no-risk", false, "false"),
    ]
    boundaries = []
    for name, episode, expected in boundary_inputs:
        outcome = warning_outcome(episode)
        assert outcome == expected
        boundaries.append({"case": name, "input": episode, "outcome": outcome})
    cohorts = []
    for name, episodes, failures in (("three-early-thirteen-late-four-false", [early]*3 + [late]*13 + [false]*4, 17),
                                     ("sixteen-early-four-false", [early]*16 + [false]*4, 4)):
        outcomes = [warning_outcome(episode) for episode in episodes]
        failed = sum(outcome != "timely" for outcome in outcomes)
        assert failed == failures
        cohorts.append({"case": name, "episodes": len(episodes), "failures": failed,
                        "failureRate": failed / len(episodes), "rateGatePasses": failed / len(episodes) <= .2,
                        "counts": {state: outcomes.count(state) for state in ("timely", "late", "false", "unresolved")}})
    return {"boundaries": boundaries, "cohorts": cohorts,
            "limit": "Synthetic rubric arithmetic only. The rate alone cannot satisfy the study's sample, business, usefulness or other gates."}


def economics_replays():
    cases = [
        {"id": "unfinished-overrun", "originalEstimateHours": 10, "actualHours": 12, "complete": False, "low": None, "high": None},
        {"id": "overrun-owner-scenario", "originalEstimateHours": 10, "actualHours": 12, "complete": False, "low": 2, "high": 4},
        {"id": "completed-overrun", "originalEstimateHours": 10, "actualHours": 12, "complete": True, "low": None, "high": None},
        {"id": "incomplete-under-estimate", "originalEstimateHours": 10, "actualHours": 4, "complete": False, "low": None, "high": None},
        {"id": "unestimated", "originalEstimateHours": None, "actualHours": 3, "complete": False, "low": None, "high": None},
        {"id": "explicit-zero-remaining", "originalEstimateHours": 10, "actualHours": 12, "complete": False, "low": 0, "high": 0},
    ]
    for case in cases:
        case["result"] = effort(case["actualHours"], case["complete"], case["low"], case["high"])
        case["estimateEvidence"] = "synthetic owner scenario, as of 2026-10-08" if case["low"] is not None else None
    assert cases[0]["result"]["totalHighHours"] is None
    assert cases[1]["result"]["totalLowHours"] == 14 and cases[1]["result"]["totalHighHours"] == 16
    assert cases[2]["result"]["remainingHighHours"] == 0
    for args, expected in [((12, False, 4, 2), "invalid_range"), ((12, False, -1, 2), "invalid_range"),
                           ((12, True, 2, 4), "completed_has_remaining"), ((-1, False, 0, 0), "negative_actual")]:
        try:
            effort(*args)
            raise AssertionError("Expected refusal")
        except ValueError as exc:
            assert str(exc) == expected
    # A project containing any unknown task cannot show a complete range.
    project = {"knownActualHours": sum(c["actualHours"] for c in (cases[0], cases[2], cases[4])),
               "unknownTaskIds": [cases[0]["id"], cases[4]["id"]], "totalLowHours": None, "totalHighHours": None}
    assert project["knownActualHours"] == 27
    money = {"currency": "DKK", "exponent": 2, "fixedFeeNetMinor": 1200000,
             "issuedNetMinorBeforeCredits": 800000, "issuedCreditNetMinor": 100000,
             "netIssuedMinor": 700000, "netIssuedGrossMinor": 875000,
             "grossReceiptMinor": 400000, "processorFeeMinor": 10000, "cashNetMinor": 390000,
             "allocatedMinor": 400000, "outstandingMinor": 475000,
             "projectedHourlyBillableValueLowMinor": 1400000, "projectedHourlyBillableValueHighMinor": 1600000,
             "internalCostRateMinorPerHour": 30000, "actualLaborCostMinor": 360000,
             "externalCostMinor": 50000, "actualDirectCostMinor": 410000,
             "remainingCostLowMinor": 60000, "remainingCostHighMinor": 120000,
             "forecastDirectCostLowMinor": 470000, "forecastDirectCostHighMinor": 530000,
             "forecastContributionLowMinor": 670000, "forecastContributionHighMinor": 730000,
             "excludedFromContribution": ["overhead", "tax", "FX", "processor fees", "scope changes"]}
    assert money["grossReceiptMinor"] == money["cashNetMinor"] + money["processorFeeMinor"]
    assert money["netIssuedGrossMinor"] - money["allocatedMinor"] == money["outstandingMinor"]
    assert money["fixedFeeNetMinor"] - money["forecastDirectCostHighMinor"] == money["forecastContributionLowMinor"]
    assert money["fixedFeeNetMinor"] - money["forecastDirectCostLowMinor"] == money["forecastContributionHighMinor"]
    return {"tasks": cases, "incompleteProject": project, "separateMoneyMeasures": money,
            "warning": "Hourly billable value is a separate pricing scenario, not additive to the fixed fee. Contribution is not accounting profit."}


def replay():
    return {"evidenceClass": "hypothetical metadata and economics fixtures; not application behavior or customer evidence",
            "asOf": "2026-10-08", "association": association_replays(),
            "draftAssociationRefusals": draft_association_replays(), "economics": economics_replays(),
            "frozenBuyerRefusals": frozen_buyer_replays(), "warningQuality": warning_quality_replays()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Compare committed results without writing files")
    args = parser.parse_args()
    output = json.dumps(replay(), indent=2, sort_keys=True) + "\n"
    target = ROOT / "results.json"
    if args.check:
        assert target.read_text() == output, "Committed results differ from deterministic replay"
    else:
        target.write_text(output)
    print("PASS: 4 financial cases x assign/correct/remove; 12 identity/revision, 4 draft and 18 frozen-buyer refusals; 6 effort cases; 4 invalid effort inputs; 10 warning timing controls and 2 cohorts; cash/cost invariants")
