'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { CloudOff, Eye, History, Radio, ShieldAlert, UserCheck, Users, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ROLE_NAMES, type IncidentStatus, type Role, type UnmergedOp } from '@/lib/collab';
import { useIncidentStore } from '@/lib/store';

const subSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const factsSchema = z.object({
  affected: z.string().min(3, '请填写影响范围，多项用顿号或逗号分隔'),
  status: z.enum(['investigating', 'contained', 'recovered'])
});

const statusNames: Record<IncidentStatus, string> = { investigating: '调查中', contained: '已遏制', recovered: '已恢复' };
const actionStatusMeta: Record<string, { label: string; cls: string }> = {
  pending: { label: '待确认', cls: 'pending' },
  approved: { label: '已批准待执行', cls: 'approved' },
  executed: { label: '已执行', cls: 'executed' }
};
const unmergedReasons: Record<UnmergedOp['reason'], string> = {
  'viewer-forbidden': '访客角色无权执行该操作',
  'action-not-found': '引用的处置动作不存在（可能已被删除或来自其他事件）',
  'rev-mismatch': '动作/事实版本对不上：基于旧事实的提交，当前版本已推进',
  'already-executed': '动作已执行完毕，重复执行未生效',
  'approval-threshold-non-positive': '有效审批数不足，不能执行',
  'unknown-type': '未知操作类型'
};
function unmergedSummary(op: UnmergedOp['op']): string {
  switch (op.type) {
    case 'approve': return `审批动作 ${op.actionId}（v${op.rev}）`;
    case 'execute': return `执行动作 ${op.actionId}（v${op.rev}）`;
    case 'facts': return `更新事实至 v${op.rev}`;
    case 'sub': return `创建子事件 ${op.title}`;
    case 'reorder': return `调整动作优先级`;
    default: return '未知操作';
  }
}

