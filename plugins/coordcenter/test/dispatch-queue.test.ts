// 层A 轻量测试：信号层以下纯逻辑（分桶/排序/auto-reset 门控/状态映射），不启动 agent、不依赖 openclaw。
// 运行：npm test（esbuild bundle 为 mjs 后 node 执行，零新框架依赖）
import assert from "node:assert/strict";
import {
  buildDispatchQueue,
  compareFirstUnreadAt,
  needsT7ResetGate,
  type PendingDispatch,
} from "../message-routing/dispatch-queue";
import { mapToBusinessState } from "../message-routing/state/mapper";
import { AgentLifecycleState } from "../shared/types";

const mk = (o: Partial<PendingDispatch> = {}): PendingDispatch => ({
  ctxObj: {} as any,
  actionType: "msg1",
  actionLabel: "",
  isPM: false,
  isTrigger: false,
  agentName: "",
  agentId: "",
  mState: {},
  firstUnreadAt: null,
  ...o,
});

let pass = 0;
function check(name: string, fn: () => void): void {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

// --- 分桶顺序 + skip 丢弃 ---
check("分桶顺序 msg5>t7>msg2>msg1 且 skip 被丢弃", () => {
  const q = buildDispatchQueue([
    mk({ actionType: "msg1", isTrigger: true, firstUnreadAt: "T10" }),
    mk({ actionType: "t7", isTrigger: true }),
    mk({ actionType: "msg2" }),
    mk({ actionType: "msg5" }),
    mk({ actionType: "skip" }),
  ]);
  assert.deepEqual(q.map((e) => e.actionType), ["msg5", "t7", "msg2", "msg1"]);
});

// --- msg1 桶内按 firstUnreadAt 升序（滞留最久优先）---
check("msg1 桶内按 firstUnreadAt 升序（最早未读排前）", () => {
  const q = buildDispatchQueue([
    mk({ actionType: "msg1", firstUnreadAt: "T12" }),
    mk({ actionType: "msg1", firstUnreadAt: "T10" }),
    mk({ actionType: "msg1", firstUnreadAt: "T11" }),
  ]);
  assert.deepEqual(q.map((e) => e.firstUnreadAt), ["T10", "T11", "T12"]);
});

// --- 非传递比较器残留防护：null 沉底且不影响其余顺序 ---
check("firstUnreadAt 为 null 的元素沉底且不影响其余顺序", () => {
  const q = buildDispatchQueue([
    mk({ actionType: "msg1", firstUnreadAt: "T12" }),
    mk({ actionType: "msg1", firstUnreadAt: null }),
    mk({ actionType: "msg1", firstUnreadAt: "T10" }),
  ]);
  assert.deepEqual(q.map((e) => e.firstUnreadAt), ["T10", "T12", null]);
});

// --- needsT7ResetGate 门控（auto-reset 开关由状态驱动）---
check("trigger 需 t7 → 门控 true（不 reset，保留上下文发 t7）", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([mk({ actionType: "t7", isTrigger: true, blocksReset: true })])), true);
});
check("降级后 t7→msg1（blocksReset 被置 false）→ 放行 reset（门控认标志不认字符串）", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([mk({ actionType: "t7", isTrigger: true, blocksReset: false })])), false);
});
check("他人 t7 不阻塞 reset（门控只看 trigger 的 t7）", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([mk({ actionType: "t7", isTrigger: false })])), false);
});
check("降级 msg1（checktaskfeedback 关 → 队列无 t7）→ 放行 reset", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([mk({ actionType: "msg1", isTrigger: true })])), false);
});
check("PM msg2（口径 A：仅 t7 阻塞）→ 放行 reset", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([mk({ actionType: "msg2", isTrigger: true })])), false);
});
check("空队列 → 放行 reset", () => {
  assert.equal(needsT7ResetGate(buildDispatchQueue([])), false);
});

// --- mapToBusinessState 不变量（t7 仅此态产；状态映射是分桶/动作的前提）---
check("mapToBusinessState: !run & !unread & !sent → NEEDS_GROUPCHAT_FEEDBACK (t7 唯一来源态)", () => {
  assert.equal(mapToBusinessState(false, false, false), AgentLifecycleState.NEEDS_GROUPCHAT_FEEDBACK);
});
check("mapToBusinessState: running → RUNNING", () => {
  assert.equal(mapToBusinessState(true, false, false), AgentLifecycleState.RUNNING);
});
check("mapToBusinessState: !run & unread & !sent → NEEDS_GROUPCHAT_AND_UNREAD", () => {
  assert.equal(mapToBusinessState(false, true, false), AgentLifecycleState.NEEDS_GROUPCHAT_AND_UNREAD);
});
check("mapToBusinessState: !run & !unread & sent → COMPLETED_WITH_GROUPCHAT (→ skip/msg2)", () => {
  assert.equal(mapToBusinessState(false, false, true), AgentLifecycleState.COMPLETED_WITH_GROUPCHAT);
});
check("mapToBusinessState: !run & unread & sent → HAS_UNREAD_MESSAGES (→ msg1)", () => {
  assert.equal(mapToBusinessState(false, true, true), AgentLifecycleState.HAS_UNREAD_MESSAGES);
});

console.log(`\nALL PASS (${pass} checks)`);
