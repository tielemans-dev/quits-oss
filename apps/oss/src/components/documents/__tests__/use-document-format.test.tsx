// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { I18nProvider } from "../../../lib/i18n/react"
import { LocalizedDateField } from "../../localized-date-field"
import { useDocumentFormat } from "../use-document-format"

afterEach(cleanup)

function DocumentDates() {
  const { date, calendarDate } = useDocumentFormat("Europe/Copenhagen")
  return <><p>{date("2026-10-11T23:30:00Z")}</p><p>{calendarDate("2026-10-11")}</p></>
}

it.each([
  ["da-DK", "12. okt. 2026", "11. okt. 2026", "Ryd"],
  ["en-US", "Oct 12, 2026", "Oct 11, 2026", "Clear"],
])("uses the org locale %s for displayed dates and the clear action", (locale, instant, calendar, clear) => {
  render(<I18nProvider initialLocale={locale}><DocumentDates /><LocalizedDateField locale={locale} value="2026-10-11" onChange={() => {}} placeholder="Date" /></I18nProvider>)
  expect(screen.getByText(instant)).toBeTruthy()
  expect(screen.getByText(calendar)).toBeTruthy()
  // Open the calendar so the optional clear action is rendered.
  fireEvent.click(screen.getByRole("button"))
  return screen.findByRole("button", { name: clear }).then(button => expect(button).toBeTruthy())
})
