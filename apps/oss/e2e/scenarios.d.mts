import type { PlaywrightTestArgs, PlaywrightWorkerArgs, TestType, expect } from '@playwright/test'
export type ProductFixtures = {
  account: { email: string; password: string }
  entryURL: string
}
export function registerProductScenarios(
  test: TestType<PlaywrightTestArgs & ProductFixtures, PlaywrightWorkerArgs>,
  assertions: typeof expect,
): void
