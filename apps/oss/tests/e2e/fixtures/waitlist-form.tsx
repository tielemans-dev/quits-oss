import { createRoot } from "react-dom/client"
import { WaitlistForm } from "../../../src/components/auth/waitlist-form"
import { I18nProvider } from "../../../src/lib/i18n/react"

// Load this test fixture through Vite so its normal import transform handles
// React's CommonJS interop. Generated dependency URLs are not named-export APIs.
export function mountWaitlistForm() {
  const fixture = document.createElement("main")
  document.body.replaceChildren(fixture)
  createRoot(fixture).render(<I18nProvider locale="en"><WaitlistForm
    initialEmail="person@example.test" privacyVersion="2026-10-12.2" privacyPath="/privacy"
    onJoined={(email) => {
      const heading = document.createElement("h1")
      heading.textContent = `Joined as ${email}`
      heading.tabIndex = -1
      fixture.replaceChildren(heading)
      heading.focus()
    }}
  /></I18nProvider>)
}
