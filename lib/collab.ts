// 协同核心：把主事件、处置动作、审批记录和时间线统一为"操作日志 + 确定性回放"。
// 每个操作带全局唯一标识（opId），任意端（其他浏览器标签/离线补发）按标识幂等合并；
// 动作随事实版本（rev）续作：事实一变，未执行动作的旧审批立即作废、退回待确认，
// 已执行动作与全部审计记录原样保留。

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export const ROLE_NAMES: Record<Role, string> = {
  analyst: '分析员',
  responder: '响应负责人',
  legal: '法务/公关',
  viewer: '访客'
};

export type Severity = 'medium' | 'high' | 'critical';
export type IncidentStatus = 'investigating' | 'contained' | 'recovered';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';

export interface TimelineEvent {
  id: string;
  at: string;
  actor: string;
  source: 'collab' | 'local';
  text: string;
  sensitive?: boolean;
}

export interface SubIncident {
  id: string;
  title: string;
  owner: string;
  status: 'open' | 'contained' | 'closed';
}

export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  sensitive?: boolean;
  rev: number; // 当前动作版本：随主事件事实变化而递增
  executedAt?: string;
}

// 审批账册条目：审批一旦提交即成为不可变审计记录，按 (动作,版本,角色) 唯一
export interface ApprovalRecord {
  opId: string;
  actionId: string;
  rev: number;
  by: Role;
  at: string;
  stale: boolean; // 动作版本已推进：记录保留审计，当前不再生效
}

// ---- 协同操作（操作日志的单元，opId 为全局幂等标识）----
export type CollabOp =
  | { opId: string; at: string; by: Role; clientId: string; type: 'approve'; actionId: string; rev: number }
  | { opId: string; at: string; by: Role; clientId: string; type: 'execute'; actionId: string; rev: number }
  | {
      opId: string; at: string; by: Role; clientId: string;
      type: 'facts'; affected: string[]; status: IncidentStatus; rev: number;
    }
  | { opId: string; at: string; by: Role; clientId: string; type: 'sub'; subId: string; title: string; owner: string }
  | { opId: string; at: string; by: Role; clientId: string; type: 'reorder'; order: string[] };

export interface UnmergedOp {
  op: CollabOp;
  reason:
    | 'viewer-forbidden'
    | 'action-not-found'
    | 'rev-mismatch'
    | 'already-executed'
    | 'approval-threshold-non-positive'
    | 'unknown-type';
}

export interface ReconciledState {
  affected: string[];
  status: IncidentStatus;
  rev: number;
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  approvals: ApprovalRecord[];
  timeline: TimelineEvent[];
  unmerged: UnmergedOp[];
}

const now = Date.now();
const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

// 创世基线：初始事实、动作与两条种子审批（分别计入对应动作的 v1）
export const GENESIS_OPS: CollabOp[] = [
  { opId: 'gen-approve-1', at: iso(1_400_000), by: 'analyst', clientId: 'genesis', type: 'approve', actionId: 'act-1', rev: 1 },
  { opId: 'approve-3', at: iso(800_000), by: 'legal', clientId: 'genesis', type: 'approve', actionId: 'act-3', rev: 1 }
];

const BASELINE: Pick<ReconciledState, 'affected' | 'status' | 'rev' | 'subIncidents' | 'actions'> = {
  affected: ['api-gateway', 'customer-portal', 'audit-log'],
  status: 'investigating',
  rev: 1,
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', sensitive: true, rev: 1 },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', rev: 1 },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', sensitive: true, rev: 1 }
  ]
};

const BASELINE_TIMELINE: TimelineEvent[] = [
  { id: 'e1', at: iso(1_500_000), actor: '告警平台', source: 'collab', text: '检测到同一凭证跨三个地域登录', sensitive: true },
  { id: 'e2', at: iso(900_000), actor: '值班分析员', source: 'collab', text: '确认会话未经过常规办公出口' }
];

// 隔离（高风险动作）需两名不同角色确认；其余动作一名即可
export const requiredApprovals = (kind: ActionKind): number => (kind === 'isolate' ? 2 : 1);

export interface ReconcileResult extends ReconciledState {
  // 迟到批次中被接受（成功合入）的操作标识；未出现的即合不上、已列入 unmerged
  acceptedLateIds: string[];
}

export const compareOps = (a: CollabOp, b: CollabOp) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;

