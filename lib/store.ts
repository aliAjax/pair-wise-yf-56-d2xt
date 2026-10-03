import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Role = 'analyst' | 'responder' | 'legal' | 'viewer';
export type Severity = 'medium' | 'high' | 'critical';
export type IncidentStatus = 'investigating' | 'contained' | 'recovered';
export type ActionKind = 'isolate' | 'block' | 'restore' | 'notify';
export type ActionStatus = 'pending' | 'approved' | 'executed';

export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; tempId?: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ApprovalRecord { id: string; role: Role; version: number; at: string; }
export interface ResponseAction {
  id: string;
  title: string;
  kind: ActionKind;
  approvals: ApprovalRecord[];
  status: ActionStatus;
  sensitive?: boolean;
  /** 动作版本：影响范围或处置状态变更时自增，旧版本审批不再生效 */
  version: number;
}
export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  affected: string[];
  subIncidents: SubIncident[];
  actions: ResponseAction[];
  timeline: TimelineEvent[];
}

export type OpType = 'approve' | 'execute' | 'addSubIncident' | 'setAffected' | 'transition';
export interface PendingOp {
  opId: string;
  type: OpType;
  at: string;
  payload: Record<string, unknown>;
  /** 动作操作时所依据的版本，回网回放时做乐观并发校验 */
  baseVersion?: number;
  result?: 'merged' | 'conflict';
  reason?: string;
  resolvedAt?: string;
}

interface State {
  incident: Incident;
  role: Role;
  demoMode: boolean;
  online: boolean;
  pendingOps: PendingOp[];
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  setOnline: (online: boolean) => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  addAffected: (asset: string) => void;
  removeAffected: (asset: string) => void;
  transition: (status: IncidentStatus) => void;
  reorderActions: (activeId: string, overId: string) => void;
  flushOps: () => void;
  dismissOp: (opId: string) => void;
  clearResolved: () => void;
  tick: () => void;
}

export const ROLE_LABELS: Record<Role, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关', viewer: '访客' };
export const STATUS_LABELS: Record<IncidentStatus, string> = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' };
export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = { pending: '待确认', approved: '已批准', executed: '已执行' };

export const requiredApprovals = (kind: ActionKind): number => (kind === 'isolate' ? 2 : 1);
export const validApprovals = (action: ResponseAction): ApprovalRecord[] => action.approvals.filter((record) => record.version === action.version);
export const distinctApprovalRoles = (records: ApprovalRecord[]): number => new Set(records.map((record) => record.role)).size;

const uid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
const now = (): string => new Date().toISOString();
const pushTimeline = (incident: Incident, actor: string, text: string, sensitive?: boolean): TimelineEvent[] =>
  [{ id: uid(), at: now(), actor, text, sensitive }, ...incident.timeline];

/**
 * 影响范围 / 处置状态变更：未执行的动作立即失效，版本自增并退回待确认；
 * 已执行的动作与审计记录保持原样。
 */
function invalidateActions(actions: ResponseAction[]): { actions: ResponseAction[]; changed: ResponseAction[] } {
  const changed: ResponseAction[] = [];
  const next = actions.map((action) => {
    if (action.status === 'executed') return action;
    const updated = { ...action, version: action.version + 1, status: 'pending' as ActionStatus };
    changed.push(updated);
    return updated;
  });
  return { actions: next, changed };
}

/** 离线排队：同一操作内容只排一条，避免重复点击产生多条待同步记录 */
function enqueueOp(pending: PendingOp[], op: Omit<PendingOp, 'opId' | 'at'>): PendingOp[] {
  const signature = `${op.type}:${JSON.stringify(op.payload)}`;
  if (pending.some((item) => !item.result && `${item.type}:${JSON.stringify(item.payload)}` === signature)) return pending;
  return [...pending, { ...op, opId: uid(), at: now() }];
}

interface ReplayResult { ok: boolean; reason?: string; }

function applyApprove(set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State, id: string, role: Role, baseVersion: number | undefined, isReplay: boolean): ReplayResult {
  const state = get();
  const action = state.incident.actions.find((item) => item.id === id);
  if (!action) return { ok: false, reason: '动作不存在或已被删除' };
  if (isReplay && baseVersion !== undefined && action.version !== baseVersion) {
    return { ok: false, reason: `动作版本已变更（v${baseVersion} → v${action.version}），审批基于旧事实，需在新版本上重新确认` };
  }
  const valid = validApprovals(action);
  if (valid.some((record) => record.role === role)) return { ok: true, reason: 'duplicate' }; // 同一角色重复确认只算一次
  const record: ApprovalRecord = { id: uid(), role, version: action.version, at: now() };
  const nextValid = [...valid, record];
  const status: ActionStatus = distinctApprovalRoles(nextValid) >= requiredApprovals(action.kind) ? 'approved' : 'pending';
  set({
    incident: {
      ...state.incident,
      actions: state.incident.actions.map((item) => (item.id === id ? { ...item, approvals: [...item.approvals, record], status } : item)),
      timeline: pushTimeline(state.incident, ROLE_LABELS[role], `审批处置动作：${action.title}（v${action.version}）`),
    },
  });
  return { ok: true };
}

