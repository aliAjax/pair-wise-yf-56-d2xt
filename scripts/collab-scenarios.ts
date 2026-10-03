/* 协同语义场景验证：npx tsx 运行，不进生产包 */
import assert from 'node:assert/strict';
import {
  GENESIS_OPS,
  reconcile,
  toActionViews,
  type CollabOp,
  type Role
} from '../lib/collab';

let seq = 0;
function op(partial: {
  type: string;
  by?: Role;
  atOffset?: number;
  [key: string]: unknown;
}): CollabOp {
  seq += 1;
  const { atOffset = 1000 + seq, by = 'responder', ...rest } = partial;
  return {
    opId: `op-${seq}`,
    at: new Date(Date.now() - atOffset).toISOString(),
    by,
    clientId: 'test',
    ...rest
  } as CollabOp;
}

// history: 已提交上链的历史（阶段一，按时间戳回放）；late: 新发/离线补发的迟到批次（阶段二对账）
function run(history: CollabOp[], late: CollabOp[] = []) {
  const state = reconcile(history, late);
  return { state, views: toActionViews(state) };
}
const actOf = (views: ReturnType<typeof toActionViews>, id: string) => views.find((a) => a.id === id)!;

// 场景1：基线 —— act-1(isolate) 已有 1 名分析员审批，还需 1 名其他角色；act-3 已具备 1 名法务审批
{
  const { state, views } = run(GENESIS_OPS);
  assert.equal(actOf(views, 'act-1').status, 'pending');
  assert.equal(actOf(views, 'act-1').validApprovals.length, 1);
  assert.equal(actOf(views, 'act-3').status, 'approved');
  assert.equal(state.unmerged.length, 0);
  assert.deepEqual(state.acceptedLateIds, []);
  console.log('✔ 场景1：基线审批计数与双人门槛正确');
}

// 场景2：两人几乎同时提交同一动作同一版本的确认（作为两个端各自的迟到批次合入）
{
  const a = op({ type: 'approve', actionId: 'act-1', rev: 1, atOffset: 5000, by: 'responder' });
  const b = { ...a, opId: 'op-local-x', clientId: 'other-browser' }; // 同刻到达
  const { views } = run([...GENESIS_OPS, a], [b]);
  const a1 = actOf(views, 'act-1');
  assert.equal(a1.validApprovals.length, 2, '分析员+响应负责人两条均保留');
  assert.equal(a1.status, 'approved');
  console.log('✔ 场景2：并发双角色确认各留一条，隔离动作达双人门槛');
}

// 场景3：同一角色重复确认（含不同 opId 的重发）只算一次
{
  const dup1 = op({ type: 'approve', actionId: 'act-2', rev: 1, by: 'responder' });
  const dup2 = { ...dup1, opId: 'op-dup' };
  const { views } = run([...GENESIS_OPS, dup1], [dup2]);
  const a2 = actOf(views, 'act-2');
  assert.equal(a2.validApprovals.length, 1);
  assert.equal(a2.status, 'approved');
  console.log('✔ 场景3：同角色重复确认只算一次');
}

// 场景4：执行后审批窗口关闭，重复执行幂等；执行事实与审计不被后续事实更新改动
{
  const approve2 = op({ type: 'approve', actionId: 'act-1', rev: 1, by: 'responder', atOffset: 9000 });
  const exec = op({ type: 'execute', actionId: 'act-1', rev: 1, atOffset: 8000, by: 'responder' });
  const execDup = { ...exec, opId: 'op-exec-dup' };
  const facts = op({
    type: 'facts', rev: 2, status: 'investigating',
    affected: ['api-gateway', 'customer-portal', 'audit-log', 'billing-svc'], atOffset: 7000, by: 'analyst'
  });
  const lateApprove = op({ type: 'approve', actionId: 'act-1', rev: 2, atOffset: 6000, by: 'legal' });
  const { state, views } = run([...GENESIS_OPS, approve2, exec, facts], [execDup, lateApprove]);
  const a1 = actOf(views, 'act-1');
  assert.equal(a1.status, 'executed');
  assert.equal(a1.rev, 1, '已执行动作停留在执行时版本');
  assert.ok(a1.executedAt);
  // v1 的两条审批审计原样保留且仍随已执行动作有效
  const audit = state.approvals.filter((r) => r.actionId === 'act-1');
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((r) => r.stale), [false, false]);
  // 重复执行幂等（视作已合入）；针对 v2 的迟到审批因动作冻结在 v1 而合不上
  assert.ok(state.acceptedLateIds.includes(execDup.opId));
  assert.equal(state.unmerged.some((u) => u.op.opId === lateApprove.opId && u.reason === 'rev-mismatch'), true);
  console.log('✔ 场景4：已执行动作与审计记录保持原样，重复执行幂等，迟到新版本审批单列');
}

