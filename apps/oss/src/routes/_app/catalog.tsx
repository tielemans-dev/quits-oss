import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { Package, Pencil, Trash2 } from "lucide-react"
import { trpc } from "../../trpc/client"
import { formatCurrency } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
import { useOrgCurrency } from "../../hooks/use-org-currency"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table"

export const Route = createFileRoute("/_app/catalog" as never)({
  component: CatalogPage,
})

type CatalogItem = {
  id: string
  name: string
  description: string | null
  defaultUnitPrice: number
  isActive: boolean
}

function CatalogPage() {
  const { t, locale } = useI18n()
  const currency = useOrgCurrency()
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [newPrice, setNewPrice] = useState("")

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [editPrice, setEditPrice] = useState("")

  async function loadItems() {
    setLoading(true)
    setError(null)
    try {
      const data = await trpc.catalog.list.query()
      setItems(data as CatalogItem[])
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.loading"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadItems()
  }, [])

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items]
  )

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    const parsedPrice = Number(newPrice)
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return

    setSaving(true)
    setError(null)
    try {
      const created = await trpc.catalog.create.mutate({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        defaultUnitPrice: parsedPrice,
      })
      setItems((prev) => [...prev, created as CatalogItem])
      setNewName("")
      setNewDescription("")
      setNewPrice("")
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.addItem"))
    } finally {
      setSaving(false)
    }
  }

  function startEdit(item: CatalogItem) {
    setEditingId(item.id)
    setEditName(item.name)
    setEditDescription(item.description ?? "")
    setEditPrice(String(item.defaultUnitPrice))
  }

  async function handleSaveEdit() {
    if (!editingId) return
    if (!editName.trim()) return
    const parsedPrice = Number(editPrice)
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return

    setSaving(true)
    setError(null)
    try {
      const updated = await trpc.catalog.update.mutate({
        id: editingId,
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        defaultUnitPrice: parsedPrice,
      })
      setItems((prev) =>
        prev.map((item) => (item.id === editingId ? (updated as CatalogItem) : item))
      )
      setEditingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.save"))
    } finally {
      setSaving(false)
    }
  }

  async function handleArchive(id: string) {
    setSaving(true)
    setError(null)
    try {
      await trpc.catalog.archive.mutate({ id })
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.actions"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center gap-2 mb-6">
        <Package className="size-6" />
        <h1 className="text-2xl font-bold">{t("catalog.title")}</h1>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("catalog.addItem")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="new-item-name">{t("catalog.name")}</Label>
              <Input
                id="new-item-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("catalog.placeholder.consulting")}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-item-description">{t("catalog.description")}</Label>
              <Input
                id="new-item-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("catalog.placeholder.hourlyConsulting")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-item-price">{t("catalog.defaultUnitPrice")}</Label>
              <Input
                id="new-item-price"
                type="number"
                min="0"
                step="0.01"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder="150"
                required
              />
            </div>
            <div className="sm:col-span-3">
              <Button type="submit" disabled={saving}>
                {t("catalog.add")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("catalog.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("catalog.loading")}</p>
          ) : sortedItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("catalog.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("catalog.name")}</TableHead>
                  <TableHead>{t("catalog.description")}</TableHead>
                  <TableHead className="text-right">{t("catalog.defaultPrice")}</TableHead>
                  <TableHead className="text-right">{t("catalog.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedItems.map((item) => {
                  const isEditing = editingId === item.id
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        ) : (
                          item.name
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                          />
                        ) : (
                          item.description || "-"
                        )}
                      </TableCell>
                      <TableCell className="text-right num">
                        {isEditing ? (
                          <Input
                            className="ml-auto max-w-[140px]"
                            type="number"
                            min="0"
                            step="0.01"
                            value={editPrice}
                            onChange={(e) => setEditPrice(e.target.value)}
                          />
                        ) : (
                          formatCurrency(item.defaultUnitPrice, currency, locale)
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {isEditing ? (
                          <div className="inline-flex gap-2">
                            <Button
                              size="sm"
                              onClick={handleSaveEdit}
                              disabled={saving}
                              type="button"
                            >
                              {t("catalog.save")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingId(null)}
                              type="button"
                            >
                              {t("catalog.cancel")}
                            </Button>
                          </div>
                        ) : (
                          <div className="inline-flex gap-2">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => startEdit(item)}
                              type="button"
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => handleArchive(item.id)}
                              disabled={saving}
                              type="button"
                            >
                              <Trash2 className="size-4 text-muted-foreground" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
