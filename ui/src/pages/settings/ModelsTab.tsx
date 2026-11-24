import { useEffect, useMemo, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, Icon, TextInput, useToast } from '../../components';
import { LauncherFormat as fmt, ModelFilter as MF } from '../../legacy';

const FORMAT_TAGS = new Set(['GGUF', 'INT8', 'FP8', 'NVFP4', 'BF16', 'FP16', 'FP32', 'TensorRT', 'ONNX']);
const isFormat = (t: string) => FORMAT_TAGS.has(t) || /^I?Q\d/i.test(t);

export function ModelsTab() {
  const toast = useToast();
  const [data, setData] = useState<Loose | null>(null);
  const [typed, setTyped] = useState('');
  const [filter, setFilter] = useState({ query: '', tag: '', category: '' });
  const load = async (force = false) => setData(await api.getModels({ force }));
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = window.setTimeout(() => setFilter((f) => ({ ...f, query: typed })), 120); return () => window.clearTimeout(t); }, [typed]);
  const shown = useMemo(() => (data ? MF.filterModels(data.models, filter) : []), [data, filter]);
  if (!data) return <div className="set-inner"><p className="muted">扫描中…</p></div>;

  const inQuery = MF.filterModels(data.models, { query: filter.query });
  const base = MF.filterModels(data.models, { query: filter.query, category: filter.category });
  const filtering = !!(filter.query || filter.tag || filter.category);
  return (
    <div className="set-inner" id="tab-models">
      <h2>模型</h2>
      <div className="row" style={{ display: 'flex', gap: 8 }}>
        <TextInput small value={typed} placeholder="搜索模型名、标签…" onChange={(e) => setTyped(e.target.value)} style={{ flex: 1 }} />
        <Button size="sm" onClick={async () => { await load(true); toast('已重新扫描', { tone: 'ok' }); }}><Icon name="refresh" />重新扫描</Button>
      </div>
      <p className="muted num">共 {data.count} 个模型 · 占用 {fmt.formatBytes(data.totalBytes)}{filtering ? ` · 当前显示 ${shown.length} 个` : ''} · 扫描于 {fmt.formatAgo(data.scannedAt, Date.now())}</p>
      <div className="chips">
        <button className={`chip ${!filter.category ? 'on' : ''}`} onClick={() => setFilter({ ...filter, category: '', tag: '' })}>全部<span className="n">{inQuery.length}</span></button>
        {MF.groupByCategory(inQuery).map((g: Loose) => (
          <button key={g.category} className={`chip ${filter.category === g.category ? 'on' : ''}`}
            onClick={() => setFilter({ ...filter, category: filter.category === g.category ? '' : g.category, tag: '' })}>{g.category}<span className="n">{g.models.length}</span></button>
        ))}
      </div>
      <div className="chips">
        {MF.collectTags(base).slice(0, 30).map(({ tag, count }: { tag: string; count: number }) => (
          <button key={tag} className={`chip ${filter.tag === tag ? 'on' : ''}`} onClick={() => setFilter({ ...filter, tag: filter.tag === tag ? '' : tag })}>{tag}<span className="n">{count}</span></button>
        ))}
      </div>
      {shown.length ? MF.groupByCategory(shown).map((g: Loose) => (
        <div className="model-group" key={g.category}>
          <h3><span>{g.category}</span><span className="num">{g.models.length} 个 · {fmt.formatBytes(g.sizeBytes)}</span></h3>
          {g.models.map((m: Loose) => (
            <article className="model-row" key={m.relPath}>
              <div>
                <div className="t">{m.title}</div>
                <div className="f">{m.relPath}</div>
                <div className="chips" style={{ margin: '4px 0' }}>
                  {m.family ? <span className="mtag family">{m.family}</span> : null}
                  {m.tags.map((t: string) => <span key={t} className={`mtag ${isFormat(t) ? 'fmt' : ''}`}>{t}</span>)}
                </div>
                <div className="d">{m.source === 'guess' ? <span className="tag src">推测</span> : m.source === 'metadata' ? <span className="tag src">来自文件头</span> : null}{m.desc}</div>
              </div>
              <div className="side">
                <span className="num">{fmt.formatBytes(m.sizeBytes)}</span>
                <Button size="sm" variant="ghost" title="在资源管理器中显示" onClick={async () => { const r = await api.revealModel({ relPath: m.relPath }); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}><Icon name="folder" /></Button>
              </div>
            </article>
          ))}
        </div>
      )) : <p className="muted">没有符合条件的模型。</p>}
    </div>
  );
}
