import { mediaUrl, type QueueJob, type Take } from '../../api';
import { Icon } from '../../components';

const TIER: Record<string, string> = { cand: '候选', pick: '选中' };
const STALE: Record<string, string> = { 'prev-changed': '上一镜换了，可能接不上', 'upstream-changed': '上游换了，可能接不上' };

export function takeState(take: Pick<Take, 'status'>, job?: QueueJob) {
  if (job && job.status === 'fetching') return '正在从服务器取回…';
  if (job && job.status !== 'queued') return `生成中 ${Math.round(job.progress * 100)}%`;
  if (take.status === 'queued') return '排队中';
  if (take.status === 'running') return '生成中…';
  if (take.status === 'failed') return '失败';
  if (take.status === 'cancelled') return '已取消';
  if (take.status === 'interrupted') return '中断';
  return '';
}

// What the take's upscale is doing, short enough for the corner of a thumbnail ('' when there is none).
export function upscaleBadge(take: Pick<Take, 'upscale'>, job?: QueueJob) {
  const up = take.upscale;
  if (job && job.status === 'fetching') return '超分 取回中';
  if (job && job.status !== 'queued') return `超分 ${Math.round(job.progress * 100)}%`;
  if (!up) return '';
  if (up.status === 'queued') return '超分排队';
  if (up.status === 'running') return '超分中';
  if (up.status === 'succeeded' && up.video) return up.quality;
  if (up.status === 'failed' || up.status === 'interrupted') return '超分失败';
  return '';
}

export function TakeStrip({ takes, jobs, selected, onSelect, onRetry }: {
  takes: Take[]; jobs: QueueJob[]; selected: string; onSelect: (id: string) => void; onRetry: () => void;
}) {
  const shown = takes.filter((t) => t.tier !== 'trash').sort((a, b) => a.n - b.n);
  const picked = shown.filter((t) => t.tier === 'pick').length;
  const cands = shown.filter((t) => t.tier === 'cand').length;
  return (
    <div className="strip-wrap">
      <div className="strip-head"><b>这一镜的版本</b><span className="num">共 {shown.length} 版 · 选中 {picked} · 候选 {cands}</span></div>
      {shown.length ? (
        <div className="strip" id="take-strip">
          {shown.map((t) => {
            const job = jobs.find((j) => j.takeId === t.id && j.kind !== 'upscale');
            const up = upscaleBadge(t, jobs.find((j) => j.takeId === t.id && j.kind === 'upscale'));
            const state = takeState(t, job);
            const failed = t.status === 'failed' || t.status === 'interrupted';
            return (
              <button key={t.id} data-take={t.id} data-tier={t.tier} data-status={t.status}
                className={`take ${t.id === selected ? 'on' : ''} ${t.tier} ${failed ? 'failed' : ''}`} onClick={() => onSelect(t.id)}
                title={t.error || undefined}>
                <div className="thumb">
                  {t.status === 'succeeded' && t.video
                    ? <video src={`${mediaUrl('project', t.video)}#t=0.1`} preload="metadata" muted />
                    : job?.preview ? <img src={`data:${job.preview.mime};base64,${job.preview.data}`} alt="" /> : null}
                  {state ? <div className={`state ${failed ? 'bad' : ''}`}>{state}</div> : null}
                  {job && job.status !== 'queued' ? <div className="bar"><i style={{ width: `${job.progress * 100}%` }} /></div> : null}
                </div>
                {up ? <span className={`up-badge ${t.upscale?.status === 'succeeded' ? 'done' : ''} ${/失败/.test(up) ? 'bad' : ''}`}
                  title={t.upscale?.error || undefined}>{up}</span> : null}
                {t.stale ? <span className="stale" title={STALE[t.stale]}><Icon name="warn" size={14} /></span> : null}
                <div className="lbl num">
                  <span>#{t.n}</span>
                  <span className="tier">{failed ? '失败' : TIER[t.tier] || ''}</span>
                </div>
                {failed ? <span className="retry" role="button" tabIndex={0} title="用同样的设置再生成一版"
                  onClick={(e) => { e.stopPropagation(); onRetry(); }} style={{ position: 'absolute', bottom: 24, right: 6, color: 'var(--text)' }}><Icon name="refresh" size={14} /></span> : null}
              </button>
            );
          })}
        </div>
      ) : <div className="strip-empty">还没有版本。点画面上方的「生成」开始。</div>}
    </div>
  );
}
