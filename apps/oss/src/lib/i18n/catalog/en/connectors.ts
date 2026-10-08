/** Connecting an AI app by signing in (MCP OAuth prototype). */
export const enConnectorsMessages = {
  "connectors.consent.title": "Connect {client} to Quits",
  "connectors.consent.description": "{client} is asking to work in {organization} on your behalf.",
  "connectors.consent.loading": "Loading the connection request...",
  "connectors.consent.error.load": "This connection request is no longer valid. Start again from your AI app.",
  "connectors.consent.error.decide": "Could not complete the connection. Your session, organization or access may have changed. Start again from your AI app.",
  "connectors.consent.returnTo": "After you decide, your browser returns to {host}.",
  "connectors.consent.loopbackWarning":
    "This app receives the answer on your own computer ({host}). Any program on this computer could claim to be it, so only continue if you started this connection yourself.",
  "connectors.consent.clientId": "App identifier: {id}",
  "connectors.consent.registration.metadata_document": "The app identified itself with its published metadata.",
  "connectors.consent.registration.dynamic": "The app registered itself with this server; its name is not verified.",
  "connectors.consent.cannotConnect":
    "Your role cannot connect AI apps. Ask an administrator, who can also create an agent key instead.",
  "connectors.consent.access": "Access level",
  "connectors.consent.requested": "The app asked for: {scopes}",
  "connectors.consent.scopeCount": "{count} permissions",
  "connectors.consent.preset.read_only": "Read only",
  "connectors.consent.preset.read_only.help": "Reads contacts, documents, payments and settings. Changes nothing.",
  "connectors.consent.preset.drafting_only": "Draft only",
  "connectors.consent.preset.drafting_only.help":
    "Creates and edits contacts and draft documents. Cannot send anything, issue credit notes or record payments.",
  "connectors.consent.preset.drafting_with_approved_sending": "Draft, and send with approval",
  "connectors.consent.preset.drafting_with_approved_sending.help":
    "Drafts freely. Sending documents, credit notes and payments wait in Approvals until a person approves them.",
  "connectors.consent.preset.full_access": "Full access",
  "connectors.consent.preset.full_access.help":
    "Does everything your role allows without asking, including sending documents to customers and recording payments.",
  "connectors.consent.fullAccessConfirm":
    "I understand {client} can send documents, issue credit notes and record payments without approval.",
  "connectors.consent.limits":
    "The connection never does more than your role allows, and stops working if you leave the organization or revoke it under Settings, Agent keys.",
  "connectors.consent.approve": "Connect",
  "connectors.consent.deny": "Cancel",
  "connectors.keys.badge": "Connected app",
} as const
