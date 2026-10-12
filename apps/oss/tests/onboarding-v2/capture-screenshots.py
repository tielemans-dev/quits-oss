"""Capture the real onboarding components with deterministic transport fixtures.

Run under fleet-heavy with QUI56_BASELINE_DIR pointing to a detached main checkout
and the screenshots Vite server listening on port 4317. Python Playwright is required.
"""

import argparse
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from playwright.sync_api import sync_playwright

# The Nix C++ runtime is needed only to import greenlet, not by system Chromium.
os.environ.pop("LD_LIBRARY_PATH", None)

STATES = [
    ("before-manual", "baseline"),
    ("before-dashboard", "baseline-dashboard"),
    ("01-search", "search"),
    ("01-search-results", "results"),
    ("02-working", "working"),
    ("03-summary", "summary"),
    ("05-not-found", "not-found"),
    ("05b-invalid-cvr", "invalid"),
    ("06-several-matches", "several"),
    ("07-no-vat", "no-vat"),
    ("08-ceased", "ceased"),
    ("08b-warning", "warning"),
    ("09-lookup-failed", "lookup-fail"),
    ("10-timeout", "timeout"),
    ("11-manual", "manual"),
    ("12-dashboard", "dashboard"),
    ("15-save-failed", "save-failed"),
    ("16-confirming", "confirming"),
    ("17-agent-failed", "agent-fail"),
    ("18-suggestions-loading", "suggestions-loading"),
    ("19-restored", "restored"),
    ("20-bank-nudge", "bank-nudge"),
    ("21-bank-filled", "bank-filled"),
    ("22-bank-invalid", "bank-invalid"),
]


def capture_group(args, language, device, theme):
    english = language == "en"
    locale = "en-GB" if english else "da-DK"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chromium, env={**os.environ, "LD_LIBRARY_PATH": ""})
        try:
            for name, state in STATES:
                print(f"Starting {name}/{language}/{device}/{theme}", flush=True)
                context = browser.new_context(
                    viewport={"width": 390 if device == "mobile" else 1280, "height": 844 if device == "mobile" else 800},
                    color_scheme=theme, reduced_motion="reduce", locale=locale,
                )
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"{args.url}/screenshots.html?state={state}&locale={locale}&theme={theme}")
                try:
                    page.wait_for_load_state("networkidle", timeout=60_000)
                except Exception:
                    print(f"Readiness failed: {name}/{language}/{device}/{theme}, URL={page.url}, errors={errors}", flush=True)
                    raise
                print("Network ready", flush=True)
                page.evaluate("document.fonts.ready.then(() => true)")
                
                if state == "baseline":
                    page.get_by_text("Finish organization setup", exact=True).wait_for()
                elif state in {"dashboard", "baseline-dashboard"}:
                    page.locator('[data-slot="dashboard-first-run"]').wait_for()
                elif state == "bank-nudge":
                    page.get_by_role("button", name="Send invoice" if english else "Send faktura").click()
                    page.get_by_role("dialog").wait_for()
                else:
                    search = page.get_by_role("textbox", name="What's your company called?" if english else "Hvad hedder din virksomhed?")
                    search.wait_for()
                    if state == "invalid":
                        search.fill("1234567")
                        page.get_by_text("A CVR number has 8 digits" if english else "Et CVR-nummer har 8 cifre", exact=True).wait_for()
                    elif state == "not-found":
                        search.fill("00000000")
                        page.get_by_role("alert").wait_for()
                    elif state == "manual":
                        page.get_by_role("button", name="Set up manually instead" if english else "Opsæt manuelt i stedet", exact=True).click()
                    elif state != "search":
                        search.fill("Nordlys")
                        match = page.get_by_role("button", name="Continue with Nordlys Studio" if english else "Fortsæt med Nordlys Studio", exact=False)
                        match.wait_for()
                        if state not in {"results", "several"}:
                            match.click()
                            if state == "working":
                                page.get_by_role("heading", name="Looking up Nordlys Studio ApS" if english else "Slår Nordlys Studio ApS op").wait_for()
                            elif state in {"ceased", "lookup-fail", "timeout"}:
                                title = {"ceased": "Nordlys Studio ApS has ceased" if english else "Nordlys Studio ApS er ophørt", "lookup-fail": "We couldn't get data from CVR" if english else "Vi kunne ikke hente data fra CVR", "timeout": "The lookup is taking too long" if english else "Opslaget tager for lang tid"}[state]
                                page.get_by_role("heading", name=title).wait_for(timeout=15_000)
                            else:
                                page.get_by_role("heading", name="Check your settings" if english else "Tjek dine indstillinger").wait_for()
                                if state == "suggestions-loading":
                                    page.get_by_text("Finding suggestions…" if english else "Finder forslag…", exact=True).wait_for()
                                elif state == "agent-fail":
                                    page.get_by_text("Finding suggestions…" if english else "Finder forslag…", exact=True).wait_for(state="hidden")
                                else:
                                    page.get_by_role("heading", name="Suggestions" if english else "Forslag", exact=True).wait_for()
                                if state == "restored":
                                    page.reload()
                                    page.get_by_text("We've restored your settings." if english else "Vi har gendannet dine indstillinger.", exact=False).wait_for()
                                if state in {"bank-filled", "bank-invalid"}:
                                    page.get_by_role("textbox", name="Reg. no." if english else "Reg.nr.", exact=True).fill("1234" if state == "bank-filled" else "12")
                                    page.get_by_role("textbox", name="Account no." if english else "Kontonr.", exact=True).fill("1234567890")
                                if state in {"save-failed", "confirming", "bank-invalid"}:
                                    page.get_by_role("button", name="Confirm and create" if english else "Bekræft og opret", exact=True).click()
                                    if state == "save-failed":
                                        page.get_by_role("heading", name="We couldn't create your company" if english else "Vi kunne ikke oprette din virksomhed").wait_for()
                                    elif state == "confirming":
                                        page.get_by_role("button", name="Creating…" if english else "Opretter…", exact=True).wait_for()
                                    else:
                                        page.get_by_text("A reg. no. has 4 digits" if english else "Et reg.nr. har 4 cifre", exact=True).wait_for()
                if errors:
                    raise RuntimeError(f"{name}/{language}/{device}: {errors}")
                output = Path(args.output) / f"{name}-{language}-{device}-{theme}.png"
                output.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(output), full_page=True, animations="disabled")
                print(output.name, flush=True)
                context.close()
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4317")
    parser.add_argument("--output", required=True)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()
    if args.workers == 1:
        for theme in ("light", "dark"):
            for language in ("da", "en"):
                for device in ("desktop", "mobile"):
                    capture_group(args, language, device, theme)
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            jobs = [executor.submit(capture_group, args, language, device, theme) for theme in ("light", "dark") for language in ("da", "en") for device in ("desktop", "mobile")]
            for job in jobs:
                job.result()
