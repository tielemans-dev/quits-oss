import { createFileRoute, Link } from '@tanstack/react-router'
import { PageHeader } from '../../components/kvit/page-header'
import { demoPrototypes } from './-data'

export const Route = createFileRoute('/demo/')({ component: DemoIndex })

function DemoIndex() {
  return <>
    <PageHeader title="Quits demos" subtitle="Try the app components with example data. No account needed." />
    <ul className="divide-y border-y">
      {demoPrototypes.map(prototype => <li key={prototype.to}>
        <Link to={prototype.to} className="block py-5 focus-visible:outline-2 focus-visible:outline-ring">
          <span className="font-medium underline underline-offset-4">{prototype.title}</span>
          <p className="mt-1 text-sm text-muted-foreground">{prototype.description}</p>
        </Link>
      </li>)}
    </ul>
  </>
}
