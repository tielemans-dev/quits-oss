import productionConfig from '../../vite.config'

// Capture-only runtime adapter. The real application routes, auth and tRPC remain intact.
export default {
  ...productionConfig,
  plugins: [
    ...(productionConfig.plugins ?? []),
    {
      name: 'synthetic-onboarding-runtime',
      enforce: 'pre' as const,
      transform(code: string, id: string) {
        if (!id.endsWith('/src/server.ts')) return
        return code.replace('export default', `
bootstrapQuitsRuntime({
 extensions: [{ id: 'synthetic-onboarding-capture', resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: false } }) }],
 services: {
  cvrLookupProvider: {
   search: async () => [{ cvr: '24256790', name: 'Synthetic Studio ApS', address: 'Testvej 1\\n1000 København', companyForm: 'ApS', momsRegistered: true, status: 'active', statusClass: 'active' }],
   get: async () => { await new Promise(resolve => setTimeout(resolve, 2500)); return { cvr: '24256790', name: 'Synthetic Studio ApS', address: 'Testvej 1\\n1000 København', companyForm: 'ApS', momsRegistered: true, status: 'active', statusClass: 'active' } },
  },
  billingProvider: { startTrial: async () => {}, getSubscription: async () => ({ status: 'trialing', priceId: null,
   organizationAccess: { state: 'trial', daysLeft: 14, trialStart: 1, trialEnd: 2, progress: 0 },
   access: { paidOnly: true, hasSubscription: false, checkoutAvailable: false, portalAvailable: false } }), assertInvoiceCreationAllowed: async () => {} },
 }
})
export default`)
      },
    },
  ],
}
