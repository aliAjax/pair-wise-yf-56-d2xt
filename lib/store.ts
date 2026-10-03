import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  GENESIS_OPS,
  reconcile,
  sortOpsSafe,
  toActionViews,
  type ActionView,
  type CollabOp,
  type IncidentStatus,
  type Role,
  type TimelineEvent,
  type UnmergedOp
} from './collab';

const STORAGE_KEY = 'yf56-incident-store-v2';

// 本浏览器实例标识：离线补发的操作带回该标识，用于区分本地/对端来源
const CLIENT_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `client-${Math.random().toString(36).slice(2)}`;

let opSeq = 0;
const newOpId = () => `${Date.now().toString(36)}-${CLIENT_ID.slice(0, 8)}-${(opSeq++).toString(36)}`;

interface PersistedShape {
  ops: CollabOp[]; // 已上链（已合并）的协同操作历史，按 opId 幂等
  outbox: CollabOp[]; // 断网期间本机待发操作（回网后按到达顺序对账）
  rejectedOps: UnmergedOp[]; // 各端合不上的操作，单独列出直到人工知悉
  localTimeline: TimelineEvent[]; // 本机监测事件（不进协同日志）
  demoMode: boolean;
}

interface State extends PersistedShape {
  role: Role;
  online: boolean;
  clientId: string;
  actions: ActionView[];
  timeline: TimelineEvent[];
  unmerged: UnmergedOp[];
  rev: number;
  affected: string[];
  status: IncidentStatus;
  subIncidents: ReturnType<typeof reconcile>['subIncidents'];
  pendingOpIds: Set<string>; // 仅本机乐观显示、尚未真正上链的操作
  setRole: (role: Role) => void;
  toggleDemo: () => void;
  toggleOnline: () => void;
  approveAction: (actionId: string) => void;
  executeAction: (actionId: string) => void;
  updateFacts: (payload: { affected: string[]; status: IncidentStatus }) => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  reorderActions: (activeId: string, overId: string) => void;
  dismissUnmerged: (opId: string) => void;
  tick: () => void;
  _refresh: () => void;
}

interface Derived {
  actions: ActionView[];
  timeline: TimelineEvent[];
  unmerged: UnmergedOp[];
  rev: number;
  affected: string[];
  status: IncidentStatus;
  subIncidents: ReturnType<typeof reconcile>['subIncidents'];
}

// 在线：视图只来自已提交历史 + 持久化的未合并清单；
// 离线：把本机发件箱作为"迟到批次"乐观对账，冲突要等回网才定论，故暂不展示未合并项
function derive(
  ops: CollabOp[],
  outbox: CollabOp[],
  rejectedOps: UnmergedOp[],
  localTimeline: TimelineEvent[],
  online: boolean
): Derived & { pendingOpIds: Set<string> } {
  const view = online ? reconcile(ops) : reconcile(ops, outbox);
  return {
    actions: toActionViews(view),
    rev: view.rev,
    affected: view.affected,
    status: view.status,
    subIncidents: view.subIncidents,
    unmerged: online ? rejectedOps : [],
    pendingOpIds: new Set(online ? [] : outbox.map((op) => op.opId)),
    timeline: [...localTimeline, ...view.timeline]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
      .slice(0, 40)
  };
}

function readPersisted(): Partial<PersistedShape> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Partial<PersistedShape> };
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

// 并入通道上其他标签页的已提交历史与未合并清单（均按 opId 幂等并集）
function unionPersisted(state: State, incoming: Partial<PersistedShape> | null) {
  const known = new Map(state.ops.map((op) => [op.opId, op]));
  for (const op of incoming?.ops ?? []) if (!known.has(op.opId)) known.set(op.opId, op);
  const ops = sortOpsSafe([...known.values()]);
  const rejected = new Map(state.rejectedOps.map((item) => [item.op.opId, item]));
  for (const item of incoming?.rejectedOps ?? []) if (!rejected.has(item.op.opId)) rejected.set(item.op.opId, item);
  const rejectedOps = [...rejected.values()];
  // 发件箱只领回本 clientId 的条目：断网队列属于本机，不跨端搬运
  const outboxIds = new Set(state.outbox.map((op) => op.opId));
  const outbox = [...state.outbox];
  for (const op of incoming?.outbox ?? []) {
    if (op.clientId === CLIENT_ID && !outboxIds.has(op.opId)) outbox.push(op);
  }
  return { ops, rejectedOps, outbox };
}

