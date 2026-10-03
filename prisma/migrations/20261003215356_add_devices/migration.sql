-- Migrate serial references into Device before removing the old column.
-- The transaction and table lock keep the backfill consistent with all rows.
BEGIN;
LOCK TABLE "AttendanceLog" IN ACCESS EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "Device" (
    "id" SERIAL NOT NULL,
    "sn" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT,
    "firmware" TEXT,
    "ip" TEXT,
    "lastSeenAt" TIMESTAMPTZ(3),
    "userCount" INTEGER,
    "faceCount" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_sn_key" ON "Device"("sn");

-- Add the relation as nullable while existing rows are backfilled.
ALTER TABLE "AttendanceLog" ADD COLUMN "deviceId" INTEGER;

INSERT INTO "Device" ("sn", "name", "updatedAt")
SELECT DISTINCT "deviceSn", 'Device ' || "deviceSn", CURRENT_TIMESTAMP
FROM "AttendanceLog";

UPDATE "AttendanceLog" AS attendance
SET "deviceId" = device."id"
FROM "Device" AS device
WHERE attendance."deviceSn" = device."sn";

ALTER TABLE "AttendanceLog" ALTER COLUMN "deviceId" SET NOT NULL;

CREATE INDEX "AttendanceLog_deviceId_localTime_idx" ON "AttendanceLog"("deviceId", "localTime");
CREATE UNIQUE INDEX "AttendanceLog_deviceId_pin_localTime_key" ON "AttendanceLog"("deviceId", "pin", "localTime");
ALTER TABLE "AttendanceLog" ADD CONSTRAINT "AttendanceLog_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every serial is now preserved in Device and linked to its attendance rows.
DROP INDEX "AttendanceLog_deviceSn_pin_localTime_key";
ALTER TABLE "AttendanceLog" DROP COLUMN "deviceSn";
COMMIT;
