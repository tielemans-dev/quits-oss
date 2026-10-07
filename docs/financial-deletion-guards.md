# Financial deletion guards

Better Auth organization deletion is disabled in the shared auth options factory. This applies to
self-hosted runtimes, platform adapters, and the legacy factory alias. User deletion remains
disabled by Better Auth's existing default. Removing a membership or a user does not delete the
organization's financial records.

The database rejects deletion of parents with the following retained children:

| Parent | Child foreign keys using `Restrict` |
| --- | --- |
| Organization | OrgSettings, Contact, OrganizationTaxId, Invoice, Quote, CreditNote, Payment, RecurringInvoice, DomainEvent, Agreement, AgreementTemplate, AgentKey, ApprovalRequest, ArtifactStaging, IssuanceCandidate |
| Invoice | InvoiceItem, InvoiceReminder |
| Quote | QuoteItem |
| CreditNote | CreditNoteItem |
| Agreement | Deliverable |
| AgentKey | ApprovalRequest |

Artifact staging and issuance candidates retain render inputs and artifact references, so their
organization relations receive the same protection as the audited financial records. Existing
restricting links to contacts, invoices, agreements, deliverables and artifact staging keep their
deletion behavior.

Auth sessions, accounts, memberships and invitations keep their cascades. Unused contacts can still
be deleted with their contact tax IDs. Catalog items, scheduler scans and event-consumer operational
state retain their existing cascades. The optional links from invoices to recurring invoices and
from agreements to templates keep `SetNull`.
Jobs and command receipts have no organization foreign key, so organization deletion does not
cascade into them.

The application only physically deletes draft invoices, quotes and agreements. Their existing
commands check status and delivery or approval guards, then explicitly delete the permitted
children before deleting the parent in the same transaction. Invoice deletion also releases its
reserved agreement lines. A failed parent deletion rolls back child removal and line release.
Deletion events, issuance staging, approval evidence and public-link abuse counters remain.
Credit notes and payments have no physical-deletion command. Agent keys are revoked rather than
deleted. Agreement-template deletion keeps its existing behavior of clearing optional template
links.

Integration fixtures use `cleanupTestOrganizations` to delete only the selected organizations'
children bottom-up. This helper lives in `src/test-utils` and is not a production purge operation.
Tests that deliberately exercise direct deletion continue to call Prisma directly.

Migration `20261007220000_financial_deletion_guards` changes 21 foreign-key actions within one
PostgreSQL transaction. It does not remove or transform records. Replacing constraints takes table
locks and validates existing references. Ship the draft-command changes with the migration so draft
deletion continues to work once the constraints apply. The migration regression test upgrades a
populated pre-migration schema, compares complete financial rows, checks all changed constraints,
and confirms that other deletion actions remain unchanged.

These guards do not define retention periods, organization closure, anonymization, or a production
purge workflow. Those policies remain in the separate C5 design.