function applyExecute(set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State, id: string, role: Role, baseVersion: number | undefined, isReplay: boolean): ReplayResult {
  const state = get();
  const action = state.incident.actions.find((item) => item.id === id);
  if (!action) return { ok: false, reason: '动作不存在或已被删除' };
  if (action.status === 'executed') return { ok: true, reason: 'already' }; // 幂等：已执行动作保持原样
  if (isReplay && baseVersion !== undefined && action.version !== baseVersion) {
    return { ok: false, reason: `动作版本已变更（v${baseVersion} → v${action.version}），执行依据已失效` };
  }
  if (distinctApprovalRoles(validApprovals(action)) < requiredApprovals(action.kind)) {
    return { ok: false, reason: '有效审批不足，未达到执行条件' };
  }
  set({
    incident: {
      ...state.incident,
      actions: state.incident.actions.map((item) => (item.id === id ? { ...item, status: 'executed' as ActionStatus } : item)),
      timeline: pushTimeline(state.incident, ROLE_LABELS[role], `执行处置动作：${action.title}`, action.sensitive),
    },
  });
  return { ok: true };
}

function applyAffected(set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State, op: 'add' | 'remove', asset: string): ReplayResult {
  const state = get();
  const has = state.incident.affected.includes(asset);
  if ((op === 'add' && has) || (op === 'remove' && !has)) return { ok: true, reason: 'duplicate' };
  const affected = op === 'add' ? [...state.incident.affected, asset] : state.incident.affected.filter((item) => item !== asset);
  const { actions, changed } = invalidateActions(state.incident.actions);
  const events: TimelineEvent[] = [
    { id: uid(), at: now(), actor: '响应负责人', text: op === 'add' ? `影响范围扩大：新增受影响资产 ${asset}` : `影响范围收窄：移除受影响资产 ${asset}` },
    ...changed.map((action) => ({ id: uid(), at: now(), actor: '响应负责人', text: `处置动作「${action.title}」因影响范围变更失效（v${action.version - 1} → v${action.version}），退回待确认` })),
  ];
  set({ incident: { ...state.incident, affected, actions, timeline: [...events, ...state.incident.timeline] } });
  return { ok: true };
}

function applyTransition(set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State, status: IncidentStatus): ReplayResult {
  const state = get();
  if (state.incident.status === status) return { ok: true, reason: 'duplicate' };
  const { actions, changed } = invalidateActions(state.incident.actions);
  const events: TimelineEvent[] = [
    { id: uid(), at: now(), actor: '响应负责人', text: `处置阶段变更为「${STATUS_LABELS[status]}」，未执行动作退回待确认` },
    ...changed.map((action) => ({ id: uid(), at: now(), actor: '响应负责人', text: `处置动作「${action.title}」因阶段变更失效（v${action.version - 1} → v${action.version}），退回待确认` })),
  ];
  set({ incident: { ...state.incident, status, actions, timeline: [...events, ...state.incident.timeline] } });
  return { ok: true };
}