const initialDerived = derive(GENESIS_OPS, [], [], [], true);

export const useIncidentStore = create<State>()(
  persist(
    (set, get) => ({
      ...initialDerived,
      ops: GENESIS_OPS,
      outbox: [],
      rejectedOps: [],
      localTimeline: [],
      demoMode: false,
      role: 'analyst',
      online: true,
      clientId: CLIENT_ID,

      setRole: (role) => set({ role }),
      toggleDemo: () => set((s) => ({ demoMode: !s.demoMode })),

      toggleOnline: () => {
        if (get().online) {
          // 当前在线 → 断网：仅切换标记，视图转为对发件箱的乐观对账
          set({ online: false, ...derive(get().ops, get().outbox, get().rejectedOps, get().localTimeline, false) });
          return;
        }
        // 当前离线 → 回网：先收齐其他端在断网期间推进的历史，再把本机发件箱按到达顺序逐条对账
        const state = get();
        const { ops: mergedOps } = unionPersisted(state, readPersisted());
        const result = reconcile(mergedOps, state.outbox);
        const accepted = new Set(result.acceptedLateIds);
        const ops = sortOpsSafe([...mergedOps, ...state.outbox.filter((op) => accepted.has(op.opId))]);
        const rejectedMap = new Map(state.rejectedOps.map((item) => [item.op.opId, item]));
        for (const item of result.unmerged) if (!rejectedMap.has(item.op.opId)) rejectedMap.set(item.op.opId, item);
        const rejectedOps = [...rejectedMap.values()];
        set({
          online: true,
          outbox: [],
          ops,
          rejectedOps,
          ...derive(ops, [], rejectedOps, state.localTimeline, true)
        });
      },

      approveAction: (actionId) => {
        const state = get();
        const action = state.actions.find((item) => item.id === actionId);
        if (!action || action.status === 'executed') return;
        submit(state, (base) => ({ ...base, type: 'approve', actionId, rev: action.rev }));
      },

      executeAction: (actionId) => {
        const state = get();
        const action = state.actions.find((item) => item.id === actionId);
        if (!action || action.status === 'executed') return;
        // 派生视图在离线时已对发件箱审批乐观计入，故这里按当前视图的有效审批数判断即可
        if (new Set(action.validApprovals.map((r) => r.by)).size < action.required) return;
        submit(state, (base) => ({ ...base, type: 'execute', actionId, rev: action.rev }));
      },

      updateFacts: ({ affected, status }) => {
        const state = get();
        const same =
          affected.length === state.affected.length && affected.every((v, i) => v === state.affected[i]);
        if (same && status === state.status) return;
        submit(state, (base) => ({ ...base, type: 'facts', affected, status, rev: state.rev + 1 }));
      },

      addSubIncident: (payload) => {
        const state = get();
        const subId = `sub-${Date.now()}`;
        submit(state, (base) => ({ ...base, type: 'sub', subId, ...payload }));
      },

      reorderActions: (activeId, overId) => {
        const state = get();
        if (state.demoMode || activeId === overId) return;
        const ids = state.actions.map((a) => a.id);
        const from = ids.indexOf(activeId);
        const to = ids.indexOf(overId);
        if (from < 0 || to < 0) return;
        const order = [...ids];
        order.splice(from, 1);
        order.splice(to, 0, activeId);
        submit(state, (base) => ({ ...base, type: 'reorder', order }));
      },

      dismissUnmerged: (opId) =>
        set((s) => {
          const rejectedOps = s.rejectedOps.filter((item) => item.op.opId !== opId);
          return { rejectedOps, ...derive(s.ops, s.outbox, rejectedOps, s.localTimeline, s.online) };
        }),

      tick: () =>
        set((s) => {
          if (s.demoMode) return {};
          const event: TimelineEvent = {
            id: `local-${Date.now()}`,
            at: new Date().toISOString(),
            actor: '监测代理',
            source: 'local',
            text: `实时检查：${s.affected.length} 项资产状态已更新（v${s.rev}）`
          };
          const localTimeline = [event, ...s.localTimeline].slice(0, 10);
          return { localTimeline, ...derive(s.ops, s.outbox, s.rejectedOps, localTimeline, s.online) };
        }),

      _refresh: () => {
        const s = get();
        const persisted = readPersisted();
        if (!persisted) return;
        const localIds = new Set(s.ops.map((op) => op.opId));
        const hasRemoteOps = (persisted.ops ?? []).some((op) => !localIds.has(op.opId));
        const rejectedIds = new Set(s.rejectedOps.map((item) => item.op.opId));
        const hasRemoteRejected = (persisted.rejectedOps ?? []).some((item) => !rejectedIds.has(item.op.opId));
        const hasOwnOutbox = (persisted.outbox ?? []).some(
          (op) => op.clientId === CLIENT_ID && !s.outbox.some((item) => item.opId === op.opId)
        );
        if (!hasRemoteOps && !hasRemoteRejected && !hasOwnOutbox) return;
        const merged = unionPersisted(s, persisted);
        set({ ...merged, ...derive(merged.ops, merged.outbox, merged.rejectedOps, s.localTimeline, s.online) });
      }
    }),
    {
      name: STORAGE_KEY,
      partialize: (s) => ({
        ops: s.ops,
        outbox: s.outbox,
        rejectedOps: s.rejectedOps,
        localTimeline: s.localTimeline,
        demoMode: s.demoMode
      }),
      // 水合时以持久化的操作日志为准重新回放，避免旧派生快照盖掉协同结果
      merge: (persisted, current) => {
        const slice = (persisted ?? {}) as Partial<PersistedShape>;
        const ops = sortOpsSafe(slice.ops ?? current.ops);
        const rejectedOps = slice.rejectedOps ?? current.rejectedOps;
        const outbox = (slice.outbox ?? current.outbox).filter((op) => op.clientId === CLIENT_ID);
        const merged: State = {
          ...current,
          ops,
          rejectedOps,
          outbox,
          // 本机实时检查不随持久化恢复；角色/在线状态是每标签页本地态，不跨端
          localTimeline: current.localTimeline,
          demoMode: slice.demoMode ?? current.demoMode,
          role: current.role,
          online: current.online
        };
        return { ...merged, ...derive(ops, outbox, rejectedOps, merged.localTimeline, merged.online) };
      }
    }
  )
);