function SortableAction({ action }: { action: ReturnType<typeof useIncidentStore.getState>['actions'][number] }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id, disabled: store.demoMode });
  const canSee = !action.sensitive || store.role === 'responder' || store.role === 'legal';
  const alreadyApproved = action.validApprovals.some((r) => r.by === store.role);
  const meta = actionStatusMeta[action.status];
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div className="action-main">
        <div className="action-title">
          <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
          <Badge className={`action-status ${meta.cls}`}>{meta.label}</Badge>
          <Badge className="rev-badge">v{action.rev}</Badge>
        </div>
        <div className="muted">
          {action.kind} · 需 {action.required} 名不同角色确认 · 当前有效审批：
          {action.validApprovals.length === 0 ? '无' : action.validApprovals.map((r) => (
            <span key={r.opId} className="approval-name">
              {ROLE_NAMES[r.by]}
              {store.pendingOpIds.has(r.opId) && <em className="pending-sync" title="断网期间本机待同步，回网对账后才正式生效">待同步</em>}
            </span>
          )).map((el, i) => <span key={i}>{i > 0 && '、'}{el}</span>)}
          {action.executedAt && ` · 执行于 ${formatDistanceToNow(new Date(action.executedAt), { addSuffix: true, locale: zhCN })}`}
        </div>
        {action.staleApprovals.length > 0 && (
          <div className="stale-approvals">
            <History size={13} />
            已作废的旧版本审批（审计保留，不计入当前确认）：
            {action.staleApprovals.map((r) => (
              <span key={r.opId} className="stale-tag">{ROLE_NAMES[r.by]}·v{r.rev}</span>
            ))}
          </div>
        )}
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline"
          disabled={store.demoMode || store.role === 'viewer' || action.status === 'executed' || alreadyApproved}
          onClick={() => store.approveAction(action.id)}>
          <UserCheck size={14} />{alreadyApproved ? '已确认' : '审批'}
        </Button>
        <Button size="sm"
          disabled={store.demoMode || store.role === 'viewer' || action.status !== 'approved'}
          onClick={() => store.executeAction(action.id)}>
          执行
        </Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store;
  const sensors = useSensors(useSensor(PointerSensor));
  const subForm = useForm<z.infer<typeof subSchema>>({ resolver: zodResolver(subSchema), defaultValues: { title: '', owner: '' } });
  const factsForm = useForm<z.infer<typeof factsSchema>>({
    resolver: zodResolver(factsSchema),
    defaultValues: { affected: store.affected.join('、'), status: store.status }
  });
  const { data: health = { latency: 42 } } = useQuery({
    queryKey: ['live'],
    queryFn: async () => ({ latency: 42 }),
    refetchInterval: store.online ? 10000 : false,
    enabled: store.online
  });
  useEffect(() => {
    const timer = window.setInterval(() => { if (!store.demoMode && store.online) store.tick(); }, 20000);
    return () => window.clearInterval(timer);
  }, [store.demoMode, store.online]);
  // 事实被任一端更新后，同步编辑框到最新事实（自己刚提交或对端推进都如此）
  const revRef = useRef(store.rev);
  useEffect(() => {
    if (revRef.current !== store.rev) {
      revRef.current = store.rev;
      factsForm.reset({ affected: store.affected.join('、'), status: store.status });
    }
  }, [store.rev, store.affected, store.status, factsForm]);
  // 挂载标记：clientId 为每浏览器实例随机生成，仅在客户端水合后渲染以免 SSR 文本不一致
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = store.role === 'responder' || store.role === 'legal';
  const frozen = store.demoMode || store.role === 'viewer';

  return <main className="shell">
    <header className="topbar">
      <div>
        <span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span>
        <h1>{t('title')}</h1><p>{t('subtitle')}</p>
      </div>
      <div className="controls">
        <select value={store.role} onChange={(event) => store.setRole(event.target.value as Role)}>
          {Object.entries(ROLE_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <Button variant={store.online ? 'outline' : 'danger'} onClick={store.toggleOnline}>
          {store.online ? <Wifi size={16} /> : <WifiOff size={16} />}
          {store.online ? '在线协同' : `断网中 · 待发 ${store.outbox.length}`}
        </Button>
        <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
      </div>
    </header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、事实更新、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && <div className="offline-banner"><CloudOff size={16} />当前处于断网模拟：提交的操作进入本机待发队列（{store.outbox.length} 条），回网后按操作标识自动合并，对不上当前版本的操作会单独列出。</div>}

    <section className="metrics">
      <Card><CardContent><span>主事件版本</span><strong>v{incident.rev}</strong><small>{statusNames[incident.status]} · 影响 {incident.affected.length} 项资产</small></CardContent></Card>
      <Card><CardContent><span>实时通道</span><strong>{store.online ? `${health.latency}ms` : '离线'}</strong><small>{store.online ? '多端操作日志已同步' : '操作暂存本机发件箱'}</small></CardContent></Card>
      <Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card>
      <Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数 · 待处理 {incident.actions.filter((i) => i.status !== 'executed').length}</small></CardContent></Card>
    </section>

    <section className="grid">
      <div className="stack">
        <Card>
          <CardHeader>
            <div><h2>事件摘要与事实更新</h2><p className="muted">影响范围 {incident.affected.join(' · ')}。事实一经更新（v{incident.rev}），未执行动作立即退回待确认，已执行动作与审计记录保持原样。</p></div>
            <ShieldAlert color={incident.status === 'recovered' ? '#16a34a' : '#f59e0b'} />
          </CardHeader>
          <CardContent>
            <div className="incident-state"><span>处置阶段</span><strong>{statusNames[incident.status]}</strong></div>
            <h3>子事件</h3>
            {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
            <form className="facts-form" onSubmit={factsForm.handleSubmit((values) => {
              const affected = values.affected.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
              store.updateFacts({ affected, status: values.status });
              factsForm.reset({ affected: affected.join('、'), status: values.status });
            })}>
              <label>更新影响范围（顿号/逗号分隔）<Input {...factsForm.register('affected')} placeholder="例如：api-gateway、billing-svc" /></label>
              <small className="error">{factsForm.formState.errors.affected?.message}</small>
              <label>处置阶段
                <select className="facts-select" {...factsForm.register('status')}>
                  <option value="investigating">调查中</option>
                  <option value="contained">已遏制</option>
                  <option value="recovered">已恢复</option>
                </select>
              </label>
              <Button type="submit" disabled={frozen}><ShieldAlert size={16} />发布事实更新（推进版本，旧审批退回）</Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div><h2>{t('approval')}</h2><p className="muted">隔离动作需两名不同角色确认；同一角色重复确认只算一次；事实更新后旧版本审批作废，需按新版本重新确认。</p></div>
            <Users size={20} />
          </CardHeader>
          <CardContent>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
              <SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div>
              </SortableContext>
            </DndContext>
          </CardContent>
        </Card>
      </div>
      <div className="stack">
        <Card>
          <CardHeader><h2>新增子事件</h2></CardHeader>
          <CardContent><form onSubmit={subForm.handleSubmit((values) => { store.addSubIncident(values); subForm.reset(); })}>
            <label>子事件名称<Input {...subForm.register('title')} placeholder="例如：凭据轮换" /></label>
            <small className="error">{subForm.formState.errors.title?.message}</small>
            <label>负责组<Input {...subForm.register('owner')} placeholder="例如：平台组" /></label>
            <small className="error">{subForm.formState.errors.owner?.message}</small>
            <Button type="submit" disabled={frozen}><ShieldAlert size={16} />创建子事件</Button>
          </form></CardContent>
        </Card>
        <Card>
          <CardHeader><div><h2>协同与离线合并</h2><p className="muted">全部审批/执行/事实变更均为带标识的操作，按标识幂等合入；同一动作同版本的重复审批只留一条。</p></div><CloudOff size={20} /></CardHeader>
          <CardContent>
            <div className="muted">本机实例：<code>{mounted ? `${store.clientId.slice(0, 13)}…` : '—'}</code></div>
            {store.outbox.length > 0 && <div className="outbox-note"><CloudOff size={14} />待发队列 {store.outbox.length} 条：{store.outbox.map((op) => <span key={op.opId} className="outbox-tag">{unmergedSummary(op)}</span>)}</div>}
            {store.unmerged.length === 0 && store.outbox.length === 0 && <p className="muted">没有合不上的操作，各端视图一致。</p>}
            {store.unmerged.length > 0 && (
              <div className="unmerged-list">
                <h4>未能合并的操作（{store.unmerged.length}）</h4>
                {store.unmerged.map((item) => (
                  <div key={item.op.opId} className="unmerged-row">
                    <div>
                      <strong>{unmergedSummary(item.op)}</strong>
                      <div className="muted">{unmergedReasons[item.reason]} · {ROLE_NAMES[item.op.by]} · {formatDistanceToNow(new Date(item.op.at), { addSuffix: true, locale: zhCN })}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => store.dismissUnmerged(item.op.opId)}>知悉</Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="timeline-card">
          <CardHeader><div><h2>{t('timeline')}</h2><p className="muted">协同操作（各端一致）与本机实时检查混合展示</p></div><Radio color="#ef4444" /></CardHeader>
          <CardContent>
            <div className="timeline">{incident.timeline.map((event) => (
              <article key={event.id}>
                <i className={event.source === 'local' ? 'local-dot' : ''} />
                <div>
                  <div className="timeline-meta">
                    <strong>{event.actor} <span className={`source-badge ${event.source}`}>{event.source === 'local' ? '本机' : '协同'}</span></strong>
                    <span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span>
                  </div>
                  <p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p>
                </div>
              </article>
            ))}</div>
          </CardContent>
        </Card>
      </div>
    </section>
  </main>;
}
