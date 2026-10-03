BEGIN;

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('pending', 'sent', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "Command" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "dedupeKey" TEXT,
    "returnCode" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandAttempt" (
    "id" SERIAL NOT NULL,
    "commandId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "respondedAt" TIMESTAMPTZ(3),
    "returnCode" INTEGER,

    CONSTRAINT "CommandAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Command_deviceId_status_priority_createdAt_id_idx" ON "Command"("deviceId", "status", "priority" DESC, "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommandAttempt_commandId_number_key" ON "CommandAttempt"("commandId", "number");

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only active commands share a dedupe key; completed commands keep history.
CREATE UNIQUE INDEX "Command_active_dedupe_key" ON "Command"("deviceId", "type", "dedupeKey")
WHERE "dedupeKey" IS NOT NULL AND "status" IN ('pending', 'sent');

-- Polling can only leave one delivery in progress for each device.
CREATE UNIQUE INDEX "Command_one_sent_per_device" ON "Command"("deviceId")
WHERE "status" = 'sent';

ALTER TABLE "Command" ADD CONSTRAINT "Command_attempt_limits"
CHECK ("maxAttempts" BETWEEN 1 AND 5 AND "attempts" BETWEEN 0 AND "maxAttempts");
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_positive_number"
CHECK ("number" BETWEEN 1 AND 5 AND "expiresAt" > "sentAt");
COMMIT;
