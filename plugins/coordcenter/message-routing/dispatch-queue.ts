// 消息分发队列的核心纯函数：分桶拼接 + 仅 msg1 内排序 + auto-reset 门控。
// 设计约束：本文件不 import 任何依赖 openclaw / http-client 的模块，
// 以便在不启动 agent、不配 openclaw alias 的情况下独立单测（层A 纯逻辑测试）。

import type { AgentDispatchContext } from "../shared/types";

// 与 state-machine.ts 中 executeMessageRouting 内历史定义保持字段一致（actionType 为 string，非字面量联合，避免改生产语义）。
export interface PendingDispatch {
  ctxObj: AgentDispatchContext;
  actionType: string;
  actionLabel: string;
  isPM: boolean;
  isTrigger: boolean;
  agentName: string;
  agentId: string;
  mState: any;
  firstUnreadAt: string | null;
  blocksReset?: boolean;   // trigger 仍欠 t7（t7 方法输出声明）→ 禁止 auto-reset；门控只读此标志，不认 't7' 字符串
}

// 解耦核心: 列表分桶拼接 + 仅 msg1 桶内排序。skip 直接丢弃, 永不进排序(消除非传递比较器污染 msg1 顺序)。
export function compareFirstUnreadAt(a: PendingDispatch, b: PendingDispatch): number {
  const fa = a.firstUnreadAt, fb = b.firstUnreadAt;
  if (fa && fb) return fa.localeCompare(fb); // 最早未读(滞留最久)排前
  if (fa) return -1;                          // null 置最末, 保传递性
  if (fb) return 1;
  return 0;
}

export function buildDispatchQueue(list: PendingDispatch[]): PendingDispatch[] {
  const buckets: Record<string, PendingDispatch[]> = { msg5: [], t7: [], msg2: [], msg1: [] };
  for (const e of list) {
    if (e.actionType === 'skip') continue;            // skip 直接丢弃
    (buckets[e.actionType] ?? buckets.msg1).push(e);  // msg5/t7/msg2 各≤1, 占位无需排序
  }
  buckets.msg1.sort(compareFirstUnreadAt);             // 唯一真实排序, 隔离纯函数
  return [...buckets.msg5, ...buckets.t7, ...buckets.msg2, ...buckets.msg1];
}

// 状态驱动 auto-reset 门控：trigger 本轮回需发 t7（未完成/需群聊反馈）→ 返回 true（调用方据此跳过 reset）。
// 只认 t7 方法在源头声明的语义标志 blocksReset，永不匹配 't7' 字符串，使 t7 可自由增删机制/改名而不动本门控。
export function needsT7ResetGate(queue: PendingDispatch[]): boolean {
  return queue.some(e => e.isTrigger && e.blocksReset === true);
}