// 场景5：影响范围变化 → 未执行动作的旧审批立即作废、退回待确认，动作 rev 推进
{
  const approve = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 9000, by: 'responder' });
  const facts = op({
    type: 'facts', rev: 2, status: 'contained',
    affected: ['api-gateway', 'new-asset'], atOffset: 8000, by: 'analyst'
  });
  const { views } = run([...GENESIS_OPS, approve, facts]);
  const a2 = actOf(views, 'act-2');
  assert.equal(a2.rev, 2);
  assert.equal(a2.status, 'pending');
  assert.equal(a2.validApprovals.length, 0);
  assert.equal(a2.staleApprovals.length, 1, '旧版本审批作为审计保留但已作废');
  assert.equal(a2.staleApprovals[0].rev, 1);
  console.log('✔ 场景5：事实更新后未执行动作退回待确认，旧审批作废留痕');
}

// 场景6：事实更新后，按旧事实作出的"执行"作为迟到批次到达 —— 不生效，进未合并清单
{
  const approve = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 9000, by: 'responder' });
  const facts = op({
    type: 'facts', rev: 2, status: 'contained',
    affected: ['api-gateway', 'customer-portal', 'audit-log', 'x'], atOffset: 8000, by: 'analyst'
  });
  const staleExec = op({ type: 'execute', actionId: 'act-2', rev: 1, atOffset: 7000, by: 'responder' });
  const { state, views } = run([...GENESIS_OPS, approve, facts], [staleExec]);
  assert.equal(actOf(views, 'act-2').status, 'pending', '旧版本执行被拒绝');
  assert.equal(state.unmerged.some((u) => u.op.opId === staleExec.opId && u.reason === 'rev-mismatch'), true);
  assert.ok(!state.acceptedLateIds.includes(staleExec.opId));
  console.log('✔ 场景6：按旧事实的执行被拒绝并单独列出');
}

// 场景7：断网期间操作回网按 opId 合并 —— 与对端日志混合后幂等，无重复
{
  const offline = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 5000, by: 'responder' });
  const once = run(GENESIS_OPS, [offline]);
  const twice = run(GENESIS_OPS, [offline, { ...offline }]);
  assert.equal(actOf(once.views, 'act-2').validApprovals.length, 1);
  assert.equal(actOf(twice.views, 'act-2').validApprovals.length, 1, '同 opId 重传幂等');
  assert.equal(twice.state.unmerged.length, 0);
  console.log('✔ 场景7：离线操作按标识幂等合并');
}

// 场景8：离线期间事实已被对端推进，回网的旧 rev 审批作为迟到批次到达 —— 合不上，单列
{
  const remoteFacts = op({
    type: 'facts', rev: 2, status: 'contained',
    affected: ['api-gateway', 'customer-portal', 'audit-log', 'y'], atOffset: 6000, by: 'analyst'
  });
  const offlineApprove = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 4000, by: 'responder' });
  const { state, views } = run([...GENESIS_OPS, remoteFacts], [offlineApprove]);
  assert.equal(actOf(views, 'act-2').rev, 2);
  assert.equal(actOf(views, 'act-2').validApprovals.length, 0);
  assert.equal(state.unmerged.length, 1);
  assert.equal(state.unmerged[0].op.opId, offlineApprove.opId);
  assert.equal(state.unmerged[0].reason, 'rev-mismatch');
  console.log('✔ 场景8：离线旧版本操作回网后合不上，单独列出');
}

