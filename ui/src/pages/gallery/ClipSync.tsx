import { useEffect, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, Modal, useToast } from '../../components';
import { LauncherFormat as fmt } from '../../legacy';

const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

function Section({ title, tone, items, text }: { title: string; tone: string; items: Loose[]; text: (c: Loose) => string }) {
  return (
    <div className={`clip-box ${tone}`}>
      <div className="clip-head">{title}（{items.length}）</div>
      {items.length ? items.map((c) => (
        <div className="clip-row" key={c.stem} title={`${c.stem}\n${text(c)}`}>
          <span className="t num">{when(c.mtimeMs)}</span><span className="n">{c.stem}</span><span className="m">{text(c)}</span>
        </div>
      )) : <div className="clip-row"><span className="m">没有</span></div>}
    </div>
  );
}

// The old clean-up for the h3_context folder: clips without a video go to the recycle bin. Clips that a take on
// the shot page owns are held back by the main process.
export function ClipSync({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [includeSlots, setIncludeSlots] = useState(false);
  const [plan, setPlan] = useState<Loose | null>(null);
  useEffect(() => {
    api.planClipSync({ includeSlots }).then((r) => {
      if (!r.ok) { toast(r.message || '读取接续片段文件夹失败', { tone: 'bad' }); onClose(); return; }
      if (r.missing) { toast('输出目录里还没有接续片段文件夹', { tone: 'bad' }); onClose(); return; }
      setPlan(r);
    });
  }, [includeSlots]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!plan) return null;
  return (
    <Modal wide id="clip-sync" title="清理接续片段" onClose={onClose} actions={<>
      <Button onClick={onClose}>取消</Button>
      <Button variant="danger" id="btn-clips-trash" disabled={!plan.remove.length} onClick={async () => {
        const r = await api.trashClips({ stems: plan.remove.map((c: Loose) => c.stem), includeSlots });
        toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
        onClose();
      }}>{plan.remove.length ? `移到回收站（${plan.remove.length} 个）` : '没有可清除的'}</Button>
    </>}>
      <p>输出里有 {plan.videoCount} 个可用于接续的视频。保留 {plan.keep.length} 个接续片段（还有视频对应），可清除 {plan.remove.length} 个（{fmt.formatBytes(plan.removeBytes)}）{plan.held.length ? `，另有 ${plan.held.length} 个暂不动` : ''}。</p>
      {plan.generating ? <p style={{ color: 'var(--bad)' }}>ComfyUI 正在生成，最新一个接续片段可能是这次的，已先留着不动。</p> : null}
      <p style={{ color: 'var(--dim)', fontSize: 13 }}>配对方式：每个视频对应它之前最近保存的那个接续片段（按生成时间）。放大出来的视频不算。清掉的接续片段会放进回收站，可以恢复。</p>
      <div className="clip-list">
        <Section title="将清除" tone="bad" items={plan.remove} text={(c) => `${fmt.formatBytes(c.bytes)} · 没有对应的视频`} />
        <Section title="保留" tone="ok" items={plan.keep} text={(c) => `对应 ${(c.videos || []).map(baseName).join('、')}`} />
        {plan.held.length ? <Section title="暂不动" tone="" items={plan.held} text={(c) => c.reason} /> : null}
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--sub)' }}>
        <input type="checkbox" checked={includeSlots} onChange={(e) => setIncludeSlots(e.target.checked)} />也清理固定编号的接续片段（默认保留）
      </label>
    </Modal>
  );
}
