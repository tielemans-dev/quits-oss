import { createFileRoute, notFound } from '@tanstack/react-router'
import { NotFoundPage } from '../../components/not-found'

/**
 * Any app path no route matches. Signed-in users get the 404 inside the app shell, in their
 * organization's language; the root 404 only knows the browser's language.
 */
export const Route = createFileRoute('/_app/$')({
  loader: () => {
    throw notFound()
  },
  notFoundComponent: () => <NotFoundPage inApp />,
})
