-- CreateEnum
CREATE TYPE "PhotoStorageMode" AS ENUM ('both', 's3', 'db');

-- AlterTable
ALTER TABLE "Command" ADD COLUMN     "dependencyMode" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "operationId" TEXT,
ADD COLUMN     "personId" INTEGER,
ADD COLUMN     "photoId" TEXT,
ADD COLUMN     "predecessorId" INTEGER,
ADD COLUMN     "profileSnapshot" JSONB,
ALTER COLUMN "payload" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Person" (
    "id" SERIAL NOT NULL,
    "pin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "photoId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "mode" "PhotoStorageMode" NOT NULL,
    "s3Bucket" TEXT,
    "s3Key" TEXT,
    "bytes" BYTEA,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonOperation" (
    "id" TEXT NOT NULL,
    "personId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "deviceSns" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Person_pin_key" ON "Person"("pin");

-- CreateIndex
CREATE INDEX "PersonOperation_personId_createdAt_idx" ON "PersonOperation"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "Command_personId_deviceId_status_idx" ON "Command"("personId", "deviceId", "status");

-- CreateIndex
CREATE INDEX "Command_operationId_idx" ON "Command"("operationId");

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "PersonOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "Command"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonOperation" ADD CONSTRAINT "PersonOperation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
