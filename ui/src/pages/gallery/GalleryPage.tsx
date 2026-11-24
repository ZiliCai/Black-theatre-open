import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, EmptyState, Field, Icon, Modal, Segmented, TextInput, useToast } from '../../components';
import { GalleryFilter as GF, LauncherFormat as fmt } from '../../legacy';
import { useApp } from '../../shell/context';
import { ClipSync } from './ClipSync';
import './gallery.css';

type Entry = Loose & { relPath: string; name: string; kind: 'video' | 'image'; mtimeMs: number; size: number; keptShot?: string | null };
type Kind = 'video' | 'image' | 'kept';
const PAGE_SIZE = 120;
const WHAT: Record<Kind, string> = { video: '视频', image: '图片', kept: '保留的视频' };
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const fileUrl = (e: Entry) => `media://local/${e.relPath.split('/').map(encodeURIComponent).join('/')}?v=${Math.round(e.mtimeMs)}`;
const PROMPT_KEY = /^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*[:：]/;

// A video only loads while its card is near the screen; leaving frees the decoder.
function LazyVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(([it]) => setNear(it.isIntersecting), { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <video ref={ref} src={near ? `${src}#t=0.1` : undefined} muted loop preload="metadata"
    onMouseEnter={(e) => { e.currentTarget.play().catch(() => {}); }}
    onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0.1; }} />;
}

function Chips({ e }: { e: Entry }) {
  return <div className="gal-chips">{GF.chipsOf(e).map((c: { text: string; tone: string }, i: number) => <span key={i} className={`gchip ${c.tone}`}>{c.text}</span>)}</div>;
}

function PromptText({ text }: { text: string }) {
  return <pre id="viewer-prompt">{text.split('\n').map((line, i) => {
    const m = PROMPT_KEY.exec(line);
    return <span key={i}>{m ? <><span className="pk">{m[0]}</span>{line.slice(m[0].length)}</> : line}{'\n'}</span>;
  })}</pre>;
}

