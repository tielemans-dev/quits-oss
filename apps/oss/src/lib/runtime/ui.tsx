import { createContext, useContext, type ComponentType, type ReactNode } from "react"

export type SettingsCompanyDetailsProps = {
  organizationId: string
  locale: string
}

export type RuntimeUiExtensions = {
  readonly settingsCompanyDetails?: ComponentType<SettingsCompanyDetailsProps>
}

const EMPTY_UI: RuntimeUiExtensions = {}
const RuntimeUiContext = createContext<RuntimeUiExtensions>(EMPTY_UI)

/** Scope UI extensions to one router tree, including during server rendering. */
export function RuntimeUiProvider({
  children,
  value = EMPTY_UI,
}: {
  children: ReactNode
  value?: RuntimeUiExtensions
}) {
  return <RuntimeUiContext.Provider value={value}>{children}</RuntimeUiContext.Provider>
}

export function useRuntimeUi() {
  return useContext(RuntimeUiContext)
}
