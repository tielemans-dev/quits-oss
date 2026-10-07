import type { CommandDefinition } from "./command"
import type { ExecuteOptions, CommandOutcome } from "./execute"
export type IssuanceDispatcher = <I, R>(definition: CommandDefinition<I, R>, input: unknown, options: ExecuteOptions) => Promise<CommandOutcome<R>>
let dispatcher: IssuanceDispatcher | undefined
export function setIssuanceDispatcher(value: IssuanceDispatcher) { dispatcher = value }
export function getIssuanceDispatcher() { return dispatcher }
