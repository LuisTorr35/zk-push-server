-- CreateTable
CREATE TABLE "AttendanceLog" (
    "id" SERIAL NOT NULL,
    "deviceSn" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "localTime" TIMESTAMP(3) NOT NULL,
    "status" INTEGER NOT NULL,
    "verifyType" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceLog_pin_idx" ON "AttendanceLog"("pin");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceLog_deviceSn_pin_localTime_key" ON "AttendanceLog"("deviceSn", "pin", "localTime");
