"""Validate synthetic discovery arithmetic. No application imports or external effects."""
import json
import sys
from copy import deepcopy
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def minor(value):
    require(type(value) is int, f"Not integer minor units: {value!r}")
    return value


def position(received=0, applied=0, refunded=0):
    return {
        "received": received,
        "applied": applied,
        "refunded": refunded,
        "available": received - applied - refunded,
    }


def available(funds):
    return funds["received"] - funds["applied"] - funds["refunded"]


def validate(data):
    ids = set()
    entries = 0
    documents = 0
    refusals = 0
    for scenario in data["scenarios"]:
        sid = scenario["id"]
        require(sid not in ids and scenario["synthetic"] is True, sid)
        ids.add(sid)
        ledger = defaultdict(int)
        funds = defaultdict(int)
        excess = defaultdict(int)
        tax = 0
        fiscal_net = 0
        snapshots = [0]
        for event in scenario["events"]:
            dr, cr = event["debits_minor"], event["credits_minor"]
            require(all(minor(v) >= 0 for v in [*dr.values(), *cr.values()]), sid)
            require(sum(dr.values()) == sum(cr.values()), f"Unbalanced: {sid}/{event['event']}")
            for account, amount in dr.items():
                ledger[account] += amount
            for account, amount in cr.items():
                ledger[account] -= amount
            for bucket, store in (("funds", funds), ("excess", excess)):
                for field, amount in event.get(bucket, {}).items():
                    require(field in {"received", "applied", "refunded"}, sid)
                    require(minor(amount) >= 0, sid)
                    store[field] += amount
                require(available(store) >= 0, f"Overspent {bucket}: {sid}")
            snapshots.append(available(funds))
            if "document" in event:
                document = event["document"]
                net, vat, gross = (minor(document[k]) for k in ("net_minor", "tax_minor", "gross_minor"))
                require(net + vat == gross, f"Document totals: {sid}")
                tax += vat
                fiscal_net += net
                if "source" in document:
                    source = document["source"]
                    require(source["net_minor"] + source["tax_minor"] == source["gross_minor"], sid)
                    for field in ("net_minor", "tax_minor", "gross_minor"):
                        converted = (Decimal(source[field]) * Decimal(source["dkk_per_eur"])).quantize(Decimal(1), rounding=ROUND_HALF_UP)
                        require(converted == document[field], f"FX conversion: {sid}/{field}")
                documents += 1
            entries += 1
        for account in set(ledger) | set(scenario["expected_balances_minor"]):
            require(ledger[account] == scenario["expected_balances_minor"].get(account, 0), f"Final {sid}/{account}: {ledger[account]}")
        require(sum(ledger.values()) == 0, sid)
        require(tax == -ledger["VAT"], f"Duplicate or missing VAT: {sid}")
        require(fiscal_net == -ledger["REV"] - ledger["AL"], f"Net consideration: {sid}")
        require(position(**dict(funds)) == scenario["expected_funds_minor"], f"Advance conservation: {sid}")
        require(position(**dict(excess)) == scenario.get("expected_excess_minor", position()), f"Excess conservation: {sid}")
        for refusal in scenario.get("refused_operations", []):
            before = snapshots[refusal["after_events"]]
            require(before == refusal["expected_available_minor"], sid)
            require(refusal["apply_minor"] > before, f"Refusal not justified: {sid}")
            refusals += 1
        if "tax_groups" in scenario:
            groups = scenario["tax_groups"]
            require(sum(g["tax_minor"] for g in groups) == tax, sid)
            require(sum(g["net_minor"] for g in groups) == fiscal_net, sid)
            require(sum(g["advance_net_minor"] + g["advance_tax_minor"] for g in groups) == funds["received"], sid)
    for probe in data["rounding_probes"]:
        require(sum(probe["slices_minor"]) == probe["gross_minor"], "Gross slices")
        used = prior_tax = 0
        taxes = []
        for amount in probe["slices_minor"]:
            used += amount
            cumulative = int((Decimal(probe["tax_minor"]) * used / probe["gross_minor"]).quantize(Decimal(1), rounding=ROUND_HALF_UP))
            taxes.append(cumulative - prior_tax)
            prior_tax = cumulative
        require(taxes == probe["expected_tax_slices_minor"] and sum(taxes) == probe["tax_minor"], "Cumulative tax rounding")
    retainers = data["retainer_probes"]
    capacity = retainers["capacity_minutes"]
    require(capacity["granted"] == sum(capacity[k] for k in ("used", "expired", "carried", "remaining")), "Capacity conservation")
    money = retainers["monetary_minor"]
    require(money["available"] == available(money), "Monetary retainer conservation")
    fixed = retainers["fixed_fee_minor"]
    require(fixed["invoice_1"] + fixed["invoice_2"] == fixed["received"] + fixed["receivable"] == fixed["net"] + fixed["tax"], "Fixed fee conservation")
    return f"PASS: {len(ids)} synthetic scenarios, {entries} balanced events, {documents} fiscal documents, {refusals} insufficient-credit refusal, {len(data['rounding_probes'])} rounding probes, 3 retainer probes. Arithmetic only."


def negative_controls(data):
    controls = []
    changed = deepcopy(data)
    changed["scenarios"][0]["events"][0]["debits_minor"]["AR"] += 1
    controls.append(("unbalanced posting", changed))
    changed = deepcopy(data)
    document = changed["scenarios"][0]["events"][0]["document"]
    document["tax_minor"] += 1
    document["net_minor"] -= 1
    controls.append(("tax mismatch despite conserved document gross", changed))
    changed = deepcopy(data)
    application = next(e for e in changed["scenarios"][0]["events"] if "applied" in e.get("funds", {}))
    application["funds"]["applied"] += 1
    controls.append(("overspent advance", changed))
    changed = deepcopy(data)
    fx = next(s for s in changed["scenarios"] if s["id"] == "fx_eur_review_only")
    fx["events"][0]["document"]["source"]["dkk_per_eur"] = "7.46"
    controls.append(("wrong historical FX rate", changed))
    changed = deepcopy(data)
    changed["scenarios"].append(deepcopy(changed["scenarios"][0]))
    controls.append(("duplicate scenario identity", changed))
    changed = deepcopy(data)
    changed["rounding_probes"][0]["expected_tax_slices_minor"] = [0, 0, 0]
    controls.append(("lost tax rounding cent", changed))
    for name, changed in controls:
        try:
            validate(changed)
        except ValueError:
            continue
        raise ValueError(f"Negative control was accepted: {name}")
    return f"PASS: {len(controls)} deliberately corrupted fixtures rejected."


if __name__ == "__main__":
    fixture_data = json.loads((ROOT / "fixtures.json").read_text())
    print(validate(fixture_data))
    if "--negative-controls" in sys.argv[1:]:
        print(negative_controls(fixture_data))
