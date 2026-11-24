import { mediaUrl, type KeptPicture, type PictureTake, type QueueJob } from '../../api';
import { takeState } from '../shots/TakeStrip';

const TIER: Record<string, string> = { cand: '候选', keep: '参考图' };

// The batches side by side, newest first, wrapping onto the next line: a batch of one picture takes one picture's
// room, not a whole row. Each has a short header ("图生图 · 4 张 · 基于「正面」 · 「侧面 45°」") cut to its own width,
// the whole of it on hover.
export function PictureStrip({ takes, set, jobs, selected, onSelect }: {
  takes: PictureTake[]; set: KeptPicture[]; jobs: QueueJob[]; selected: string; onSelect: (id: string) => void;
}) {
  const shown = takes.filter((t) => t.tier !== 'trash');
  const batches: { id: string; takes: PictureTake[] }[] = [];
  for (const t of [...shown].sort((a, b) => b.n - a.n)) {
    const id = t.batch || `n${t.n}`;
    let b = batches.find((x) => x.id === id);
    if (!b) batches.push((b = { id, takes: [] }));
    b.takes.unshift(t);
  }
  const labelOf = (image: string | null) => (set.find((s) => s.image === image) || { label: '另一张图' }).label;
  if (!shown.length) return <div className="strip-empty">还没有图片。在右侧写好画面描述，再点「生成」。</div>;
  return (
    <div className="pic-batches" id="picture-strip">
      {batches.map((b) => {
        const first = b.takes[0];
        const about = `${b.takes.length} 张${first.mode === 'i2i' ? ` · 基于「${labelOf(first.base)}」` : ''}${first.ask ? ` · 「${first.ask}」` : ''}`;
        return (
          <div className="pic-batch" key={b.id}>
            <div className="strip-head" title={`${first.mode === 'i2i' ? '图生图' : '文生图'} · ${about}`}>
              <b>{first.mode === 'i2i' ? '图生图' : '文生图'}</b>
              <span className="ellipsis">{about}</span>
            </div>
            <div className="pic-strip">
              {b.takes.map((t) => {
                const job = jobs.find((j) => j.takeId === t.id);
                const state = takeState(t, job);
                const failed = t.status === 'failed' || t.status === 'interrupted';
                return (
                  <button key={t.id} data-take={t.id} data-tier={t.tier} data-status={t.status} title={t.error || undefined}
                    className={`take pic ${t.id === selected ? 'on' : ''} ${t.tier === 'keep' ? 'pick' : t.tier} ${failed ? 'failed' : ''}`} onClick={() => onSelect(t.id)}>
                    <div className="thumb">
                      {t.status === 'succeeded' && t.image ? <img src={mediaUrl('project', t.image)} alt="" loading="lazy" />
                        : job?.preview ? <img src={`data:${job.preview.mime};base64,${job.preview.data}`} alt="" /> : null}
                      {state ? <div className={`state ${failed ? 'bad' : ''}`}>{state}</div> : null}
                      {job && job.status !== 'queued' ? <div className="bar"><i style={{ width: `${job.progress * 100}%` }} /></div> : null}
                    </div>
                    <div className="lbl num"><span>#{t.n}</span><span className="tier">{failed ? '失败' : TIER[t.tier] || ''}</span></div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
