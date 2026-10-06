import type { AnyCommandDefinition } from "../command"
import { contactCommands } from "./contacts"

/** Every command that can be queued for approval must be listed here. */
export const allCommands: readonly AnyCommandDefinition[] = [...contactCommands]
