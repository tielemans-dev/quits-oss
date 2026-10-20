import { createFileRoute, notFound } from '@tanstack/react-router'

/** Unknown example paths stay public 404s instead of falling through to the signed-in app's catch-all. */
export const Route = createFileRoute('/demo/$')({
  loader: () => {
    throw notFound()
  },
})
