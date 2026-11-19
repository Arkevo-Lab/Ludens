/** Pure timeline record payload DTO shared by run visuals and server query layer. */

export interface TimelineRecordDetail {
  recordId: string;
  sequence: number;
  data?: unknown;
  space?: unknown;
}
