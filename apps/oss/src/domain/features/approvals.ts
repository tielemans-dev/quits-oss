import { recoverInterruptedApprovals } from "../approvals"
import { registerTickTask } from "../scheduler"

registerTickTask({
  name: "approvals",
  // Before jobs, so a recovered send's follow-up work is swept in the same tick.
  order: 900,
  run: async (now) => recoverInterruptedApprovals({ now }),
})
