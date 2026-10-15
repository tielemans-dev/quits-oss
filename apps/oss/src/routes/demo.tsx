import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { I18nProvider } from '../lib/i18n/react'
import { QuitsWordmark } from '../components/brand/quits-wordmark'

export const Route = createFileRoute('/demo')({
  head: () => ({ meta: [{ title: 'Quits demo' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: DemoLayout,
})

function DemoLayout() {
  return <I18nProvider locale="en-US">
    <main lang="en" className="mx-auto min-h-svh w-full max-w-6xl px-4 py-8 sm:px-8">
      <nav aria-label="Demo" className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <Link to="/demo" aria-label="Quits demo"><QuitsWordmark className="h-6 w-auto" /></Link>
        <Link to="/demo" className="text-sm underline underline-offset-4">All demos</Link>
      </nav>
      <p className="mb-6 text-sm text-muted-foreground">Example data only. Changes stay in this demo and reset when you reload. No email is sent.</p>
      <Outlet />
    </main>
  </I18nProvider>
}
