'use client';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { AlertTriangle, CheckCheck, Eye, Plus, Radio, RefreshCw, ShieldAlert, UserCheck, Users, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ACTION_STATUS_LABELS, ROLE_LABELS, STATUS_LABELS,
  distinctApprovalRoles, requiredApprovals, useIncidentStore, validApprovals,
  type IncidentStatus, type PendingOp, type ResponseAction,
} from '@/lib/store';

const formSchema = z.object({ title: z.string().min(4, '请填写至少4个字的子事件'), owner: z.string().min(2, '请填写负责组') });
const roleNames = ROLE_LABELS;

function SortableAction({ action }: { action: ResponseAction }) {
  const store = useIncidentStore();
  const sortable = useSortable({ id: action.id });
  const canSee = !action.sensitive || ['responder', 'legal'].includes(store.role);
  const valid = validApprovals(action);
  const stale = action.approvals.filter((record) => record.version !== action.version);
  const distinct = distinctApprovalRoles(valid);
  const required = requiredApprovals(action.kind);
  const myApproved = valid.some((record) => record.role === store.role);
  const frozen = store.demoMode || store.role === 'viewer';
  return (
    <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className="action-row">
      <div>
        <div className="action-title-line">
          <strong>{canSee ? action.title : '敏感处置动作（当前角色不可见）'}</strong>
          <span className="version-tag">v{action.version}</span>
          <Badge className={action.status}>{ACTION_STATUS_LABELS[action.status]}</Badge>
        </div>
        <div className="muted">{action.kind} · 需 {required} 名不同角色确认 · 当前版本有效审批 {distinct}/{required}</div>
        {valid.length > 0 && (
          <div className="approval-chips">
            {valid.map((record) => <span key={record.id} className="chip">{ROLE_LABELS[record.role]}</span>)}
          </div>
        )}
        {stale.length > 0 && (
          <div className="approval-chips">
            {stale.map((record) => <span key={record.id} className="chip stale" title={`v${record.version} 时确认，已失效`}>{ROLE_LABELS[record.role]} · v{record.version} 已失效</span>)}
          </div>
        )}
      </div>
      <div className="row-actions">
        <Button size="sm" variant="outline" disabled={frozen || myApproved} onClick={() => store.approveAction(action.id)}><UserCheck size={14} />审批</Button>
        <Button size="sm" disabled={frozen || action.status !== 'approved'} onClick={() => store.executeAction(action.id)}>执行</Button>
        <Button size="sm" variant="ghost" {...sortable.attributes} {...sortable.listeners}>排序</Button>
      </div>
    </div>
  );
}

function describeOp(op: PendingOp, actions: ResponseAction[]): string {
  const action = actions.find((item) => item.id === op.payload.id);
  const title = action?.title ?? String(op.payload.id ?? '');
  switch (op.type) {
    case 'approve': return `审批动作「${title}」`;
    case 'execute': return `执行动作「${title}」`;
    case 'addSubIncident': return `新增子事件「${String(op.payload.title ?? '')}」`;
    case 'setAffected': return `${op.payload.op === 'add' ? '新增' : '移除'}受影响资产 ${String(op.payload.asset ?? '')}`;
    case 'transition': return `处置阶段变更为「${STATUS_LABELS[op.payload.status as IncidentStatus] ?? String(op.payload.status)}」`;
  }
}