export function GalleryPage() {
  const { project, projectVersion } = useApp();
  const toast = useToast();
  const [data, setData] = useState<(Loose & { entries: Entry[] }) | null>(null);
  const [kind, setKind] = useState<Kind>('video');
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [customRoot, setCustomRoot] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE_SIZE);
  const [viewing, setViewing] = useState(-1);
  const [keeping, setKeeping] = useState<Entry | null>(null);
  const [shotText, setShotText] = useState('');
  const [syncing, setSyncing] = useState(false);

  const withKept = (r: Loose) => ({ ...r, entries: (r.entries as Entry[]).map((e) => ({ ...e, keptShot: (r.kept || {})[e.relPath] || null })) });

  const load = useCallback(async (root: string | null = customRoot) => {
    let r = await api.getGallery({ root: root || undefined });
    if (!r.ok && root) {
      toast(r.message, { tone: 'bad' });
      setCustomRoot(null);
      r = await api.getGallery({});
    }
    if (!r.ok) { toast(r.message || '读取成片失败', { tone: 'bad' }); return; }
    setData(withKept(r) as Loose & { entries: Entry[] });
  }, [customRoot, toast]);

  useEffect(() => { setCustomRoot(null); setSelected(new Set()); load(null); }, [projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = window.setTimeout(() => { setQuery(typed); setShown(PAGE_SIZE); }, 150); return () => window.clearTimeout(t); }, [typed]);

  const list: Entry[] = useMemo(() => (data ? GF.filterEntries(data.entries, { kind, query }) : []), [data, kind, query]);
  const counts = GF.countByKind(data ? data.entries : [], query);
  // what is ticked is always what is on screen
  useEffect(() => {
    const on = new Set(list.map((e) => e.relPath));
    setSelected((s) => new Set([...s].filter((r) => on.has(r))));
  }, [list]);

  const releaseMedia = async () => {
    document.querySelectorAll('.gallery video, .gal-viewer video').forEach((v) => {
      const video = v as HTMLVideoElement;
      video.pause();
      video.removeAttribute('src');
      video.load();
    });
    await new Promise((r) => setTimeout(r, 150)); // Windows cannot recycle a file that is still open
  };

  const trash = async (relPaths: string[]) => {
    if (!relPaths.length) return false;
    await releaseMedia();
    const r = await api.trashGallery({ relPaths });
    if (r.cancelled) { load(); return false; }
    toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
    const gone = new Set<string>(r.trashed || []);
    if (gone.size && data) {
      setData({ ...data, entries: data.entries.filter((e) => !gone.has(e.relPath)) });
      setSelected((s) => new Set([...s].filter((x) => !gone.has(x))));
    }
    return gone.size > 0;
  };

  const afterKeep = (r: Loose) => {
    toast(r.message, { tone: r.ok ? 'ok' : 'bad' });
    if (r.kept && data) setData(withKept({ ...data, kept: r.kept }) as Loose & { entries: Entry[] });
  };
  const keep = async (e: Entry) => {
    const shot = GF.normalizeShot(shotText);
    if (!shot) { toast('分镜号要写成 集-镜 的样子，比如 1-4', { tone: 'bad' }); return; }
    setKeeping(null);
    afterKeep(await api.keepTake({ relPath: e.relPath, shot }));
  };
  const toggleKeep = async (e: Entry) => {
    if (!e.keptShot) { setShotText(''); setKeeping(e); return; }
    afterKeep(await api.unkeepTake({ relPath: e.relPath }));
  };

  const viewed = viewing >= 0 ? list[viewing] : null;
  useEffect(() => {
    if (viewing < 0) return undefined;
    const onKey = (ev: KeyboardEvent) => {
      if (keeping) return;
      if (ev.key === 'Escape') setViewing(-1);
      else if (ev.key === 'ArrowLeft') setViewing((v) => Math.max(0, v - 1));
      else if (ev.key === 'ArrowRight') setViewing((v) => Math.min(list.length - 1, v + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewing, list.length, keeping]);
  useEffect(() => { if (viewing >= list.length) setViewing(list.length ? list.length - 1 : -1); }, [list.length, viewing]);

  if (!data) return <div className="gallery" id="gallery" />;
  const where = fmt.formatPathParts(data.root);
  const totalBytes = data.entries.reduce((n, e) => n + e.size, 0);
  const videos = data.entries.filter((e) => e.kind === 'video').length;
  const p = (viewed && viewed.params) || {};
  const facts: [string, string | string[], boolean?][] = viewed ? ([
    ['文件', viewed.relPath, true],
    ['种子', p.seed === null || p.seed === undefined ? '' : String(p.seed), true],
    ['步数', p.steps ? `${p.steps}${p.turbo ? '（Turbo）' : ''}` : ''],
    ['采样', [p.sampler, p.scheduler].filter(Boolean).join(' / ')],
    ['模型', p.unet ? baseName(String(p.unet).replace(/\\/g, '/')) : ''],
    ['LoRA', p.loras || []],
    ['参考图', p.refs || []],
  ] as [string, string | string[], boolean?][]).filter(([, v]) => v && v.length) : [];

  return (
    <div className="gallery" id="gallery">
      <div className="gal-head">
        <div className="gal-row">
          <Segmented id="gal-tabs" value={kind} onChange={(k) => { setKind(k); setShown(PAGE_SIZE); }} options={[
            { value: 'video', label: `视频 ${counts.video}` }, { value: 'image', label: `图片 ${counts.image}` }, { value: 'kept', label: `★ 已保留 ${counts.kept}` },
          ]} />
          <div className="search"><Icon name="search" /><TextInput small id="gal-search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="搜索提示词、文件名、种子、参考图…" /></div>
        <Button id="btn-gal-refresh" onClick={async () => { await load(); toast('已刷新', { tone: 'ok' }); }}><Icon name="refresh" />刷新</Button>
        <Button id="btn-gal-clips" title="查看哪些接续片段已经没有对应视频，再决定是否移到回收站" onClick={() => setSyncing(true)}>清理接续片段…</Button>
        </div>
        <div className="gal-row gal-where">
          <span className="ellipsis" title={data.root} id="gal-root">{data.isDefault ? (project ? `正在看：《${project.name}》的生成结果` : '正在看：当前项目的生成结果') : `正在看文件夹：${where.tail}`}</span>
          <span style={{ flex: 1 }} />
          <Button size="sm" id="btn-gal-pick" onClick={async () => {
            const chosen = await api.pickGalleryRoot();
            if (!chosen) return;
            setCustomRoot(chosen); setSelected(new Set()); setShown(PAGE_SIZE); load(chosen);
          }}><Icon name="folder" />换文件夹看…</Button>
          {!data.isDefault ? <Button size="sm" id="btn-gal-reset" onClick={() => { setCustomRoot(null); setSelected(new Set()); load(null); }}>回到输出目录</Button> : null}
          <Button size="sm" id="btn-gal-open" onClick={async () => { const r = await api.openGalleryRoot(); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>打开文件夹</Button>
        </div>
        <div className="gal-summary num" id="gal-summary">
          共 {data.entries.length} 个（视频 {videos} · 图片 {data.entries.length - videos}）· 占用 {fmt.formatBytes(totalBytes)}
          {query.trim() ? ` · 搜索到 ${list.length} 个${WHAT[kind]}` : ''}{data.truncated ? ' · 文件太多，只显示最新的一部分' : ''}
        </div>
      </div>
      {selected.size ? (
        <div className="gal-bar" id="gal-bar">
          <b>已选 {selected.size} 个</b>
          <Button size="sm" id="btn-gal-all" onClick={() => setSelected(new Set(list.map((e) => e.relPath)))}>全选当前列表</Button>
          <Button size="sm" id="btn-gal-none" onClick={() => setSelected(new Set())}>取消选择</Button>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="danger" id="btn-gal-trash" onClick={() => trash([...selected])}><Icon name="trash" />移到回收站</Button>
        </div>
      ) : null}
      <div className="gal-scroll">
        {list.length ? (
          <div className="gal-grid" id="gal-grid">
            {list.slice(0, shown).map((e, i) => (
              <article title={e.relPath} key={e.relPath} data-rel={e.relPath} className={`gal-card ${selected.has(e.relPath) ? 'sel' : ''}`} onClick={() => setViewing(i)}>
                <div className="gal-thumb">
                  {e.kind === 'video' ? <LazyVideo src={fileUrl(e)} /> : <img src={fileUrl(e)} alt="" loading="lazy" decoding="async" />}
                  {e.kind === 'video' && GF.formatDuration(e.duration) ? <span className="gal-badge num">{GF.formatDuration(e.duration)}</span> : null}
                  <label className="gal-check" onClick={(ev) => ev.stopPropagation()}>
                    <input type="checkbox" aria-label="选中" checked={selected.has(e.relPath)} onChange={(ev) => {
                      const next = new Set(selected);
                      if (ev.target.checked) next.add(e.relPath); else next.delete(e.relPath);
                      setSelected(next);
                    }} />
                  </label>
                </div>
                <div className="gal-body">
                  <div className="gal-title">{GF.titleOf(e) === e.name ? (e.kind === 'video' ? '生成的视频' : '生成的图片') : GF.titleOf(e)}</div>
                  <Chips e={e} />
                  <div className="gal-meta num">{[GF.formatStamp(e.mtimeMs, Date.now()), GF.formatResolution(e.width, e.height), fmt.formatBytes(e.size)].filter(Boolean).join(' · ')}</div>
                  {e.kind === 'video' && !e.name.startsWith('bb_') ? <Button size="sm" className="gal-keep" on={e.keptShot ? 'good' : false} onClick={(ev) => { ev.stopPropagation(); toggleKeep(e); }}>
                    {e.keptShot ? `★ 分镜 ${e.keptShot} · 取消保留` : '留给指定分镜接续…'}
                  </Button> : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title={data.missing ? '这个文件夹还不存在' : query.trim() ? `没有符合搜索的${WHAT[kind]}` : `这里还没有${WHAT[kind]}`}
            body={data.missing ? 'ComfyUI 还没有往里面保存过东西。' : kind === 'kept' ? '旧做法里在视频卡片上点「留给指定分镜接续…」的会出现在这里。新做法请用镜头页的「选中」。' : undefined} />
        )}
        {list.length > shown ? <Button className="gal-more" onClick={() => setShown(shown + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, list.length - shown)} 个（还有 {list.length - shown} 个）</Button> : null}
      </div>

      {viewed ? (
        <div className="gal-viewer" id="gal-viewer" onClick={(ev) => { if (ev.target === ev.currentTarget) setViewing(-1); }}>
          <div className="media" onClick={(ev) => { if (ev.target === ev.currentTarget) setViewing(-1); }}>
            {viewed.kind === 'video' ? <video key={viewed.relPath} src={fileUrl(viewed)} controls autoPlay loop /> : <img src={fileUrl(viewed)} alt="" />}
            <Button className="nav-btn prev" id="viewer-prev" disabled={viewing <= 0} onClick={() => setViewing(viewing - 1)}>‹</Button>
            <Button className="nav-btn next" id="viewer-next" disabled={viewing >= list.length - 1} onClick={() => setViewing(viewing + 1)}>›</Button>
          </div>
          <aside>
            <div className="scroll">
              <h3>{GF.titleOf(viewed)}</h3>
              <div className="meta num">{[new Date(viewed.mtimeMs).toLocaleString('zh-CN', { hour12: false }), GF.formatResolution(viewed.width, viewed.height), GF.formatDuration(viewed.duration), fmt.formatBytes(viewed.size)].filter(Boolean).join(' · ')}</div>
              <Chips e={viewed} />
              <dl>{facts.map(([k, v, mono]) => <FactRow key={k} k={k} v={v} mono={!!mono} />)}</dl>
              {p.promptText ? <>
                <div className="c-section-title"><span>提示词</span>
                  <Button size="sm" variant="ghost" id="btn-viewer-copy" onClick={async () => { const r = await api.copyText({ text: p.promptText }); toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' }); }}><Icon name="copy" />复制</Button></div>
                <PromptText text={p.promptText} />
              </> : null}
            </div>
            <div className="actions">
              {viewed.kind === 'video' && !viewed.name.startsWith('bb_') ? <Button id="btn-viewer-keep" variant={viewed.keptShot ? 'default' : 'primary'} onClick={() => toggleKeep(viewed)}>{viewed.keptShot ? `★ 分镜 ${viewed.keptShot} · 取消保留` : '留给指定分镜接续…'}</Button> : null}
              <Button id="btn-viewer-reveal" onClick={async () => { const r = await api.revealGallery({ relPath: viewed.relPath }); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>在文件夹中显示</Button>
              <Button id="btn-viewer-trash" variant="danger" onClick={async () => {
                const before = list.length;
                const at = viewing;
                if (await trash([viewed.relPath])) setViewing(GF.indexAfterRemoval(before, at));
              }}><Icon name="trash" />移到回收站</Button>
              <Button id="viewer-close" variant="ghost" onClick={() => setViewing(-1)}>关闭</Button>
            </div>
          </aside>
        </div>
      ) : null}

      {keeping ? (
        <Modal title="为分镜保留这个版本" onClose={() => setKeeping(null)} actions={<>
          <Button onClick={() => setKeeping(null)}>取消</Button>
          <Button variant="primary" id="btn-keep-ok" onClick={() => keep(keeping)}>保留</Button>
        </>}>
          <p style={{ color: 'var(--sub)', lineHeight: 1.7 }}>{keeping.name}<br />保留后，这段视频的接续片段会按分镜号改名，方便以后接着生成。新生成的镜头请在镜头页用「选中」。</p>
          <Field label="分镜号（集-镜）"><TextInput id="keep-shot" autoFocus value={shotText} placeholder="1-4" onChange={(e) => setShotText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') keep(keeping); }} /></Field>
        </Modal>
      ) : null}
      {syncing ? <ClipSync onClose={() => setSyncing(false)} /> : null}
    </div>
  );
}

function FactRow({ k, v, mono }: { k: string; v: string | string[]; mono: boolean }) {
  return <><dt>{k}</dt><dd className={mono ? 'mono' : ''}>{Array.isArray(v) ? v.map((x, i) => <div key={i}>{x}</div>) : v}</dd></>;
}
