import { createFileRoute, redirect } from '@tanstack/react-router'

/** The app calls contacts "Kunder"/"Customers", so `/customers/...` is a natural guess for `/contacts/...`. */
export const Route = createFileRoute('/customers/$')({
  beforeLoad: ({ params }) => {
    throw redirect({ href: params._splat ? `/contacts/${params._splat}` : '/contacts', replace: true })
  },
})
