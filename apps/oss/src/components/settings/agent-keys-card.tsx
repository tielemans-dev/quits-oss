import { Bot, Plus } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { AgentModeBadge } from "../agents/agent-mode-badge"
import { CreateAgentKeyDialog } from "../agents/create-agent-key-dialog"
import { formatDateTime } from "../agents/format"
import type { AgentAccess, AgentKeyRow } from "../agents/types"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table"

function keyStatus(key: AgentKeyRow): "active" | "revoked" | "expired" {
  if (key.revokedAt) return "revoked"
  if (key.expiresAt && new Date(key.expiresAt) <= new Date()) return "expired"
  return "active"
}

/** Agent keys in settings. Hidden entirely from people who cannot read agent keys. */
export function AgentKeysCard() {
  const { t, locale } = useI18n()
  const [access, setAccess] = useState<AgentAccess | null>(null)
  const [keys, setKeys] = useState<AgentKeyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await trpc.agents.listKeys.query())
      setError(null)
    } catch {
      setError(t("agents.keys.error.load"))
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    // Deferred so a failing client (e.g. a partial test mock) rejects instead of throwing in render.
    Promise.resolve()
      .then(() => trpc.agents.access.query())
      .then((result) => {
        if (cancelled) return
        setAccess(result)
        if (result.canRead) void loadKeys()
      })
      .catch(() => {
        // Membership errors are handled by the app layout.
      })
    return () => {
      cancelled = true
    }
  }, [loadKeys])

  async function revoke(id: string) {
    setRevoking(id)
    try {
      await trpc.agents.revokeKey.mutate({ id })
      await loadKeys()
    } catch {
      setError(t("agents.keys.revoke.error"))
    } finally {
      setRevoking(null)
    }
  }

  if (!access?.canRead) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("agents.keys.title")}</CardTitle>
        <CardDescription>{t("agents.keys.description")}</CardDescription>
        {access.canCreate ? (
          <CardAction>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />
              {t("agents.keys.create")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {keys === null ? (
          <p className="text-sm text-muted-foreground">{t("agents.keys.loading")}</p>
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <Bot className="size-8" />
            {t("agents.keys.empty")}
          </div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("agents.keys.column.name")}</TableHead>
                  <TableHead>{t("agents.keys.column.key")}</TableHead>
                  <TableHead>{t("agents.keys.column.mode")}</TableHead>
                  <TableHead>{t("agents.keys.column.scopes")}</TableHead>
                  <TableHead>{t("agents.keys.column.lastUsed")}</TableHead>
                  <TableHead>{t("agents.keys.column.status")}</TableHead>
                  <TableHead className="w-[100px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => {
                  const status = keyStatus(key)
                  return (
                    <TableRow key={key.id} className={status === "active" ? undefined : "opacity-60"}>
                      <TableCell>
                        <div className="font-medium">{key.name}</div>
                        {key.createdByName ? (
                          <div className="text-xs text-muted-foreground">
                            {t("agents.keys.createdBy", { name: key.createdByName })}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{key.displayPrefix}…</TableCell>
                      <TableCell>
                        <AgentModeBadge mode={key.mode} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm" title={key.scopes.join(", ")}>
                          {t("agents.keys.scopeCount", { count: key.scopes.length })}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {key.lastUsedAt ? formatDateTime(key.lastUsedAt, locale) : t("agents.keys.never")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status === "active" ? "secondary" : "outline"}>
                          {t(`agents.keys.status.${status}`)}
                        </Badge>
                        {status === "active" && key.expiresAt ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t("agents.keys.expiresOn", { date: formatDateTime(key.expiresAt, locale) })}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {access.canRevoke && !key.revokedAt ? (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="sm" disabled={revoking === key.id}>
                                {t("agents.keys.revoke")}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {t("agents.keys.revoke.title", { name: key.name })}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t("agents.keys.revoke.description")}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t("agents.keys.revoke.cancel")}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => void revoke(key.id)}>
                                  {t("agents.keys.revoke.confirm")}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {access.canCreate ? (
        <CreateAgentKeyDialog
          open={creating}
          onOpenChange={setCreating}
          grantableScopes={access.grantableScopes}
          onCreated={() => void loadKeys()}
        />
      ) : null}
    </Card>
  )
}
