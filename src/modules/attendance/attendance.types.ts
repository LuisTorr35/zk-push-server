/** Parsed attendance data, independent of HTTP and Prisma. */
export type AttendanceRecord = {
  pin: string;
  /** Terminal wall clock encoded as UTC components; not a UTC event instant. */
  localTime: Date;
  status: number;
  verifyType: number;
  raw: string;
};

export type AttendanceBatchResult = {
  created: number;
  duplicates: number;
};
