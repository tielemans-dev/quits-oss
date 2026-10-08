/** Tilslutning af en AI-app ved login (MCP OAuth-prototype). */
export const daConnectorsMessages = {
  "connectors.consent.title": "Forbind {client} med Quits",
  "connectors.consent.description": "{client} beder om at arbejde i {organization} på dine vegne.",
  "connectors.consent.loading": "Henter forespørgslen...",
  "connectors.consent.error.load": "Forespørgslen er ikke længere gyldig. Start forfra i din AI-app.",
  "connectors.consent.error.decide": "Forbindelsen kunne ikke oprettes. Din session, organisation eller adgang kan have ændret sig. Start igen fra din AI-app.",
  "connectors.consent.returnTo": "Når du har valgt, sendes din browser tilbage til {host}.",
  "connectors.consent.loopbackWarning":
    "Appen modtager svaret på din egen computer ({host}). Ethvert program på computeren kan udgive sig for at være den, så fortsæt kun, hvis du selv har startet forbindelsen.",
  "connectors.consent.clientId": "App-id: {id}",
  "connectors.consent.registration.metadata_document": "Appen har identificeret sig med sine offentliggjorte oplysninger.",
  "connectors.consent.registration.dynamic": "Appen har selv registreret sig hos serveren; navnet er ikke bekræftet.",
  "connectors.consent.cannotConnect":
    "Din rolle kan ikke forbinde AI-apps. Spørg en administrator, som også kan oprette en agentnøgle i stedet.",
  "connectors.consent.access": "Adgangsniveau",
  "connectors.consent.requested": "Appen bad om: {scopes}",
  "connectors.consent.scopeCount": "{count} rettigheder",
  "connectors.consent.preset.read_only": "Kun læsning",
  "connectors.consent.preset.read_only.help": "Læser kontakter, dokumenter, betalinger og indstillinger. Ændrer intet.",
  "connectors.consent.preset.drafting_only": "Kun kladder",
  "connectors.consent.preset.drafting_only.help":
    "Opretter og redigerer kontakter og dokumentkladder. Kan ikke sende noget, udstede kreditnotaer eller registrere betalinger.",
  "connectors.consent.preset.drafting_with_approved_sending": "Kladder, og afsendelse med godkendelse",
  "connectors.consent.preset.drafting_with_approved_sending.help":
    "Laver kladder frit. Afsendelse af dokumenter, kreditnotaer og betalinger venter under Godkendelser, til en person godkender dem.",
  "connectors.consent.preset.full_access": "Fuld adgang",
  "connectors.consent.preset.full_access.help":
    "Gør alt, din rolle tillader, uden at spørge, herunder at sende dokumenter til kunder og registrere betalinger.",
  "connectors.consent.fullAccessConfirm":
    "Jeg forstår, at {client} kan sende dokumenter, udstede kreditnotaer og registrere betalinger uden godkendelse.",
  "connectors.consent.limits":
    "Forbindelsen gør aldrig mere, end din rolle tillader, og holder op med at virke, hvis du forlader organisationen eller tilbagekalder den under Indstillinger, Agentnøgler.",
  "connectors.consent.approve": "Forbind",
  "connectors.consent.deny": "Annuller",
  "connectors.keys.badge": "Forbundet app",
} as const
