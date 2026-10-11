import { test, expect, type Page } from "@playwright/test"
const confirm = (page: Page) => page.getByRole("button", { name: "Bekræft og opret", exact: true })
async function review(page: Page, scenario = "") {
  await page.goto(`/?scenario=${scenario}`)
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
  await page.getByRole("textbox", { name: "Navn", exact: true }).fill("Mit studio")
  await page.getByRole("spinbutton", { name: "Næste nummer" }).fill("42")
  await page.getByRole("spinbutton", { name: "Betalingsfrist (dage)" }).fill("30")
  await page.getByRole("textbox", { name: "Reg.nr.", exact: true }).fill("1234")
  await page.getByRole("textbox", { name: "Kontonr.", exact: true }).fill("12345678")
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
test("ceased has no presets and manual setup permits signup", async ({ page }) => {
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
test("no VAT and liquidation warning keep fields editable", async ({ page }) => {
  await review(page, "no-vat")
  await expect(page.getByRole("spinbutton", { name: "Moms %", exact: true })).toHaveValue("0")
  await expect(page.getByText(/Ifølge CVR er virksomheden ikke momsregistreret/)).toBeVisible()
  await page.getByRole("button", { name: "Annuller", exact: true }).click()
  await review(page, "warning")
  await expect(page.getByText(/Ifølge CVR er virksomheden under likvidation/)).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Navn", exact: true })).toHaveValue(
    "Nordlys Studio ApS",
  )
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
