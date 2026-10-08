-- CreateTable
CREATE TABLE "client_action_link" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'none',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_action_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_action_grant" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "recordKind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "capabilities" TEXT[],
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_action_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_action_verification" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_action_verification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_action_link_organizationId_contactId_idx" ON "client_action_link"("organizationId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "client_action_grant_linkId_recordKind_recordId_key" ON "client_action_grant"("linkId", "recordKind", "recordId");

-- CreateIndex
CREATE INDEX "client_action_verification_linkId_createdAt_idx" ON "client_action_verification"("linkId", "createdAt");

-- AddForeignKey
ALTER TABLE "client_action_link" ADD CONSTRAINT "client_action_link_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_action_link" ADD CONSTRAINT "client_action_link_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_action_grant" ADD CONSTRAINT "client_action_grant_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "client_action_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_action_verification" ADD CONSTRAINT "client_action_verification_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "client_action_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;