// 统一提交入口：在线把新操作作为迟到批次即时对账（合不上立刻单列）；断网进发件箱乐观显示
function submit(
  state: State,
  make: (base: { opId: string; at: string; by: Role; clientId: string }) => CollabOp
) {
  if (state.demoMode || state.role === 'viewer') return;
  const op = make({ opId: newOpId(), at: new Date().toISOString(), by: state.role, clientId: CLIENT_ID });

  if (!state.online) {
    const outbox = [...state.outbox, op];
    useIncidentStore.setState({ outbox, ...derive(state.ops, outbox, state.rejectedOps, state.localTimeline, false) });
    return;
  }

  // 提交前先并入其他标签页刚写入的历史，规避同键末位写入互相覆盖
  const { ops: mergedOps, rejectedOps } = unionPersisted(state, readPersisted());
  const result = reconcile(mergedOps, [op]);
  const accepted = result.acceptedLateIds.includes(op.opId);
  if (accepted) {
    const ops = sortOpsSafe([...mergedOps, op]);
    useIncidentStore.setState({ ops, ...derive(ops, [], rejectedOps, state.localTimeline, true) });
  } else {
    // 合不上（旧版本/门槛不足/对象不存在等）：历史不污染，单独列出
    const failed = result.unmerged.find((item) => item.op.opId === op.opId);
    const nextRejected = failed && !rejectedOps.some((item) => item.op.opId === op.opId)
      ? [...rejectedOps, failed]
      : rejectedOps;
    useIncidentStore.setState({
      rejectedOps: nextRejected,
      ...derive(mergedOps, [], nextRejected, state.localTimeline, true)
    });
  }
}

// 跨标签页协同：其他值班员的浏览器写入同一通道后，本页按操作日志重新回放
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) useIncidentStore.getState()._refresh();
  });
}
