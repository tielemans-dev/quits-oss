/**
 * Imports every module that registers scheduler tasks or job handlers. Entry points that run
 * the scheduler (the cron route, tests) import this once.
 */
import "./features/overdue"
import "./features/reminders"
import "./features/recurring"
import "./features/approvals"

import "./features/agreement-expiry"

import "./features/artifact-sweep"

// Job handlers that are not tied to a scheduled task, so a tick can run what a command queued.
import "./payment-details-notification"
