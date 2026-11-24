import { useCallback, useRef, useState } from 'react';
import { api } from '../api';
import { Icon, useToast } from '../components';
import { useApp } from './context';
import { useOutside } from './useOutside';

export function ProjectSwitcher() {
  const { project, projects, refreshProjects, go } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, open, close);
  const toast = useToast();

  const switchTo = async (dir: string) => {
    setOpen(false);
    const r = await api.switchProject({ dir });
    if (!r.ok) toast(r.message || '切换失败', { tone: 'bad' });
    await refreshProjects();
  };

  return (
    <div className="menu-wrap no-drag" ref={ref}>
      <button className="project-btn" id="project-pick" onClick={() => setOpen((o) => !o)}>
        <small>项目</small><b className="ellipsis">{project ? project.name : '未选择'}</b><Icon name="chevron" size={14} />
      </button>
      {open ? (
        <div className="menu" id="project-menu">
          {projects.length ? <div className="head">切换剧本项目</div> : <div className="note">还没有剧本项目</div>}
          {projects.map((p) => (
            <button key={p.dir} className={p.active ? 'on' : ''} disabled={!p.exists} title={p.dir} onClick={() => switchTo(p.dir)}>
              {p.active ? <Icon name="check" /> : <span style={{ width: 16 }} />}
              <span className="ellipsis">{p.name}{p.exists ? '' : '（文件夹不见了）'}</span>
            </button>
          ))}
          <div className="hr" />
          <button onClick={() => { setOpen(false); go('settings', 'projects'); }}><Icon name="plus" />新建或导入项目…</button>
        </div>
      ) : null}
    </div>
  );
}
