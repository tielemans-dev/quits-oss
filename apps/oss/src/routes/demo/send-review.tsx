import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SendConfirmation } from '../../components/invoices/send-confirmation'
import { PageHeader } from '../../components/kvit/page-header'
import { Button } from '../../components/ui/button'
import { demoInvoice } from './-data'

export const Route = createFileRoute('/demo/send-review')({ component: SendReviewDemo })

export function SendReviewDemo() {
  const [open, setOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  return <>
    <PageHeader title="Send review" subtitle={`${demoInvoice.number} · ${demoInvoice.recipient}`} />
    <Button onClick={() => { setConfirmed(false); setOpen(true) }}>Review example invoice</Button>
    {confirmed ? <p role="status" className="mt-4 text-sm">Demo confirmed. No email was sent.</p> : null}
    <SendConfirmation {...demoInvoice} open={open} onOpenChange={setOpen} pending={false}
      onConfirm={() => { setOpen(false); setConfirmed(true) }} />
  </>
}
