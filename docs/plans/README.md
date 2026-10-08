# Maintainability Plans

1. `2026-03-09-t3code-aggressive-adoption-design.md` - approved architecture and migration design for the aggressive T3code-inspired adoption pass
2. `2026-03-09-t3code-aggressive-adoption.md` - executable implementation plan for the workspace split, contracts extraction, quality gates, observability, and browser coverage
3. Workspace split - move the app into `apps/oss` while preserving the published `@yaip/oss` surface
4. Contracts extraction - introduce shared schemas and branded IDs under `packages/contracts`
5. Shared runtime extraction - move reusable helpers into `packages/shared` with explicit exports
6. Effect boundary expansion - harden remote integrations without rewriting the app architecture
7. Browser smoke coverage - add Playwright coverage for setup, auth, public quote, invoice payment, and document sending
8. Structured observability - add JSONL logging for payment, onboarding, email, and public document flows
9. `2026-10-06-invoicing-lifecycle-and-agent-api-design.md` - domain command core, credit notes, payments, reminders, recurring invoices, e-invoice and accounting exports, audit log, and the MCP agent API
10. `2026-10-08-mcp-sign-in-authorization-design.md` - discovery and off-by-default prototype for connecting MCP clients by signing in (OAuth), built on agent keys (issue #31)
