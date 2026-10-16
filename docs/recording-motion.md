# Record motion for design review

Install the repo dependencies with `bun install --frozen-lockfile`, then install
Playwright's Chromium headless shell from the app workspace:

```sh
cd apps/oss && bunx playwright install --with-deps chromium
```

Install `ffmpeg` and `ffprobe` on PATH, with the `libx264` encoder available.
On Debian/Ubuntu use `sudo apt-get install ffmpeg`; on macOS use `brew install ffmpeg`.
Start the real app using the README's isolated development database instructions.
The recorder connects to running apps and never starts servers or migrates databases. From the repository root:

```sh
node scripts/record-motion.mjs /login --base-url http://localhost:3000 --out /tmp/login-motion
```

Before and after accept URLs only. To compare git refs, serve them separately:

```sh
git --no-pager worktree add /tmp/quits-before BEFORE_REF
git --no-pager worktree add /tmp/quits-after AFTER_REF
# Install dependencies and complete README's isolated Setup Worktree steps in each.
# In separate terminals, start Dev and note each allocated port, for example:
(cd /tmp/quits-before && bun run dev) # http://localhost:3101
(cd /tmp/quits-after && bun run dev)  # http://localhost:3102
node scripts/record-motion.mjs /login --before-url http://localhost:3101 --after-url http://localhost:3102 --out /tmp/ref-review
```

Without a baseline URL both sides record the same app. The output directory must
be new. A sibling temporary directory is renamed into place after verification;
capture/encoding failures remove it, so the same command can be retried. Frame-check
failures preserve the finished directory and exit 1 for inspection. `--help` lists all options.
On workstations with a heavy-command queue, wrap the recorder command in `fleet-heavy --`.

Outputs are `1x.mp4`, `0.25x.mp4`, `reduced-motion.mp4`, `before-1x.mp4`,
`before-after.mp4` with baseline left and candidate right, and `frames.png` with
up to twelve chronological candidate frames. `manifest.json` records timestamps,
URLs, dimensions, duration, and verified frame counts. Raw PNG sequences are deleted
by default; use `--keep-frames` to retain them. Delete the output directory to remove
a recording. Upload review assets to the PR rather than committing them. Ines signs off.

The recorder pauses Chromium virtual time between screenshots and explicitly
drives compositor frames, including CSS blur and backdrop-filter. It samples
normal motion at 240Hz: every fourth sample makes the 60fps 1x video; every sample
makes the 60fps quarter-speed video. Quarter speed has four times the duration
without interpolation or manufactured duplicate frames. Reduced motion
uses a fresh context with `prefers-reduced-motion: reduce` at 60Hz. App time rounds
up to a whole 60fps frame. Each MP4's decoded count, rate, and duration must pass
ffprobe checks before the command reports success. It never uses Playwright video.
Every capture also checks page and compositor timestamps against the sample time.

Capture begins after network idle, fonts, optional `--wait-for SELECTOR`, and an
optional scenario's `prepare(page)`. For hydrated routes, choose a selector that
appears after hydration. Entrance motion before readiness is outside the recording.
Frame control is already enabled during readiness and `prepare`: selectors must
become visible without animation frames. Use immediate actions such as fill,
dispatchEvent, or evaluate; click/hover stability checks and waits for animation
frames can hang here too. Use frame-independent readiness signals.
Use `--storage-state /path/to/auth.json` for authenticated routes. Keep auth state
outside git and use synthetic review data.

To record an interaction, pass `--scenario /absolute/path/interaction.mjs`:

```js
export async function prepare(page) {
  await page.locator('#email').fill('review@example.test')
}
export async function frame(page, { index }) {
  if (index === 0) await page.locator('#email').dispatchEvent('focus')
}
```

Hooks replay in fresh contexts for each capture. During `frame`, use dispatchEvent
or evaluate for immediate actions; actionability checks, navigation, timers, and
waiting for animation frames can deadlock against paused time. For later actions
use `timeMs` thresholds, accounting for the different sampling rates. Finish network
setup in `prepare`. Server responses, media playback, workers, and external clocks
are not deterministic; the recorder controls the page's JS and compositor clock.
Use the installed Playwright headless shell, since ordinary Chrome may not support
`HeadlessExperimental.beginFrame`. A protocol error fails the recording.

Run only the recorder's pure tests and touched-file lint locally:

```sh
node --test scripts/__tests__/record-motion.test.mjs
bunx --no-install vp lint --deny-warnings --report-unused-disable-directives scripts/record-motion*.mjs scripts/__tests__/record-motion.test.mjs
```

Optional local smoke check: `node --test scripts/record-motion.smoke.mjs` covers
readiness/scenario hooks, frame cleanup, retention, and retries. Wrap it in
`fleet-heavy --` where required; it is excluded from required CI tests.

Every recording automatically checks all captured samples, including baseline and
reduced motion. `after-checks.md`, `before-checks.md` when a separate baseline is
captured, and `reduced-checks.md` list failures with thumbnails and zero-based sample
numbers and app timestamps. Matching JSON reports include thresholds and values.
At 240Hz, sample N appears at N/4 in the 1x video and N in the quarter-speed video.
Reports and thumbnails survive default raw-frame cleanup.

Configure `--check-blank` for minimum grayscale standard deviation, default 2;
`--check-jump` for the fraction of pixels changing by more than 24 gray levels,
default 0.35; `--check-layout` for a Chromium layout-shift entry score, default 0.05;
and `--check-flicker` for a return-to-baseline window in milliseconds, default 100.
Blank and pixel checks use 64x36 grayscale images to suppress rendering noise.
Pop-in and flicker checks are heuristics; intentional large changes may need tuned
thresholds. Tiny or equal-luminance color changes can be missed. Layout checks
include input-related shifts, but exclude transform-only motion. Set blank to 0,
jump/layout to 1, or flicker to 0 to disable that check. Ines's visual sign-off is
still required. `node scripts/check-motion.mjs` enforces token use and named
transition properties through the scripts workspace lint command in CI.
