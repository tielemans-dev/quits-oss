# Onboarding v2 copy

The invoice declaration below is the approved QUI-56 wording. Validation failures expose these keys for the onboarding client to translate. An issued-document reset conflict uses `save.failed`.

| Key | DA | EN |
| --- | --- | --- |
| invoice.noVatNote | Der er ikke beregnet moms, da sælger ikke er momsregistreret. | No VAT charged – the seller is not VAT-registered. |
| cvr.invalid | Indtast et gyldigt CVR-nummer. | Enter a valid CVR number. |
| save.failed | Kunne ikke gemme. Prøv igen. | Could not save. Try again. |

`pdf.nonVatRegistered` retains a compatibility alias with the approved declaration. Historical declaration lines are removed only when creating future payment snapshots. Existing issued snapshots and artifacts are never rewritten.
