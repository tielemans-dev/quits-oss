import { useAppQuery } from "../../../hooks/use-query-refresh"
import { QueryError, QuerySkeleton } from "../../../components/query-state"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { trpc } from "../../../trpc/client"
import { Button } from "../../../components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table"
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
} from "../../../components/ui/alert-dialog"
import { Plus, Trash2, Users } from "lucide-react"
import { useI18n } from "../../../lib/i18n/react"
import { displayPhone } from "@quits/contracts/contacts"

export const Route = createFileRoute("/_app/contacts/")({
  component: ContactsListPage,
})

type Contact = {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  country: string | null
}

function ContactsListPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const list = useAppQuery(["contacts"], () => trpc.contacts.list.query())
  const contacts = (list.data ?? []) as unknown as Contact[]
  const loadContacts = list.refresh
  const loading = list.loading
  const [deleting, setDeleting] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      await trpc.contacts.delete.mutate({ id })
    } catch {
      // Silently fail — contact may already be deleted
    } finally {
      setDeleting(null)
    }
  }

  if (list.error) return <QueryError error={list.error} retry={loadContacts} />

  if (loading) {
    return (
      <div>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">{t("contacts.title")}</h1>
        </div>
        <QuerySkeleton />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("contacts.title")}</h1>
        <Button asChild>
          <Link to="/contacts/new">
            <Plus />
            {t("contacts.action.new")}
          </Link>
        </Button>
      </div>

      {contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Users className="size-12 text-muted-foreground mb-4" />
          <h2 className="text-lg font-semibold mb-1">
            {t("contacts.empty.title")}
          </h2>
          <p className="text-muted-foreground mb-4">
            {t("contacts.empty.description")}
          </p>
          <Button asChild>
            <Link to="/contacts/new">
              <Plus />
              {t("contacts.action.add")}
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("contacts.field.name")}</TableHead>
                <TableHead>{t("contacts.field.email")}</TableHead>
                <TableHead>{t("contacts.field.company")}</TableHead>
                <TableHead>{t("contacts.field.phone")}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({ to: "/contacts/$contactId", params: { contactId: contact.id }, search: {} })
                  }
                >
                  <TableCell className="font-medium">{contact.name}</TableCell>
                  <TableCell>{contact.email ?? "\u2014"}</TableCell>
                  <TableCell>{contact.company ?? "\u2014"}</TableCell>
                  <TableCell>{displayPhone(contact.phone, contact.country) || "\u2014"}</TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => e.stopPropagation()}
                          disabled={deleting === contact.id}
                          aria-label={t("contacts.action.delete")}
                        >
                          <Trash2 className="size-4 text-muted-foreground" />
                        </Button>
                      </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("contacts.delete.title")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("contacts.delete.description", { name: contact.name })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("contacts.action.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() => handleDelete(contact.id)}
                            >
                              {t("contacts.action.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