function SyncQueueCard() {
  const t = useTranslations();
  const store = useIncidentStore();
  const ops = store.pendingOps;
  if (ops.length === 0) return null;
  const pending = ops.filter((op) => !op.result);
  const resolved = ops.filter((op) => op.result);
  return (
    <Card>
      <CardHeader><div><h2>{t('syncQueue')}</h2><p className="muted">{t('syncQueueHint')}</p></div><RefreshCw size={20} /></CardHeader>
      <CardContent>
        {pending.length > 0 && <div className="muted queue-section-title">{t('pendingSync')} {pending.length} 条</div>}
        {[...pending, ...resolved].map((op) => (
          <div key={op.opId} className="op-row">
            <div>
              <div>{describeOp(op, store.incident.actions)} <span className="muted">· {formatDistanceToNow(new Date(op.at), { addSuffix: true, locale: zhCN })}</span></div>
              {op.result === 'conflict' && <div className="op-reason"><AlertTriangle size={12} />{op.reason}</div>}
              {op.result === 'merged' && <div className="muted">{op.reason ?? t('merged')}</div>}
            </div>
            <div className="op-row-side">
              {op.result ? <Badge className={op.result}>{op.result === 'merged' ? t('merged') : t('conflict')}</Badge> : <Badge>{t('pendingSync')}</Badge>}
              {op.result === 'conflict' && <Button size="sm" variant="ghost" onClick={() => store.dismissOp(op.opId)}>{t('ignore')}</Button>}
            </div>
          </div>
        ))}
        <div className="row-actions queue-actions">
          {pending.length > 0 && <Button size="sm" onClick={store.flushOps} disabled={!store.online}><CheckCheck size={14} />{t('syncNow')}</Button>}
          {resolved.length > 0 && <Button size="sm" variant="outline" onClick={store.clearResolved}>{t('clearResolved')}</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

function IncidentSummary() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const [asset, setAsset] = useState('');
  const frozen = store.demoMode || store.role === 'viewer';
  return (
    <Card>
      <CardHeader><div><h2>事件摘要</h2><p className="muted">{t('scopeHint')}</p></div><ShieldAlert color={incident.severity === 'critical' ? '#ef4444' : '#f59e0b'} /></CardHeader>
      <CardContent>
        <div className="incident-state"><span>处置阶段</span><strong>{STATUS_LABELS[incident.status]}</strong></div>
        <div className="muted">{t('affectedScope')}（{t('scopeHint')}）：</div>
        <div className="affected-chips">
          {incident.affected.map((item) => (
            <span key={item} className="chip">{item}{!frozen && <button type="button" className="chip-remove" onClick={() => store.removeAffected(item)} aria-label={`移除 ${item}`}><X size={12} /></button>}</span>
          ))}
        </div>
        {!frozen && (
          <form className="add-affected" onSubmit={(event) => { event.preventDefault(); const value = asset.trim(); if (value) { store.addAffected(value); setAsset(''); } }}>
            <Input value={asset} onChange={(event) => setAsset(event.target.value)} placeholder="新增受影响资产，如 auth-service" />
            <Button type="submit" size="sm"><Plus size={14} />{t('addAffected')}</Button>
          </form>
        )}
        {!frozen && (
          <div className="transition-group">
            {(['investigating', 'contained', 'recovered'] as IncidentStatus[]).map((status) => (
              <button key={status} type="button" className={`status-pill${incident.status === status ? ' active' : ''}`} onClick={() => store.transition(status)}>{STATUS_LABELS[status]}</button>
            ))}
          </div>
        )}
        <h3>子事件</h3>
        {incident.subIncidents.map((item) => <div className="sub-row" key={item.id}><div><strong>{item.title}</strong><div className="muted">{item.owner}</div></div><Badge>{item.status}</Badge></div>)}
      </CardContent>
    </Card>
  );
}

export default function Page() {
  const t = useTranslations();
  const store = useIncidentStore();
  const incident = store.incident;
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema), defaultValues: { title: '', owner: '' } });
  const { data: health = { connected: false, latency: 0 } } = useQuery({ queryKey: ['live'], queryFn: async () => ({ connected: true, latency: 42 }), refetchInterval: 10000 });
  useEffect(() => {
    const timer = window.setInterval(() => { if (!store.demoMode) store.tick(); }, 20000);
    const goOnline = () => store.setOnline(true);
    const goOffline = () => store.setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    store.setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  function dragEnd(event: DragEndEvent) { if (event.over) store.reorderActions(String(event.active.id), String(event.over.id)); }
  const canSeeSensitive = ['responder', 'legal'].includes(store.role);

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow"><Radio size={14} /> LIVE WAR ROOM · PORT 62021</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><div className="controls">
      <select value={store.role} onChange={(event) => store.setRole(event.target.value as typeof store.role)}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <Button variant={store.online ? 'outline' : 'danger'} onClick={() => store.setOnline(!store.online)}>{store.online ? <Wifi size={16} /> : <WifiOff size={16} />}{store.online ? t('online') : t('offline')}</Button>
      <Button variant={store.demoMode ? 'danger' : 'outline'} onClick={store.toggleDemo}><Eye size={16} />{store.demoMode ? '退出演示' : t('demo')}</Button>
    </div></header>
    {store.demoMode && <div className="demo-banner">只读演示模式已开启：审批、执行、拖拽和新增操作均被冻结，仍可查看允许范围内的内容。</div>}
    {!store.online && <div className="offline-banner"><WifiOff size={15} />{t('offlineBanner')}</div>}
    <section className="metrics"><Card><CardContent><span>当前事件</span><strong>{incident.id}</strong><Badge className="critical">{incident.severity}</Badge></CardContent></Card><Card><CardContent><span>实时通道</span><strong>{health.connected ? `${health.latency}ms` : '离线'}</strong><small>{health.connected ? '监测代理已连接' : '等待连接'}</small></CardContent></Card><Card><CardContent><span>子事件</span><strong>{incident.subIncidents.filter((item) => item.status !== 'closed').length}</strong><small>处理中</small></CardContent></Card><Card><CardContent><span>处置动作</span><strong>{incident.actions.filter((item) => item.status === 'executed').length}/{incident.actions.length}</strong><small>已执行/总数</small></CardContent></Card></section>
    <section className="grid">
      <div className="stack">
        <IncidentSummary />
        <Card><CardHeader><div><h2>{t('approval')}</h2><p className="muted">{t('approvalsHint')}</p></div><Users size={20} /></CardHeader><CardContent><DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={incident.actions.map((item) => item.id)} strategy={verticalListSortingStrategy}><div>{incident.actions.map((action) => <SortableAction key={action.id} action={action} />)}</div></SortableContext></DndContext></CardContent></Card>
      </div>
      <div className="stack">
        <Card><CardHeader><h2>新增子事件</h2></CardHeader><CardContent><form onSubmit={form.handleSubmit((values) => { store.addSubIncident(values); form.reset(); })}><label>子事件名称<Input {...form.register('title')} placeholder="例如：凭据轮换" /></label><small className="error">{form.formState.errors.title?.message}</small><label>负责组<Input {...form.register('owner')} placeholder="例如：平台组" /></label><small className="error">{form.formState.errors.owner?.message}</small><Button type="submit" disabled={store.demoMode}><ShieldAlert size={16} />创建子事件</Button></form></CardContent></Card>
        <SyncQueueCard />
        <Card className="timeline-card"><CardHeader><div><h2>{t('timeline')}</h2><p className="muted">每 20 秒接收一次模拟监测事件</p></div><Radio color="#ef4444" /></CardHeader><CardContent><div className="timeline">{incident.timeline.map((event) => <article key={event.id}><i /><div><div className="timeline-meta"><strong>{event.actor}</strong><span>{formatDistanceToNow(new Date(event.at), { addSuffix: true, locale: zhCN })}</span></div><p>{event.sensitive && !canSeeSensitive ? '敏感处置记录已隐藏' : event.text}</p></div></article>)}</div></CardContent></Card>
      </div>
    </section>
  </main>;
}
