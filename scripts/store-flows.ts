/* Store 协同流程验证：localStorage 垫片模拟多标签页与断网/回网 */
import assert from 'node:assert/strict';

// ---- 最小浏览器环境垫片（须在导入 store 前安装）----
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
}
const mem = new MemoryStorage();
(globalThis as Record<string, unknown>).localStorage = mem;
(globalThis as Record<string, unknown>).window = {
  localStorage: mem,
  addEventListener: () => undefined
};

async function main() {
const { useIncidentStore } = await import('../lib/store');
const s = () => useIncidentStore.getState();
// zustand persist 经微任务异步落盘，跨步骤读 storage 前先让出事件循环
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const find = (id: string) => s().actions.find((a) => a.id === id)!;

// 初始水合：genesis 两条审批已回放
assert.equal(find('act-1').validApprovals.length, 1);
assert.equal(find('act-1').status, 'pending'); // 隔离还需第二名不同角色
assert.equal(find('act-3').status, 'approved');
console.log('✔ 水合：种子操作日志回放正确');

// 两名值班员续作：响应负责人补第二票 → 批准 → 执行
s().setRole('responder');
s().approveAction('act-1');
assert.equal(find('act-1').status, 'approved');
assert.equal(new Set(find('act-1').validApprovals.map((r) => r.by)).size, 2);
s().executeAction('act-1');
assert.equal(find('act-1').status, 'executed');
assert.ok(find('act-1').executedAt);
console.log('✔ 双人确认 → 执行闭环');

// 同角色重复确认只算一次：首次确认新增一票，再点两次计数不再增长
const before = find('act-3').validApprovals.length;
s().approveAction('act-3');
assert.equal(find('act-3').validApprovals.length, before + 1);
s().approveAction('act-3');
s().approveAction('act-3');
assert.equal(find('act-3').validApprovals.length, before + 1);
console.log('✔ 同角色重复确认幂等');

// 断网：审批进本机发件箱，视图乐观显示（待回网对账）
s().toggleOnline();
assert.equal(s().online, false);
s().approveAction('act-2');
assert.equal(s().outbox.length, 1);
assert.equal(find('act-2').status, 'approved', '离线乐观显示为已批准');
assert.equal(s().pendingOpIds.size, 1, '该审批标记为待同步');
console.log('✔ 断网操作进入发件箱并乐观显示');

// 回网：按 opId 合并，act-2 变为已批准，无未合并项
s().toggleOnline();
await flush();
assert.equal(s().online, true);
assert.equal(s().outbox.length, 0);
assert.equal(find('act-2').status, 'approved');
assert.equal(s().unmerged.length, 0);
console.log('✔ 回网自动合并，视图收敛');

// 模拟"另一个标签页"（分析员）推进事实版本：直接改写共享存储再触发本页回放
const remoteWrite = (mutate: (state: Record<string, unknown>) => void) => {
  const raw = JSON.parse(mem.getItem('yf56-incident-store-v2')!);
  mutate(raw.state);
  mem.setItem('yf56-incident-store-v2', JSON.stringify(raw));
};
const rev = s().rev;
await flush();
remoteWrite((state) => {
  state.ops = [
    ...(state.ops as unknown[]),
    {
      opId: `remote-${Date.now()}`,
      at: new Date().toISOString(),
      by: 'analyst',
      clientId: 'other-browser',
      type: 'facts',
      rev: rev + 1,
      status: 'contained',
      affected: ['api-gateway', 'customer-portal', 'audit-log', 'newly-hit-host']
    }
  ];
});
s()._refresh();
assert.equal(s().rev, rev + 1);
assert.equal(find('act-2').status, 'pending', '未执行动作退回待确认');
assert.equal(find('act-2').rev, rev + 1);
assert.equal(find('act-2').staleApprovals.length, 1, '旧审批留痕但作废');
assert.equal(find('act-1').status, 'executed', '已执行动作保持原样');
assert.equal(find('act-1').rev, rev, '已执行动作版本冻结');
console.log('✔ 跨标签页事实更新：未执行动作失效退回，已执行动作与审计不动');

// 断网期间基于旧事实审批；回网时对端已再次推进版本 → 合不上，单列
s().toggleOnline();
const oldRev = s().rev;
s().approveAction('act-2'); // 发件箱里是 v(oldRev) 的审批
await flush();
remoteWrite((state) => {
  state.ops = [
    ...(state.ops as unknown[]),
    {
      opId: `remote2-${Date.now()}`,
      at: new Date().toISOString(),
      by: 'analyst',
      clientId: 'other-browser',
      type: 'facts',
      rev: oldRev + 1,
      status: 'contained',
      affected: ['api-gateway', 'customer-portal', 'audit-log', 'newly-hit-host', 'another']
    }
  ];
});
s()._refresh();
assert.equal(s().rev, oldRev + 1, '离线端也收到对端新版本');
s().toggleOnline(); // 回网冲发件箱
assert.equal(s().outbox.length, 0);
assert.equal(s().unmerged.length, 1);
assert.equal(s().unmerged[0].reason, 'rev-mismatch');
assert.equal(find('act-2').status, 'pending');
console.log('✔ 离线旧版本审批回网合不上，单独列出');

// 知悉后未合并清单清空（审计仍可在操作日志追溯）
s().dismissUnmerged(s().unmerged[0].op.opId);
assert.equal(s().unmerged.length, 0);
console.log('✔ 未合并项可人工知悉归档');

console.log('\nStore 协同流程全部通过 ✅');

}
main();
