import { test, expect, type Page } from "@playwright/test"
const confirm = (page: Page) => page.getByRole("button", { name: "Bekræft og opret", exact: true })
async function review(page: Page, scenario = "", profile = "selfhost") {
  await page.goto(`/?scenario=${scenario}&profile=${profile}`)
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(page.getByRole("heading", { name: "Tjek dine indstillinger" })).toBeVisible()
}
test("happy path, bank, editable facts/defaults and removable suggestions", async ({ page }) => {
  let payload: Record<string, unknown> = {}
  await page.route("**/confirm", async (route) => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page)
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue("Nordlys Studio ApS")
  await expect(page.getByRole("textbox", { name: "Adresse", exact: true })).toHaveValue("Nørrebrogade 12, 2. tv.\n2200 København N")
  await page.getByRole("textbox", { name: "Navn", exact: true }).fill("Mit studio")
  await page.getByRole("spinbutton", { name: "Næste nummer" }).fill("42")
  await page.getByRole("spinbutton", { name: "Betalingsfrist (dage)" }).fill("30")
  await page.getByRole("textbox", { name: "Reg.nr.", exact: true }).fill("1234")
  await page.getByRole("textbox", { name: "Kontonr.", exact: true }).fill("12345678")
  await page.getByRole("checkbox", { name: /Designarbejde/ }).check()
  await page.getByRole("button", { name: "Fjern Små og mellemstore virksomheder" }).click()
  await confirm(page).click()
  await expect(page.getByRole("status")).toHaveText("KLAR")
  expect(payload).toMatchObject({
    companyName: "Mit studio",
    invoiceNextNum: 42,
    bank: { regNumber: "1234", accountNumber: "12345678" },
    settings: { paymentTermsDays: 30 },
    catalogSuggestions: [{ name: "Designarbejde" }],
  })
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
})
test("double click confirms once", async ({ page }) => {
  let writes = 0
  await page.route("**/confirm", async (route) => {
    writes++
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page)
  await confirm(page).dblclick()
  await expect(page.getByRole("status")).toHaveText("KLAR")
  expect(writes).toBe(1)
})
test("save failure keeps all values and reuses idempotency key", async ({ page }) => {
  const payloads: Array<Record<string, unknown>> = []
  await page.route("**/confirm", async (route) => {
    payloads.push(route.request().postDataJSON())
    await route.fulfill(
      payloads.length === 1 ? { status: 500, body: "failed" } : { json: { status: "complete" } },
    )
  })
  await review(page)
  await page.getByRole("textbox", { name: "Navn", exact: true }).fill("Rettet navn")
  await page.getByRole("textbox", { name: "Reg.nr.", exact: true }).fill("4321")
  await page.getByRole("textbox", { name: "Kontonr.", exact: true }).fill("987654")
  await confirm(page).click()
  await expect(
    page.getByRole("heading", { name: "Vi kunne ikke oprette din virksomhed" }),
  ).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue("Rettet navn")
  await expect(page.getByRole("textbox", { name: "Kontonr.", exact: true })).toHaveValue("987654")
  await expect(confirm(page)).toBeEnabled()
  await confirm(page).click()
  expect(payloads[0].idempotencyKey).toBe(payloads[1].idempotencyKey)
})
test("reload restores values and identity in the same tab", async ({ page }) => {
  await review(page)
  await page.getByRole("textbox", { name: "Navn", exact: true }).fill("Gendannet navn")
  const before = await page.evaluate(() =>
    sessionStorage.getItem("quits:onboarding:v2:fixture-user:fixture-org"),
  )
  await page.reload()
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue(
    "Gendannet navn",
  )
  await expect(
    page.getByText("Vi har gendannet dine indstillinger.", { exact: false }),
  ).toBeVisible()
  const after = await page.evaluate(() =>
    sessionStorage.getItem("quits:onboarding:v2:fixture-user:fixture-org"),
  )
  expect(JSON.parse(after!).idempotencyKey).toBe(JSON.parse(before!).idempotencyKey)
})
test("leaving clears the draft", async ({ page }) => {
  await review(page)
  await page.getByRole("link", { name: "Leave onboarding" }).click()
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
  await page.getByRole("link", { name: "Return to onboarding" }).click()
  await expect(page.getByRole("heading", { name: "Hvad hedder din virksomhed?" })).toBeVisible()
})
test("slow suggestions reserve layout and are dropped if confirmed first", async ({ page }) => {
  let payload: Record<string, unknown> = {}
  await page.route("**/confirm", async (route) => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page, "slow")
  await expect(page.getByText("Finder forslag…")).toBeVisible()
  const bank = page.getByRole("region", { name: "Bankkonto (valgfri)" })
  const before = await bank.boundingBox()
  await expect(page.getByRole("button", { name: "Fjern Designarbejde" })).toBeVisible({
    timeout: 8000,
  })
  const after = await bank.boundingBox()
  expect(after!.y).toBe(before!.y)
  await page.getByRole("button", { name: "Annuller", exact: true }).click()
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(page.getByText("Finder forslag…")).toBeVisible()
  await confirm(page).click()
  expect(payload).not.toHaveProperty("catalogSuggestions")
})
test("agent failure omits the suggestion card and allows confirmation", async ({ page }) => {
  await review(page, "agent-fail")
  await expect(page.getByText("Finder forslag…")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Forslag", exact: true })).toHaveCount(0)
  await expect(confirm(page)).toBeEnabled()
})
test("industry defaults survive research failure and are saved only after selection", async ({ page }) => {
  let payload: Record<string, unknown> = {}
  await page.route("**/confirm", async route => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page, "industry-fail")
  const line = page.getByRole("checkbox", { name: /Softwareudvikling/ })
  await expect(line).not.toBeChecked()
  await line.check()
  await page.reload()
  await expect(line).toBeChecked()
  await confirm(page).click()
  expect(payload.catalogSuggestions).toMatchObject([{ name: "Softwareudvikling" }])
})
test("ceased has no presets and manual entry remains available", async ({ page }) => {
  await reviewCeased(page)
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Opsæt manuelt", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Opsæt virksomheden selv" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue("")
  await expect(page.getByRole("combobox", { name: "Valuta", exact: true })).toHaveValue("DKK")
})
async function reviewCeased(page: Page) {
  await page.goto("/?scenario=ceased")
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(page.getByRole("heading", { name: "Nordlys Studio ApS er ophørt" })).toBeVisible()
}
test("invalid CVR, not found and several matches", async ({ page }) => {
  await page.goto("/?scenario=several")
  const search = page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" })
  await search.fill("1234")
  await expect(page.getByText("Et CVR-nummer har 8 cifre")).toBeVisible()
  await expect(search).toHaveAttribute("aria-invalid", "true")
  await search.fill("00000000")
  await expect(page.getByText(/Vi fandt ingen virksomhed med CVR/)).toBeVisible()
  await search.fill("Nordlys")
  await expect(page.getByText('2 virksomheder matcher "Nordlys".', { exact: false })).toBeVisible()
  await expect(page.getByText("Ophørt", { exact: true })).toBeVisible()
})
test("lookup failure, retry and 10 second timeout", async ({ page }) => {
  await page.goto("/?scenario=lookup-fail")
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(
    page.getByRole("heading", { name: "Vi kunne ikke hente data fra CVR" }),
  ).toBeVisible()
  await page.goto("/?scenario=timeout")
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(page.getByRole("heading", { name: "Opslaget tager for lang tid" })).toBeVisible({
    timeout: 11000,
  })
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveCount(0)
})
test("non-VAT businesses keep 0% and liquidation is refused", async ({ page }) => {
  await review(page, "no-vat")
  await expect(page.getByRole("spinbutton", { name: "Moms %", exact: true })).toHaveValue("0")
  await expect(page.getByText(/Ifølge CVR er virksomheden ikke momsregistreret/)).toBeVisible()
  await page.getByRole("button", { name: "Annuller", exact: true }).click()
  await page.goto("/?scenario=warning")
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
  await expect(page.getByRole("heading", { name: /Nordlys Studio ApS er/ })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveCount(0)
})
test("390px mobile and English copy", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await review(page)
  await expect(page.getByText("Trin 3/3", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: "test-results/onboarding-v2-mobile.png", fullPage: true })
  await page.getByRole("button", { name: "Annuller", exact: true }).click()
  await page.goto("/?locale=en-GB")
  await expect(page.getByRole("heading", { name: "What's your company called?" })).toBeVisible()
  await expect(page.getByText("Step 1/3", { exact: true })).toBeVisible()
})

for (const profile of ["selfhost", "hosted-non-vat"]) {
  for (const registered of [false, true]) {
    test(`${profile}: Ja/Nej choice ${registered} survives reload and is submitted`, async ({ page }) => {
      let payload: Record<string, unknown> = {}
      await page.route("**/confirm", async route => {
        payload = route.request().postDataJSON()
        await route.fulfill({ json: { status: "complete" } })
      })
      await review(page, registered ? "no-vat" : "", profile)
      const choice = page.getByRole("combobox", { name: "Momsregistreret?", exact: true })
      await expect(choice.getByRole("option", { name: "Ja", exact: true })).toHaveCount(1)
      await expect(choice.getByRole("option", { name: "Nej", exact: true })).toHaveCount(1)
      await choice.selectOption(String(registered))
      await page.reload()
      await expect(choice).toHaveValue(String(registered))
      await confirm(page).click()
      await expect(page.getByRole("status")).toHaveText("KLAR")
      expect(payload).toMatchObject({ momsRegistered: registered, settings: { taxRate: registered ? 25 : 0 } })
      if (registered) expect(payload.vatId).toBe("DK24256790")
      else expect(payload).not.toHaveProperty("vatId")
    })
  }
}

test("hosted VAT-only setup requires an explicit answer and finishes with keyboard input", async ({ page }) => {
  const payloads: Array<Record<string, unknown>> = []
  await page.route("**/confirm", async route => {
    payloads.push(route.request().postDataJSON())
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page, "no-vat", "hosted-vat-only")
  const choice = page.getByRole("combobox", { name: "Momsregistreret?", exact: true })
  await expect(choice).toHaveValue("")
  await expect(choice.getByRole("option", { name: "Ja", exact: true })).toHaveCount(1)
  await expect(choice.getByRole("option", { name: "Nej", exact: true })).toHaveCount(0)
  await expect(page.getByRole("spinbutton", { name: "Moms %", exact: true })).toHaveValue("0")
  await confirm(page).click()
  await expect(page.getByRole("heading", { name: "Tjek dine indstillinger" })).toBeVisible()
  expect(payloads).toHaveLength(0)
  await expect(page.getByText("Bekræft, om du er momsregistreret.", { exact: true })).toBeVisible()
  await expect(choice).toBeFocused()
  // Native keyboard input must change the actual answer, without dispatching an event.
  await choice.press("ArrowDown")
  await choice.press("Enter")
  await expect(choice).toHaveValue("true")
  await confirm(page).click()
  await expect(page.getByRole("status")).toHaveText("KLAR")
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ momsRegistered: true, vatId: "DK24256790", settings: { taxRate: 25 } })
})

test("hosted VAT-only registry mismatch can be answered before the first submit", async ({ page }) => {
  let payload: Record<string, unknown> = {}
  await page.route("**/confirm", async route => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { status: "complete" } })
  })
  await review(page, "no-vat", "hosted-vat-only")
  const choice = page.getByRole("combobox", { name: "Momsregistreret?", exact: true })
  await expect(choice).toHaveValue("")
  await choice.click()
  await choice.press("ArrowDown")
  await choice.press("Enter")
  await expect(choice).toHaveValue("true")
  await confirm(page).click()
  await expect(page.getByRole("status")).toHaveText("KLAR")
  expect(payload).toMatchObject({ momsRegistered: true, settings: { taxRate: 25 } })
})

