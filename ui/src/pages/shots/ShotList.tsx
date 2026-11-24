import { useEffect, useState } from 'react';
import { api, type Episode } from '../../api';
import { Button, Field, Icon, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components';

const STATUS: Record<string, string> = { none: '未生成', cand: '有候选', pick: '已选中', running: '生成中' };

// warnings: what the checks found in the script; one that starts with a shot number belongs to that shot
export function ShotList({ episodes, episodeId, shotId, warnings, onEpisode, onShot, onCreated, onDeleted, onRefresh }: {
  episodes: Episode[]; episodeId: string; shotId: string; warnings: string[];
  onEpisode: (id: string) => void; onShot: (id: string) => void; onCreated: (id: string) => void;
  onDeleted: (next: string) => void; onRefresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [writing, setWriting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [place, setPlace] = useState<'before' | 'after' | 'end'>('after');
  const toast = useToast();
  const episode = episodes.find((e) => e.id === episodeId);
  const total = episode ? episode.shots.reduce((sum, s) => sum + (s.duration || 0), 0) : 0;

  // the new shot goes next to the selected one when it is in this episode (and still in the script), else at the end
  const current = episode?.shots.find((s) => s.id === shotId && s.source !== 'orphan');
  const where = current ? place : 'end';

  // with a description the AI writes the prompt, length, cards and continuation first; without one it is a blank shot
  const create = async () => {
    const anchor = current ? current.id : null;
    const wish = description.trim();
    setWriting(!!wish);
    const r = wish
      ? await api.composeShot({ episode: episodeId, title, anchor, place: where, description: wish })
      : await api.createManualShot({ episode: episodeId, title, anchor, place: where });
    setWriting(false);
    if (!r.ok || !r.id) {
      toast(r.message || '新建失败', { tone: 'bad' });
      return;
    }
    setCreating(false);
    setTitle('');
    setDescription('');
    onCreated(r.id);
    const written = r as { note?: string; warnings?: string[] };
    if (written.note) toast(written.note, { ms: 9000 });
    (written.warnings || []).forEach((w) => toast(`还没对上：${w}`, { tone: 'bad', ms: 12000 }));
    if (r.notice) toast(r.notice, { ms: 9000 });
  };

  const remove = async () => {
    if (!shotId) return;
    setDeleting(true);
    const r = await api.deleteShot({ shotId });
    setDeleting(false);
    if (r.cancelled) return;
    if (!r.ok) {
      toast(r.message || '没能删除', { tone: 'bad' });
      return;
    }
    toast(r.message || '已删除');
    onDeleted(r.next || '');
  };

  // the selected row stays in view (a new shot may land below the fold)
  useEffect(() => {
    if (shotId) document.querySelector(`#shot-rows [data-shot="${CSS.escape(shotId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [shotId, episode]);

  return (
    <aside className="shot-list">
      <div className="head">
        <div className="pick">
          <Select small id="episode-pick" value={episodeId} onChange={(e) => onEpisode(e.target.value)} aria-label="选择集">
            {episodes.map((e) => <option key={e.id} value={e.id}>第 {e.id.replace(/^E0*/i, '')} 集（{e.id}）</option>)}
          </Select>
          <Button size="sm" id="btn-shots-refresh" disabled={refreshing} title="剧本文件在外面改过以后，点这里重新读取提示词、时长和镜头列表"
            onClick={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); }}>
            <Icon name="refresh" size={14} />刷新
          </Button>
        </div>
        <div className="meta num"><span>{episode ? episode.shots.length : 0} 个镜头</span><span>剧本时长 {total.toFixed(1)} 秒</span></div>
        {warnings.length ? (
          <button className={`warn-toggle ${showWarnings ? 'on' : ''}`} id="btn-shot-warnings" onClick={() => setShowWarnings(!showWarnings)}>
            <Icon name="warn" size={13} />{warnings.length} 处提醒<span className="dim">{showWarnings ? '收起' : '展开'}</span>
          </button>
        ) : null}
        {showWarnings ? (
          <div className="warn-list" id="shot-warnings">
            {warnings.map((w, i) => {
              const target = episode?.shots.find((s) => w.startsWith(`${s.n} `));
              return (
                <button key={i} className={`warn-item ${target && target.id === shotId ? 'on' : ''}`} disabled={!target} onClick={() => target && onShot(target.id)}
                  title={target ? `去镜头 ${target.n}` : undefined}>{w}</button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="rows" id="shot-rows">
        {episode?.shots.map((s) => (
          <button key={s.id} data-shot={s.id} className={`shot-row ${s.id === shotId ? 'on' : ''} ${s.source === 'orphan' ? 'orphan' : ''}`} onClick={() => onShot(s.id)}>
            <span className="n num">{s.n}</span>
            <span className="t ellipsis" title={s.title}>{s.source === 'manual' ? '✎ ' : ''}{s.title || '（无标题）'}</span>
            {s.linkNote ? <span className="link-flag" title="前面的镜头或素材改过，这一镜可能接不上"><Icon name="warn" size={12} /></span>
              : warnings.some((w) => w.startsWith(`${s.n} `)) ? <span className="link-flag" title={warnings.filter((w) => w.startsWith(`${s.n} `)).join('\n')}><Icon name="warn" size={12} /></span> : null}
            <span className={`st ${s.status}`}>{STATUS[s.status]}</span>
          </button>
        ))}
      </div>
      <div className="foot">
        <Button id="btn-new-shot" variant="ghost" onClick={() => setCreating(true)} disabled={!episodeId}><Icon name="plus" />新建镜头</Button>
        <Button id="btn-delete-shot" variant="ghost" onClick={remove} disabled={!shotId || deleting}
          title={shotId ? `删除镜头 ${episode?.shots.find((s) => s.id === shotId)?.n || ''}（会先告诉你它连带影响哪些镜头）` : '先选一个镜头'}>
          <Icon name="trash" />删除
        </Button>
      </div>
      {creating ? (
        <Modal title="新建镜头" onClose={() => { if (!writing) setCreating(false); }} actions={<>
          <Button onClick={() => setCreating(false)} disabled={writing}>取消</Button>
          <Button variant="primary" id="btn-new-shot-ok" onClick={create} disabled={writing}>
            {writing ? 'AI 正在写…' : description.trim() ? <><Icon name="sparkle" />AI 写好再新建</> : '新建空白镜头'}
          </Button>
        </>}>
          <p style={{ color: 'var(--sub)' }}>写一句这一镜想拍什么，AI 会照前后镜头写好提示词，定下时长、挂哪些素材卡、要不要接上一镜；不写就建一个空白镜头，提示词在右边自己写。剧本镜头的顺序和镜号不变，新镜头编号是「手动N」。</p>
          <Field label="想拍什么"><TextArea id="new-shot-description" autoFocus rows={4} value={description} disabled={writing}
            onChange={(e) => setDescription(e.target.value)} placeholder="比如：阿措端着粥走到窗边，看了一眼窗外的雾，回头对朵朵说「快吃，要凉了」" /></Field>
          <Field label="标题" hint="不写就让 AI 起"><TextInput id="new-shot-title" value={title} disabled={writing} onChange={(e) => setTitle(e.target.value)} placeholder="比如：补一个林夏的特写" /></Field>
          <div className="c-field">
            <span className="c-label"><span>插在哪里</span></span>
            {current ? (
              <Segmented id="new-shot-place" wide value={place} onChange={setPlace} options={[
                { value: 'before', label: `镜头 ${current.n} 前面` },
                { value: 'after', label: `镜头 ${current.n} 后面` },
                { value: 'end', label: '本集末尾' },
              ]} />
            ) : <span style={{ color: 'var(--sub)' }}>没有选中镜头，加到本集末尾</span>}
          </div>
        </Modal>
      ) : null}
    </aside>
  );
}
