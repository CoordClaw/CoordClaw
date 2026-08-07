// 状态字段与 processing/ended 一一对应的唯一真相函数。
// 只在状态真变化时调用：processing 设 startedAt=now, endedAt=null；ended 设 endedAt=now。
// 不涉及 state / updatedAt / fixable —— 三者属各自原处赋值与业务逻辑，本次不动。

export interface StatusTimeFields {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}

export function setStatusAndTime(
  record: StatusTimeFields,
  status: string,
  endedAt?: number,
): void {
  record.status = status;
  if (status === "processing") {
    record.startedAt = new Date().toISOString();
    record.endedAt = null;
  } else {
    record.endedAt =
      endedAt != null ? new Date(endedAt).toISOString() : new Date().toISOString();
  }
}
