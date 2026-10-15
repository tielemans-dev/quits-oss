import type { PlaywrightTestArgs, PlaywrightWorkerArgs, TestType, expect } from '@playwright/test'
export type ProductFixtures = {
  account: { email: string; password: string }
  entryURL: string
}
export type ProductScenarioOptions = {
  /** Defaults to an editable 10% rate. Fixed rates require no summary tax input. */
  invoiceTax?: { ratePercent: number; editable: boolean }
}
export function registerProductScenarios(
  test: TestType<PlaywrightTestArgs & ProductFixtures, PlaywrightWorkerArgs>,
  assertions: typeof expect,
  options?: ProductScenarioOptions,
): void
