import { useEffect, useState } from 'react';
import { api, type Loose, type Result } from '../../api';
import { Button, Field, Icon, Modal, TextInput, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { LauncherFormat as fmt } from '../../legacy';
import { useApp } from '../../shell/context';

const baseName = (p: string) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

export function ProjectsTab() {
  const { refreshProjects, projects, status } = useApp();
  const toast = useToast();
  const { ask, confirm } = useDialog();
  const [data, setData] = useState<Loose | null>(null);
  const [creating, setCreating] = useState<{ name: string; activate: boolean; error: string } | null>(null);
  const [importing, setImporting] = useState<{ info: Loose; activate: boolean } | null>(null);

  const load = async () => setData(await api.listProjects());
  useEffect(() => { load(); }, [projects]);

  const running = status?.state === 'running';
  const applied = (r: Result, name: string) => {
    const pending = !!(r.dirs && (r.dirs.output.pending || r.dirs.input.pending));
    return running && pending ? `已切换到《${name}》，重启 ComfyUI 后生效` : running ? `已切换到《${name}》` : `已切换到《${name}》，下次启动 ComfyUI 时生效`;
  };
  const after = async () => { await refreshProjects(); await load(); };

  const switchTo = async (p: Loose) => {
    const r = await api.switchProject({ dir: p.dir });
    if (!r.ok) { toast(r.message || '切换失败', { tone: 'bad' }); return; }
    await after();
    toast(applied(r, p.name), { tone: 'ok' });
  };

  const create = async () => {
    if (!creating) return;
    const r = await api.createProject({ name: creating.name, activate: creating.activate });
    if (!r.ok) { setCreating({ ...creating, error: r.message || '创建失败' }); return; }
    setCreating(null);
    await after();
    toast(r.warning ? `项目已创建，但没能切换:${r.warning}` : r.activated ? applied(r, String(baseName(r.dir))) : '项目已创建', { tone: r.warning ? 'bad' : 'ok' });
  };

  const startImport = async () => {
    const dir = await api.pickProjectFolder();
    if (!dir) return;
    const info = await api.inspectProject({ dir });
    if (!info.ok) { toast(info.message, { tone: 'bad' }); return; }
    setImporting({ info, activate: true });
  };
  const doImport = async () => {
    if (!importing) return;
    const { info, activate } = importing;
    const r = await api.importProject({ dir: info.dir, docsDir: info.isProject ? '' : info.suggestedDocsDir, activate });
    if (!r.ok) { toast(r.message || '导入失败', { tone: 'bad' }); return; }
    setImporting(null);
    await after();
    toast(r.warning ? `已导入，但没能切换:${r.warning}` : r.activated ? applied(r, info.name) : '已导入', { tone: r.warning ? 'bad' : 'ok' });
  };

  if (!data) return <div className="set-inner" />;
  const stats = (p: Loose) => {
    const s = p.stats;
    if (!s || !s.exists) return '';
    return `${fmt.formatBytes(s.sizeBytes)} · ${s.fileCount}${s.approximate ? '+' : ''} 个文件 · 最近修改 ${fmt.formatAgo(s.latestMtime, Date.now())}`;
  };

  return (
    <div className="set-inner" id="tab-projects">
      <h2>项目</h2>
      <p className="lead">每个项目都有自己的文件夹，里面放着剧本、素材、生成结果和生成记录。新建的项目放在 {data.root}。</p>
      <div className="row" style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" id="btn-proj-new" onClick={() => setCreating({ name: '', activate: true, error: '' })}><Icon name="plus" />新建项目</Button>
        <Button id="btn-proj-import" onClick={startImport}><Icon name="folder" />导入已有文件夹…</Button>
        {data.activeProject ? <Button variant="ghost" id="btn-proj-leave" onClick={async () => {
          const r = await api.leaveProject();
          if (!r.ok) { toast(r.message || '', { tone: 'bad' }); return; }
          await after();
          toast('已改为不使用项目，输出/输入目录保持当前设置', { tone: 'ok' });
        }}>不使用项目</Button> : null}
      </div>
      {data.activeMissing ? <div className="errors">当前项目的文件夹找不到了（{data.activeProject}），已按「无项目」处理。ComfyUI 的输出/输入目录保持不变，不影响启动。</div> : null}
      {data.projects.length ? data.projects.map((p: Loose) => (
        <article key={p.dir} className={`proj-card ${p.active ? 'active' : ''}`}>
          <h3>{p.name}{p.active ? <span className="tag acc">当前项目</span> : null}{!p.exists ? <span className="tag bad">找不到文件夹</span> : null}</h3>
          <div className="path" title={p.dir}>{p.dir}</div>
          <div className="muted">{p.exists ? [stats(p), `设定文档：${baseName(p.docsDir)}`].filter(Boolean).join(' · ') : '文件夹被移走或删除了。可以把它移出列表，也可以把文件夹放回原处。'}</div>
          <div className="actions">
            <Button size="sm" variant={p.active ? 'default' : 'primary'} disabled={p.active || !p.exists} onClick={() => switchTo(p)}>{p.active ? '正在使用' : '切换到此项目'}</Button>
            <Button size="sm" disabled={!p.exists} onClick={async () => { const r = await api.openProject({ dir: p.dir }); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>打开文件夹</Button>
            <Button size="sm" disabled={!p.exists} onClick={async () => {
              const name = await ask({ title: '重命名项目', label: '新的名字（只改显示名，文件夹名不变）', value: p.name, okLabel: '改名' });
              if (name === null) return;
              const r = await api.renameProject({ dir: p.dir, name });
              toast(r.ok ? '已改名' : r.message || '', { tone: r.ok ? 'ok' : 'bad' });
              if (r.ok) after();
            }}>重命名</Button>
            <Button size="sm" variant="ghost" onClick={async () => {
              if (!(await confirm({ title: '移出列表', message: `把《${p.name}》从项目列表里移除？`, detail: '只是不再显示，文件夹和里面的文件都不会被删除。以后可以用「导入已有文件夹」再加回来。', okLabel: '移出列表' }))) return;
              const r = await api.forgetProject({ dir: p.dir });
              if (!r.ok) { toast(r.message || '', { tone: 'bad' }); return; }
              await after();
              toast('已移出列表', { tone: 'ok' });
            }}>移出列表</Button>
          </div>
        </article>
      )) : <div className="card"><p className="muted">还没有项目。新建一个，或者导入你已经在写的剧本文件夹。</p></div>}

      {creating ? (
        <Modal title="新建剧本项目" onClose={() => setCreating(null)} actions={<>
          <Button onClick={() => setCreating(null)}>取消</Button>
          <Button variant="primary" id="btn-proj-create" onClick={create}>创建</Button>
        </>}>
          <Field label="剧本名"><TextInput id="new-project-name" autoFocus value={creating.name} placeholder="例如：穿越时空"
            onChange={(e) => setCreating({ ...creating, name: e.target.value, error: '' })} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></Field>
          <p className="muted" style={{ color: 'var(--dim)' }}>会在 {data.root} 里建一个同名文件夹，里面有 output、input 和 剧本。</p>
          <label className="check"><input type="checkbox" checked={creating.activate} onChange={(e) => setCreating({ ...creating, activate: e.target.checked })} />创建后切换到这个项目</label>
          {creating.error ? <p style={{ color: 'var(--bad)' }}>{creating.error}</p> : null}
        </Modal>
      ) : null}

      {importing ? (
        <Modal title="导入已有文件夹" onClose={() => setImporting(null)} actions={<>
          <Button onClick={() => setImporting(null)}>取消</Button>
          <Button variant="primary" onClick={doImport}>导入</Button>
        </>}>
          <dl className="facts">
            <dt>文件夹</dt><dd className="path">{importing.info.dir}</dd>
            <dt>项目名</dt><dd>{importing.info.name}</dd>
            <dt>设定文档</dt><dd>{importing.info.isProject ? `${importing.info.docsDir}（沿用已有的项目设置）` : importing.info.suggestedDocsDir ? `${importing.info.suggestedDocsDir}（里面已有文档，建议直接用它）` : `${importing.info.docsDir}（新建）`}</dd>
          </dl>
          <p>{importing.info.willCreate.length ? `将新增：${importing.info.willCreate.join('、')}` : '这个文件夹已经是完整的项目，不需要新增任何东西。'}</p>
          <p style={{ color: 'var(--dim)' }}>文件夹里原有的文件一个都不会改动、移动或删除。</p>
          <label className="check"><input type="checkbox" checked={importing.activate} onChange={(e) => setImporting({ ...importing, activate: e.target.checked })} />导入后切换到这个项目</label>
        </Modal>
      ) : null}
    </div>
  );
}
