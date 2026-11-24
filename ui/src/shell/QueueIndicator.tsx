import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Icon, Pill, useToast } from '../components';
import { useApp } from './context';
import { useOutside } from './useOutside';

const shotNo = (id: string) => (/^HAND-/i.test(id) ? `手动${id.split('-').pop()}` : id.split('-').pop());
const STATE: Record<string, string> = { queued: '排队中', running: '生成中', cancelling: '正在取消…', fetching: '正在从服务器取回' };

export function formatRemaining(ms: number | null) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `约 ${Math.floor(s / 60)} 分 ${s % 60} 秒` : `约 ${s} 秒`;
}

// "生成中 1 · 排队 3" in the top bar; the list behind it cancels single takes or everything.
export function QueueIndicator() {
  const { queue } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, open, close);
  const toast = useToast();
  if (!queue.busy && !queue.paused) return null;

  const running = queue.jobs.filter((j) => j.status !== 'queued').length;
  const waiting = queue.jobs.length - running;
  const label = queue.paused ? `队列已暂停 · 剩 ${queue.jobs.length}` : `生成中 ${running} · 排队 ${waiting}`;
  const say = (r: { ok: boolean; message?: string }) => { if (r.message) toast(r.message, { tone: r.ok ? 'info' : 'bad' }); };

  return (
    <div className="menu-wrap no-drag" ref={ref}>
      <Pill id="queue-indicator" tone={queue.paused ? 'bad' : 'warn'} onClick={() => setOpen((o) => !o)}>{label}</Pill>
      {open ? (
        <div className="menu queue-menu" id="queue-menu">
          {queue.paused ? <div className="note" style={{ color: 'var(--bad)' }}>{queue.message}</div> : null}
          {queue.jobs.map((j) => (
            <div className="queue-row" key={j.takeId}>
              <span className="what">镜头 {shotNo(j.shotId)}{j.kind === 'upscale' ? ' · 超分' : ''}</span>
              <span className="state num">{STATE[j.status] || j.status}{j.status !== 'queued' ? ` · ${Math.round(j.progress * 100)}% ${formatRemaining(j.remainingMs)}` : ''}</span>
              <Button size="sm" variant="ghost" onClick={async () => say(await api.cancelTake({ takeId: j.takeId }))}>取消</Button>
              {j.status !== 'queued' ? <div className="bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div> : null}
            </div>
          ))}
          <div className="hr" />
          <div style={{ display: 'flex', gap: 8, padding: 4 }}>
            {queue.paused ? <Button size="sm" variant="primary" id="btn-queue-retry" onClick={() => api.retryQueue()}><Icon name="play" />继续</Button> : null}
            <Button size="sm" variant="danger" id="btn-queue-cancel-all" onClick={async () => say(await api.cancelAllTakes())}>全部取消</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
