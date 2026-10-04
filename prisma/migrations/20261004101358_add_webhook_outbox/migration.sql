-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('pending', 'sending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockToken" TEXT,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastHttpCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_sourceKey_key" ON "WebhookDelivery"("sourceKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_lockedUntil_idx" ON "WebhookDelivery"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_id_idx" ON "WebhookDelivery"("createdAt" DESC, "id" DESC);

-- Reservations consume an attempt even if the worker exits before sending HTTP.
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_attempt_budget_check"
  CHECK (attempts >= 0 AND "maxAttempts" BETWEEN 1 AND 100 AND attempts <= "maxAttempts");
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_lease_check"
  CHECK ((status = 'sending' AND "lockToken" IS NOT NULL AND "lockedUntil" IS NOT NULL)
    OR (status <> 'sending' AND "lockToken" IS NULL AND "lockedUntil" IS NULL));
