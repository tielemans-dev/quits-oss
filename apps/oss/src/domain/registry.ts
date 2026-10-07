import type { AnyCommandDefinition } from "./command"
import { allCommands } from "./commands"

const commandsByType = new Map<string, AnyCommandDefinition>(
  allCommands.map((definition) => [definition.type, definition])
)

/** Looks up a command by type, e.g. to dispatch an approved agent request. */
export function getCommandDefinition(type: string): AnyCommandDefinition | undefined {
  return commandsByType.get(type)
}
