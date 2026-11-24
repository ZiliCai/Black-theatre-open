import { useEffect, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, Icon, useToast } from '../../components';
import { LauncherFormat as fmt } from '../../legacy';
import { useApp } from '../../shell/context';

const WHICH = [['output', '输出目录', '成片和图片保存到这里'], ['input', '输入目录', '参考图从这里读取']] as const;
const VISIBLE_WORKFLOWS = 5;

export function DirsTab() {
  const { status } = useApp();
  const toast = useToast();
  const [data, setData] = useState<Loose | null>(null);
  const [allSaves, setAllSaves] = useState(false);
  const load = async () => setData(await api.getDirs());
  // re-read when the folders ComfyUI really uses change, for example right after a restart
  const key = status?.dirs ? JSON.stringify([status.dirs.output?.path, status.dirs.output?.pending, status.dirs.input?.path, status.dirs.input?.pending]) : '';
  useEffect(() => { load(); }, [key]);
  if (!data) return <div className="set-inner" />;

  const apply = async (which: string, chosen: string) => {
    const r = await api.setDir({ which, path: chosen });
    toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
    if (r.ok) setData(r.payload);
  };
  const saves = (data.saves?.workflows || []).slice().sort((a: Loose, b: Loose) => b.mtime - a.mtime);
  const pending = data.output.pending || data.input.pending;

  return (
    <div className="set-inner" id="tab-dirs">
      <h2>目录</h2>
      {data.project ? <div className="note-box">输出和输入目录现在由剧本项目《{data.project.name}》决定，在这里不能单独修改。要手动指定，先在「项目」里选「不使用项目」。</div> : null}
      {pending ? <div className="note-box"><span style={{ flex: 1 }}>目录刚刚更改，ComfyUI 还在使用原来的文件夹，重启后才会改用新的。</span>
        <Button size="sm" variant="primary" onClick={async () => { const r = await api.restart(); toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' }); }}>重启 ComfyUI</Button></div> : null}
      {WHICH.map(([which, title, sub]) => {
        const d = data[which];
        const parts = fmt.formatPathParts(d.path);
        const s = d.stats || {};
        return (
          <div className="card" key={which}>
            <h3>{title}<span className={`tag ${d.source === 'running' ? 'ok' : d.source === 'config' ? 'acc' : ''}`}>{d.source === 'running' ? '运行中的实例正在使用' : d.source === 'config' ? '自定义位置' : '默认位置'}</span></h3>
            <p className="muted">{sub}</p>
            <div className="path" title={d.path}>{parts.head}<b>{parts.tail || d.path}</b></div>
            <p className="muted num">{s.exists ? `${fmt.formatBytes(s.sizeBytes)} · ${s.fileCount}${s.approximate ? '+' : ''} 个文件 · 最近修改 ${fmt.formatAgo(s.latestMtime, Date.now())}` : '这个文件夹还不存在，ComfyUI 第一次保存时会自动创建。'}</p>
            <div className="row">
              <Button size="sm" disabled={!!data.project} onClick={async () => { const chosen = await api.pickDir({ which }); if (chosen) apply(which, chosen); }}><Icon name="folder" />更改…</Button>
              <Button size="sm" disabled={!!data.project} onClick={() => apply(which, '')}>恢复默认</Button>
              <Button size="sm" variant="ghost" onClick={async () => { const r = await api.openDir({ which }); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>打开</Button>
            </div>
          </div>
        );
      })}
      <div className="card saves">
        <h3>已保存工作流里的保存节点</h3>
        <p className="muted">在 ComfyUI 网页里保存过的工作流，各自把文件存到哪里。</p>
        {saves.length ? (allSaves ? saves : saves.slice(0, VISIBLE_WORKFLOWS)).map((wf: Loose, i: number) => (
          <details key={wf.name} open={i === 0}>
            <summary><span>{wf.name}</span><span>{wf.saves.length} 个保存节点</span></summary>
            {wf.saves.map((sv: Loose, j: number) => (
              <div key={j} className={`save-row ${sv.muted ? 'muted' : ''}`}>
                <span className="k">{sv.kind}</span>
                <span>{sv.linked ? '文件名由其他节点决定' : `${sv.folder ? `${sv.folder.replace(/\//g, '\\')}\\` : ''}${sv.namePrefix}_*`}</span>
                {sv.muted ? <span>当前已静音/绕过</span> : null}
                {sv.title ? <span>{sv.title}</span> : null}
              </div>
            ))}
          </details>
        )) : <p className="muted">没有在已保存的工作流里找到保存节点。</p>}
        {saves.length > VISIBLE_WORKFLOWS ? <Button size="sm" variant="ghost" onClick={() => setAllSaves(!allSaves)}>{allSaves ? '收起' : `显示全部 ${saves.length} 个工作流`}</Button> : null}
        {data.saves?.unreadable ? <p className="muted">有 {data.saves.unreadable} 个工作流文件无法读取，已跳过。</p> : null}
      </div>
    </div>
  );
}