// 场景9：已执行动作不随事实推进，其版本审批仍可对账
{
  const approve2 = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 9000, by: 'responder' });
  const exec2 = op({ type: 'execute', actionId: 'act-2', rev: 1, atOffset: 8000, by: 'responder' });
  const facts = op({
    type: 'facts', rev: 2, status: 'contained',
    affected: ['api-gateway', 'customer-portal', 'audit-log', 'z'], atOffset: 7000, by: 'analyst'
  });
  const { views } = run([...GENESIS_OPS, approve2, exec2, facts]);
  assert.equal(actOf(views, 'act-2').status, 'executed');
  assert.equal(actOf(views, 'act-2').rev, 1);
  console.log('✔ 场景9：已执行动作不随事实推进，其版本审批仍可对账');
}

// 场景10：乱序到达（历史日志顺序打乱）回放结果确定一致
{
  const approve = op({ type: 'approve', actionId: 'act-2', rev: 1, atOffset: 9000, by: 'responder' });
  const exec = op({ type: 'execute', actionId: 'act-2', rev: 1, atOffset: 8000, by: 'responder' });
  const facts = op({
    type: 'facts', rev: 2, status: 'recovered',
    affected: ['api-gateway'], atOffset: 7000, by: 'analyst'
  });
  const ordered = [...GENESIS_OPS, approve, exec, facts];
  const shuffled = [facts, ...GENESIS_OPS.slice().reverse(), exec, approve];
  const a = run(ordered).state;
  const b = run(shuffled).state;
  assert.deepEqual(
    { rev: a.rev, status: a.status, affected: a.affected, approvals: a.approvals.length, executed: a.actions.map((x) => x.executedAt) },
    { rev: b.rev, status: b.status, affected: b.affected, approvals: b.approvals.length, executed: b.actions.map((x) => x.executedAt) }
  );
  console.log('✔ 场景10：操作乱序到达，确定性回放结果一致');
}

// 场景11：审批数不足时执行（迟到批次）被拒，进未合并清单
{
  // act-1 只有 genesis 的分析员 1 票，隔离需要 2 票
  const exec = op({ type: 'execute', actionId: 'act-1', rev: 1, by: 'responder' });
  const { state, views } = run(GENESIS_OPS, [exec]);
  assert.equal(actOf(views, 'act-1').status, 'pending');
  assert.equal(state.unmerged[0].reason, 'approval-threshold-non-positive');
  console.log('✔ 场景11：未达双人门槛的执行被拒绝并单列');
}

// 场景12：离线同一会话内先发事实更新、再按新版本审批 —— 回网批次按到达顺序全部合入
{
  const remoteFacts = op({
    type: 'facts', rev: 2, status: 'contained',
    affected: ['api-gateway', 'customer-portal', 'audit-log', 'w'], atOffset: 9000, by: 'analyst'
  });
  // 离线端在对端 v2 基础上继续推进 v3 并审批
  const localFacts = op({ type: 'facts', rev: 3, status: 'contained', affected: ['api-gateway'], atOffset: 5000, by: 'analyst' });
  const localApprove = op({ type: 'approve', actionId: 'act-2', rev: 3, atOffset: 4000, by: 'responder' });
  const { state, views } = run([...GENESIS_OPS, remoteFacts], [localFacts, localApprove]);
  assert.equal(state.rev, 3);
  assert.deepEqual(state.acceptedLateIds.sort(), [localFacts.opId, localApprove.opId].sort());
  assert.equal(actOf(views, 'act-2').rev, 3);
  assert.equal(actOf(views, 'act-2').validApprovals.length, 1);
  assert.equal(state.unmerged.length, 0);
  console.log('✔ 场景12：离线会话内事实+审批连续操作回网后顺序合入');
}

console.log('\n全部协同语义场景通过 ✅');
