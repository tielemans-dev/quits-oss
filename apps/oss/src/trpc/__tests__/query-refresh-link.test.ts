import { handledMutationError } from "../../lib/query-refresh"
import { describe, expect, it, vi } from 'vitest'
import { createAppTrpcClient } from '../client'
import { subscribeMutationErrors, subscribeQueryRefresh } from '../../lib/query-refresh'

function client(answer: unknown) {
  return createAppTrpcClient({url:'http://localhost/api/trpc',fetch:vi.fn(async()=>new Response(JSON.stringify([answer]),{headers:{'content-type':'application/json'}}))})
}
describe('mutation transport policy',()=>{
  it('refreshes readers for mutations made through the actual client',async()=>{
    const refresh=vi.fn()
    const stop=subscribeQueryRefresh(['invoices','dashboard'],null,refresh)
    try {
      await client({result:{data:{json:{id:'draft'}}}}).invoices.delete.mutate({id:'draft'})
      expect(refresh).toHaveBeenCalledOnce()
    } finally {stop()}
  })
  it('only refreshes failed operations that may partially commit and honors local error handling',async()=>{
    const refresh=vi.fn(), errors=vi.fn()
    const stop=subscribeQueryRefresh(['invoices'],null,refresh), stopErrors=subscribeMutationErrors(errors)
    const failed=client({error:{json:{message:'Rejected',code:-32600,data:{code:'BAD_REQUEST',httpStatus:400}}}})
    try {
      await expect(failed.invoices.delete.mutate({id:'draft'},handledMutationError)).rejects.toThrow('Rejected')
      expect(refresh).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
      await expect(failed.invoices.send.mutate({id:'draft'},handledMutationError)).rejects.toThrow('Rejected')
      expect(refresh).toHaveBeenCalledOnce()
      await expect(failed.reminders.sendNow.mutate({invoiceId:'draft'},handledMutationError)).rejects.toThrow('Rejected')
      expect(refresh).toHaveBeenCalledTimes(2)
      await expect(failed.agreements.send.mutate({id:'draft'},handledMutationError)).rejects.toThrow('Rejected')
      expect(refresh).toHaveBeenCalledTimes(3)
    } finally {stop();stopErrors()}
  })
  it('rejects failed mutations with the server message and reports even a swallowed failure',async()=>{
    const errors=vi.fn()
    const stop=subscribeMutationErrors(errors)
    try {
      const request=client({error:{json:{message:'Only draft invoices can be deleted',code:-32600,data:{code:'BAD_REQUEST',httpStatus:400}}}}).invoices.delete.mutate({id:'issued'})
      await expect(request).rejects.toThrow('Only draft invoices can be deleted')
      expect(errors.mock.calls[0][0].error.message).toBe('Only draft invoices can be deleted')
    } finally {stop()}
  })
})
