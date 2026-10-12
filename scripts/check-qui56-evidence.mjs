import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

// CI invokes this only after BOTH capture commands exit successfully.
const [directory] = process.argv.slice(2)
const { BASELINE_SHA, HEAD_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
if (!directory || ![BASELINE_SHA, HEAD_SHA].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
  throw new Error('Evidence directory and immutable baseline/head SHAs required')
}
const images = []
for (const phase of ['before', 'after']) {
  const states = phase === 'before' ? ['manual', 'manual-entered'] : ['01-company', '01-results', '02-lookup', '03-review', 'manual', 'manual-entered']
  for (const language of ['da', 'en']) {
    for (const device of ['desktop', 'mobile']) {
      for (const state of states) {
        const file = `${phase}-${state}-${language}-${device}.png`
        const bytes = await readFile(join(directory, file))
        if (bytes.length < 1000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== (device === 'mobile' ? 390 : 1440)) {
          throw new Error(`Missing or invalid screenshot: ${file}`)
        }
        images.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
}
const actual = (await readdir(directory)).filter(file => file.endsWith('.png')).sort()
if (JSON.stringify(actual) !== JSON.stringify(images.map(image => image.file).sort())) throw new Error('Unexpected screenshot matrix')
const appRequire = createRequire(new URL('../apps/oss/package.json', import.meta.url))
const testRequire = createRequire(appRequire.resolve('@playwright/test/package.json'))
const playwrightRequire = createRequire(testRequire.resolve('playwright/package.json'))
const browser = JSON.parse(await readFile(join(dirname(playwrightRequire.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')).browsers.find(item => item.name === 'chromium')
await writeFile(join(directory, 'manifest.json'), JSON.stringify({
  status: 'complete; both real-auth capture commands exited successfully',
  applicationShas: { before: BASELINE_SHA, after: HEAD_SHA },
  harnessShas: { before: HEAD_SHA, after: HEAD_SHA },
  baseline: 'Independent exact current-main checkout resolved when the CI job started; no baseline source replacement',
  runURL: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}`,
  chromium: browser,
  workers: 1,
  screenshots: { before: 8, after: 24 },
  limits: [
    'Real auth, active organization, app routes and tRPC in a disposable localhost PostgreSQL database.',
    'Head capture configuration and assertions drive both applications; baseline uses its production Vite configuration.',
    'Both phases use the head-migrated disposable schema so the common head Prisma fixtures can run. Baseline application sources and generated client remain at the exact main SHA.',
    'After uses synthetic CVR and billing runtime providers. No production registry availability or hosted trial provisioning is validated.',
    'Manual-entered images precede confirmation and do not prove a completed manual save.',
    'DA/EN, desktop 1440x1000 and mobile 390x844, full-page light theme only. Ines approval remains required.',
  ],
  images,
}, null, 2) + '\n')
console.log('Verified 8 before and 24 after screenshots with SHA-256 hashes')