function applySubIncident(set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State, payload: { title: string; owner: string; tempId?: string }): ReplayResult {
  const state = get();
  if (payload.tempId && state.incident.subIncidents.some((item) => item.tempId === payload.tempId)) return { ok: true, reason: 'duplicate' };
  const sub: SubIncident = { id: `sub-${uid()}`, tempId: payload.tempId, title: payload.title, owner: payload.owner, status: 'open' };
  set({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, sub], timeline: pushTimeline(state.incident, '响应负责人', `创建子事件：${payload.title}`) } });
  return { ok: true };
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: [{ id: 'ap-1', role: 'analyst', version: 1, at: new Date(Date.now() - 1200000).toISOString() }], status: 'pending', sensitive: true, version: 1 },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending', version: 1 },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: [{ id: 'ap-3', role: 'legal', version: 1, at: new Date(Date.now() - 600000).toISOString() }], status: 'approved', sensitive: true, version: 1 }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false, online: true, pendingOps: [],
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  setOnline: (online) => { set({ online }); if (online) get().flushOps(); },
  addSubIncident: (payload) => {
    if (get().demoMode) return;
    if (!get().online) {
      const op = { type: 'addSubIncident' as OpType, payload: { ...payload, tempId: uid() } };
      set({ pendingOps: enqueueOp(get().pendingOps, op) });
      return;
    }
    applySubIncident(set, get, payload);
  },
  approveAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action) return;
    if (!state.online) {
      set({ pendingOps: enqueueOp(state.pendingOps, { type: 'approve', payload: { id, role: state.role }, baseVersion: action.version }) });
      return;
    }
    applyApprove(set, get, id, state.role, action.version, false);
  },
  executeAction: (id) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const action = state.incident.actions.find((item) => item.id === id);
    if (!action) return;
    if (!state.online) {
      set({ pendingOps: enqueueOp(state.pendingOps, { type: 'execute', payload: { id, role: state.role }, baseVersion: action.version }) });
      return;
    }
    applyExecute(set, get, id, state.role, action.version, false);
  },
  addAffected: (asset) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer' || !asset.trim()) return;
    if (!state.online) {
      set({ pendingOps: enqueueOp(state.pendingOps, { type: 'setAffected', payload: { op: 'add', asset: asset.trim() } }) });
      return;
    }
    applyAffected(set, get, 'add', asset.trim());
  },
  removeAffected: (asset) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    if (!state.online) {
      set({ pendingOps: enqueueOp(state.pendingOps, { type: 'setAffected', payload: { op: 'remove', asset } }) });
      return;
    }
    applyAffected(set, get, 'remove', asset);
  },
  transition: (status) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    if (!state.online) {
      set({ pendingOps: enqueueOp(state.pendingOps, { type: 'transition', payload: { status } }) });
      return;
    }
    applyTransition(set, get, status);
  },
  reorderActions: (activeId, overId) => {
    const state = get();
    const actions = [...state.incident.actions];
    const from = actions.findIndex((item) => item.id === activeId);
    const to = actions.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0 || state.demoMode) return;
    const [moved] = actions.splice(from, 1);
    actions.splice(to, 0, moved);
    set({ incident: { ...state.incident, actions } });
  },
  flushOps: () => {
    const state = get();
    if (state.demoMode) return;
    const pending = state.pendingOps.filter((item) => !item.result);
    if (pending.length === 0) return;
    const resolved: PendingOp[] = [];
    for (const op of pending) {
      let result: ReplayResult = { ok: true };
      if (op.type === 'approve') result = applyApprove(set, get, op.payload.id as string, op.payload.role as Role, op.baseVersion, true);
      else if (op.type === 'execute') result = applyExecute(set, get, op.payload.id as string, op.payload.role as Role, op.baseVersion, true);
      else if (op.type === 'addSubIncident') result = applySubIncident(set, get, op.payload as unknown as { title: string; owner: string; tempId?: string });
      else if (op.type === 'setAffected') result = applyAffected(set, get, op.payload.op as 'add' | 'remove', op.payload.asset as string);
      else if (op.type === 'transition') result = applyTransition(set, get, op.payload.status as IncidentStatus);
      resolved.push({
        ...op,
        result: result.ok ? 'merged' : 'conflict',
        reason: result.ok ? (result.reason === 'duplicate' || result.reason === 'already' ? '重复提交已按标识合并，只保留一条有效记录' : undefined) : result.reason,
        resolvedAt: now(),
      });
    }
    const merged = resolved.filter((item) => item.result === 'merged').length;
    const conflicts = resolved.filter((item) => item.result === 'conflict').length;
    const resolvedIds = new Set(resolved.map((item) => item.opId));
    set({
      pendingOps: state.pendingOps.map((item) => (resolvedIds.has(item.opId) ? resolved.find((r) => r.opId === item.opId) ?? item : item)),
      incident: {
        ...get().incident,
        timeline: pushTimeline(get().incident, '同步代理', `断网期间操作回网同步：${merged} 条已按标识合并${conflicts > 0 ? `，${conflicts} 条冲突待人工处理` : ''}`),
      },
    });
  },
  dismissOp: (opId) => set((state) => ({ pendingOps: state.pendingOps.filter((item) => item.opId !== opId) })),
  clearResolved: () => set((state) => ({ pendingOps: state.pendingOps.filter((item) => !item.result) })),
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: [{ id: uid(), at: now(), actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新` }, ...state.incident.timeline].slice(0, 30) } }))
}), { name: 'yf56-incident-store-v2' }));