test("manual review requires a CVR and keeps the VAT choice", async ({ page }) => {
  let payload: Record<string, unknown> = {}
  await page.route("**/confirm", async (route) => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { status: "complete" } })
  })
  await page.goto("/?scenario=lookup-down&profile=hosted&confirmation=1")
  await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
  await expect(page.getByRole("heading", { name: "Vi kunne ikke hente data fra CVR" })).toBeVisible()
  await page.getByRole("button", { name: "Opsæt manuelt", exact: true }).click()
  const create = page.getByRole("button", { name: "Opret virksomhed", exact: true })
  await expect(create).toBeEnabled()
  await page.getByRole("textbox", { name: "Navn", exact: true }).fill("Nordlys Test ApS")
  await page.getByRole("textbox", { name: "Adresse", exact: true }).fill("Testvej 1\n1000 København K")
  const cvr = page.getByRole("textbox", { name: "CVR-nummer", exact: true })
  await create.click()
  await expect(cvr).toHaveAttribute("aria-invalid", "true")
  expect(payload).toEqual({})
  await cvr.fill("24256790")
  // Clicking without a VAT answer explains and focuses it instead of a silent native block.
  await create.click()
  await expect(page.getByRole("radio", { name: "Jeg er momsregistreret" })).toBeFocused()
  expect(payload).toEqual({})
  await page.getByRole("radio", { name: "Jeg er momsregistreret" }).check()
  // Noah's prod order: VAT first, then a rejected CVR, then a valid one.
  await cvr.fill("12345678")
  await cvr.fill("24256790")
  await expect(page.getByRole("radio", { name: "Jeg er momsregistreret" })).toBeChecked()
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByRole("status")).toHaveText("KLAR")
  expect(payload).toMatchObject({ source: "manual", companyName: "Nordlys Test ApS", cvr: "24256790", momsRegistered: true, vatId: "DK24256790" })
})