export const sortOpsSafe = (list: CollabOp[]): CollabOp[] => [...list].sort(compareOps);

// 两阶段确定性回放：
//  阶段一 baseOps —— 已提交上链的历史，按时间戳全序回放，任何端得到同一结果（解决并发覆盖）；
//  阶段二 lateOps —— 新发/断网补发的迟到批次，按"合并到达时刻"的当前事实与动作版本逐条校验，
//                   合得上的追加进历史，合不上的（版本对不上/门槛不足等）单独列入 unmerged。
export function reconcile(baseOps: CollabOp[], lateOps: CollabOp[] = []): ReconcileResult {
  const state: ReconciledState = {
    affected: [...BASELINE.affected],
    status: BASELINE.status,
    rev: BASELINE.rev,
    subIncidents: BASELINE.subIncidents.map((s) => ({ ...s })),
    actions: BASELINE.actions.map((a) => ({ ...a })),
    approvals: [],
    timeline: BASELINE_TIMELINE.map((e) => ({ ...e })),
    unmerged: []
  };

  const seenOpIds = new Set<string>(); // 按操作标识幂等：重复提交只生效一次
  const seenApprovalKeys = new Set<string>(); // 同角色对同一动作同一版本重复确认只算一次

  const pushTimeline = (event: TimelineEvent) => {
    state.timeline.push(event);
  };

  // 返回 true 表示该操作成功合入；false 表示合不上（原因已写入 state.unmerged 或被幂等忽略）
  const applyOp = (op: CollabOp): boolean => {
    switch (op.type) {
      case 'approve': {
        if (op.by === 'viewer') {
          state.unmerged.push({ op, reason: 'viewer-forbidden' });
          return false;
        }
        const action = state.actions.find((item) => item.id === op.actionId);
        if (!action) {
          state.unmerged.push({ op, reason: 'action-not-found' });
          return false;
        }
        // 基于旧事实（旧版本）作出的审批不能再对当前版本生效
        if (op.rev !== action.rev) {
          state.unmerged.push({ op, reason: 'rev-mismatch' });
          return false;
        }
        const key = `${op.actionId}|${op.rev}|${op.by}`;
        if (seenApprovalKeys.has(key)) return true; // 同一角色重复确认只算一次（幂等视作已合入）
        seenApprovalKeys.add(key);
        state.approvals.push({ opId: op.opId, actionId: op.actionId, rev: op.rev, by: op.by, at: op.at, stale: false });
        pushTimeline({
          id: `tl-${op.opId}`,
          at: op.at,
          actor: ROLE_NAMES[op.by],
          source: 'collab',
          text: `审批处置动作：${action.title}（v${op.rev}）`
        });
        return true;
      }
      case 'execute': {
        if (op.by === 'viewer') {
          state.unmerged.push({ op, reason: 'viewer-forbidden' });
          return false;
        }
        const action = state.actions.find((item) => item.id === op.actionId);
        if (!action) {
          state.unmerged.push({ op, reason: 'action-not-found' });
          return false;
        }
        if (action.executedAt) return true; // 已执行：重复执行幂等
        // 事件影响范围一变，按旧事实作出的审批不得拿去执行
        if (op.rev !== action.rev) {
          state.unmerged.push({ op, reason: 'rev-mismatch' });
          return false;
        }
        const valid = state.approvals.filter((r) => r.actionId === action.id && r.rev === action.rev);
        if (new Set(valid.map((r) => r.by)).size < requiredApprovals(action.kind)) {
          state.unmerged.push({ op, reason: 'approval-threshold-non-positive' });
          return false;
        }
        action.executedAt = op.at;
        pushTimeline({
          id: `tl-${op.opId}`,
          at: op.at,
          actor: ROLE_NAMES[op.by],
          source: 'collab',
          text: `执行处置动作：${action.title}（v${op.rev}）`,
          sensitive: action.sensitive
        });
        return true;
      }
      case 'facts': {
        if (op.by === 'viewer') {
          state.unmerged.push({ op, reason: 'viewer-forbidden' });
          return false;
        }
        const affectedSame =
          op.affected.length === state.affected.length && op.affected.every((v, i) => v === state.affected[i]);
        // 没有实质变化的提交（含重发）幂等忽略，不冲掉在途审批
        if (affectedSame && op.status === state.status) return true;
        // 并发/旧事实提交：版本必须恰好接续当前版本，否则单独列出
        if (op.rev !== state.rev + 1) {
          state.unmerged.push({ op, reason: 'rev-mismatch' });
          return false;
        }
        const prevAffected = state.affected;
        const prevStatus = state.status;
        state.affected = [...op.affected];
        state.status = op.status;
        state.rev = op.rev;
        // 尚未执行的动作随事实续作：版本推进、旧审批作废、动作退回待确认
        for (const action of state.actions) {
          if (!action.executedAt) action.rev = op.rev;
        }
        const statusNames: Record<IncidentStatus, string> = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' };
        const facts: string[] = [];
        if (!affectedSame) facts.push(`影响范围 ${prevAffected.join('、')} → ${op.affected.join('、')}`);
        if (prevStatus !== op.status) facts.push(`处置阶段 ${statusNames[prevStatus]} → ${statusNames[op.status]}`);
        pushTimeline({
          id: `tl-${op.opId}`,
          at: op.at,
          actor: ROLE_NAMES[op.by],
          source: 'collab',
          text: `主事件事实更新至 v${op.rev}：${facts.join('；') || '事实无变化'}；未执行动作已退回待确认`
        });
        return true;
      }
      case 'sub': {
        if (op.by === 'viewer') {
          state.unmerged.push({ op, reason: 'viewer-forbidden' });
          return false;
        }
        if (state.subIncidents.some((s) => s.id === op.subId)) return true; // 按标识幂等
        state.subIncidents.push({ id: op.subId, title: op.title, owner: op.owner, status: 'open' });
        pushTimeline({
          id: `tl-${op.opId}`,
          at: op.at,
          actor: ROLE_NAMES[op.by],
          source: 'collab',
          text: `创建子事件：${op.title}`
        });
        return true;
      }
      case 'reorder': {
        const known = new Set(state.actions.map((a) => a.id));
        if (op.order.some((id) => !known.has(id))) {
          state.unmerged.push({ op, reason: 'action-not-found' });
          return false;
        }
        const byId = new Map(state.actions.map((a) => [a.id, a]));
        const ordered = op.order.map((id) => byId.get(id)!).filter(Boolean);
        for (const action of state.actions) if (!op.order.includes(action.id)) ordered.push(action);
        state.actions = ordered;
        return true;
      }
      default: {
        state.unmerged.push({ op, reason: 'unknown-type' });
        return false;
      }
    }
  };

  // 阶段一：已提交历史按时间戳全序回放（历史中的操作都是合入过的，幂等去重即可）
  for (const op of [...baseOps].sort(compareOps)) {
    if (seenOpIds.has(op.opId)) continue;
    seenOpIds.add(op.opId);
    applyOp(op);
  }

  // 阶段二：迟到批次按到达顺序对照"当前"版本逐条对账
  const acceptedLateIds: string[] = [];
  for (const op of lateOps) {
    if (seenOpIds.has(op.opId)) { acceptedLateIds.push(op.opId); continue; }
    seenOpIds.add(op.opId);
    if (applyOp(op)) acceptedLateIds.push(op.opId);
  }
  // 阶段一历史回放出的异常不应出现（入历史的都是已接受操作）；未合并项只来自迟到批次
  state.unmerged = state.unmerged.filter((item) => lateOps.some((op) => op.opId === item.op.opId));

  // 审批账册标旧：记录原样保留（审计），仅标记对当前版本失效
  for (const record of state.approvals) {
    const action = state.actions.find((item) => item.id === record.actionId);
    record.stale = !action || record.rev !== action.rev;
  }

  state.unmerged.sort((a, b) => compareOps(a.op, b.op));
  state.timeline.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  return { ...state, acceptedLateIds };
}

export interface ActionView extends ResponseAction {
  status: 'pending' | 'approved' | 'executed';
  validApprovals: ApprovalRecord[];
  staleApprovals: ApprovalRecord[];
  required: number;
}

export function toActionViews(state: ReconciledState): ActionView[] {
  return state.actions.map((action) => {
    const records = state.approvals.filter((r) => r.actionId === action.id);
    const validApprovals = records.filter((r) => !r.stale);
    const staleApprovals = records.filter((r) => r.stale);
    const required = requiredApprovals(action.kind);
    const status: ActionView['status'] = action.executedAt
      ? 'executed'
      : new Set(validApprovals.map((r) => r.by)).size >= required
        ? 'approved'
        : 'pending';
    return { ...action, status, validApprovals, staleApprovals, required };
  });
}
