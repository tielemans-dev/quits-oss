import { useEffect, useRef, useState, useCallback, type DependencyList } from "react"
import { getRequestOrganizationId } from "../lib/active-organization"
import { subscribeQueryRefresh, type QueryKey } from "../lib/query-refresh"

/** Subscribe without restarting requests when the caller renders or changes language. */
export function useQueryRefresh(keys: readonly QueryKey[], refresh: () => void) {
  const current = useRef(refresh)
  current.current = refresh
  const signature = keys.join(",")
  useEffect(() => subscribeQueryRefresh(signature.split(",") as QueryKey[], getRequestOrganizationId(), () => current.current()), [signature])
}

/** Retain data during refresh, but never hide a failed refresh behind stale/empty data. */
export function useAppQuery<T>(keys: readonly QueryKey[], query: () => Promise<T>, dependencies: DependencyList = []) {
  const current = useRef(query)
  current.current = query
  const [state, setState] = useState<{ data?: T; error: Error | null; loading: boolean }>({ error: null, loading: true })
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setState(previous => ({ ...previous, error: null, loading: previous.data === undefined }))
    try {
      const data = await current.current()
      if (request === generation.current) setState({ data, error: null, loading: false })
    } catch (error) {
      if (request === generation.current) setState(previous => ({ ...previous, error: error instanceof Error ? error : new Error(String(error)), loading: false }))
    }
  }, [])
  useQueryRefresh(keys, () => { void refresh() })
  useEffect(() => {
    setState({ error: null, loading: true })
    void refresh()
    return () => { generation.current++ }
  }, [refresh, ...dependencies])
  return { ...state, refresh }
}
