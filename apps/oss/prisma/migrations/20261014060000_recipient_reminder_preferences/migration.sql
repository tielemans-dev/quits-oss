CREATE TABLE "recipient_reminder_preference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recipient_reminder_preference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "recipient_reminder_preference_organizationId_recipient_key" ON "recipient_reminder_preference"("organizationId", "recipient");
ALTER TABLE "recipient_reminder_preference" ADD CONSTRAINT "recipient_reminder_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
