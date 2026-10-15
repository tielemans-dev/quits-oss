UPDATE "job_step" AS step
SET "labelParams" = jsonb_build_object('customerName', substring(step."label" FROM length('Rykker til ') + 1)),
    "label" = 'reminders.jobs.step'
FROM "job" AS job
WHERE job."id" = step."jobId" AND job."type" = 'reminders.batch'
  AND step."label" LIKE 'Rykker til %';

UPDATE "job" SET "title" = 'reminders.jobs.title' WHERE "type" = 'reminders.batch';