for (const [locale, refusal, free] of [
  ["da-DK", "quits er til virksomheder med CVR-nummer", "Du kan gratis registrere en enkeltmandsvirksomhed og få et CVR-nummer på virk.dk."],
  ["en-GB", "quits is for businesses with a CVR number", "You can register a sole proprietorship and get a CVR number for free at virk.dk."],
]) test(`B2B refusal and free CVR guidance appear in ${locale}`, async ({ page }) => {
  await page.goto(`/?locale=${locale}`)
  await expect(page.getByText(`${refusal}. ${free}`, { exact: true })).toBeVisible()
  await page.screenshot({ path: `test-results/qui147-refusal-${locale}.png`, fullPage: true })
})

test("organization creation hands off to a registry-prefilled review", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("quits:onboarding:selected-company:v1:fixture-user:fixture-org",
    JSON.stringify({ cvr: "24256790", name: "Untrusted", address: "Untrusted" })))
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue("Nordlys Studio ApS")
  await expect(page.getByRole("textbox", { name: "Adresse", exact: true })).toHaveValue("Nørrebrogade 12, 2. tv.\n2200 København N")
})

for (const locale of ["en-US", "da-DK"]) for (const width of [1280, 390]) {
  test(`CVR contact fallback notice in ${locale} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/?locale=${locale}`)
    await page.getByRole("textbox").fill("Nordlys")
    await page.getByRole("button", { name: /Nordlys Studio ApS/ }).click()
    const note = page.getByRole("note")
    await note.scrollIntoViewIfNeeded()
    await expect(note).toBeVisible()
    await expect(note).toContainText("billing@example.com")
    await expect(note).toContainText(locale === "da-DK" ? "reklamebeskyttet" : "advertising-protected")
    await expect(note).toContainText(locale === "da-DK" ? "Indstillinger" : "Settings")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.reload()
    await expect(note).toHaveCount(1)
  })
}

