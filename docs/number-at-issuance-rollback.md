# Rolling back numbering at issuance

Invoices and quotes are numbered when they are issued, and draft rows may have no number. The
migration `20261009100000_number_at_issuance` drops `NOT NULL` from `invoice.number` and
`quote.number`. Code from before the change requires every invoice and quote to have a number, so
the database must be prepared before that code runs.

## Order

Do these in order, with the app stopped:

1. **Run the script.** It gives every invoice and quote draft without a number the next number of
   its organization, oldest first, then restores `NOT NULL` on both columns. It runs in one
   transaction: either everything is numbered and the columns are required again, or nothing
   changes.
2. **Deploy the previous release.**

Deploying the previous release first leaves it drafts without a number, which it cannot handle.
Restoring `NOT NULL` by hand fails while such drafts exist.

## Running the script

The database comes from `DATABASE_URL` (or the workspace `.env`).

```sh
# Show what would be numbered. Changes nothing.
node scripts/prepare-number-rollback.mjs --dry-run

# Do it. The value must be the database name in DATABASE_URL.
node scripts/prepare-number-rollback.mjs --confirm <database name>
```

Without `--dry-run` or `--confirm` it prints its usage and does nothing. A `--confirm` value that is
not the database name is refused.

For each organization that has numberless drafts the script takes the same lock the app takes to
issue a document (the organization's `org_settings` row, then the document rows). Each draft then
receives `prefix-NNNN` from the organization's live counter, which moves forward by one per draft.
Drafts that already have a number are untouched. Changing the column needs an exclusive lock on both
tables, so the script gives up after 30 seconds instead of waiting for a running app. Stop the app
and run it again.

## After rolling back

- The drafts keep the numbers the script gave them. Deleting one of them later leaves a gap, as it
  did before this change.
- The migration stays recorded in `_prisma_migrations`, so deploying a release with this change
  again would not drop `NOT NULL` a second time. Before you do, remove its record:
  `DELETE FROM _prisma_migrations WHERE migration_name = '20261009100000_number_at_issuance'`.
  `prisma migrate deploy` then applies it again.
- `document.number_voided` events with `reason: "draft_deleted"` stay in the activity log.