test.describe("hosted card payments step", () => {
  async function toPaymentsStep(page: Page, locale = "") {
    await page.route("**/confirm", (route) => route.fulfill({ json: { status: "complete" } }))
    await page.goto(`/?payments=1&profile=hosted-non-vat${locale}`)
    await page.getByRole("textbox", { name: "Hvad hedder din virksomhed?" }).fill("Nordlys")
    await page.getByRole("button", { name: /Fortsæt med Nordlys Studio/ }).click()
    await confirm(page).click()
    await expect(page.getByRole("heading", { name: "Få betalt med kort og MobilePay" })).toBeVisible()
  }
  test("can be skipped, and Stripe is only contacted on request", async ({ page }) => {
    let connects = 0
    await page.route("**/connect", (route) => { connects++; return route.fulfill({ json: { redirected: true } }) })
    await toPaymentsStep(page)
    await expect(page.getByRole("listitem").filter({ hasText: "Betaling" })).toHaveAttribute("aria-current", "step")
    await page.getByRole("button", { name: "Spring over for nu" }).click()
    await expect(page.getByRole("status")).toHaveText("KLAR")
    expect(connects).toBe(0)
  })
  test("a failed Connect start keeps the step and can be retried or skipped", async ({ page }) => {
    await page.route("**/connect", (route) => route.fulfill({ status: 500, json: {} }))
    await toPaymentsStep(page)
    await page.getByRole("button", { name: "Forbind Stripe" }).click()
    await expect(page.getByText("Vi kunne ikke åbne Stripe")).toBeVisible()
    await expect(page.getByRole("button", { name: "Forbind Stripe" })).toBeEnabled()
    await page.getByRole("button", { name: "Spring over for nu" }).click()
    await expect(page.getByRole("status")).toHaveText("KLAR")
  })
  test("390px mobile screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await toPaymentsStep(page)
    await expect(page.getByText("Trin 4/4", { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await page.screenshot({ path: "test-results/onboarding-payments-390.png", fullPage: true })
  })
})
