import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useApp, type SettingsTab } from '../../shell/context';
import { RunTab } from './RunTab';
import { ProjectsTab } from './ProjectsTab';
import { DirsTab } from './DirsTab';
import { ModelsTab } from './ModelsTab';
import { GeneralTab } from './GeneralTab';
import { RemoteTab } from './RemoteTab';
import './settings.css';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'projects', label: '项目' },
  { id: 'dirs', label: '目录' },
  { id: 'models', label: '模型' },
  { id: 'run', label: '运行' },
  { id: 'remote', label: '远程 GPU' },
];

export function SettingsPage() {
  const { settingsTab } = useApp();
  const [tab, setTab] = useState<SettingsTab>(settingsTab);
  const [configErrors, setConfigErrors] = useState<string[]>([]);
  useEffect(() => setTab(settingsTab), [settingsTab]);
  useEffect(() => { api.getConfig().then((r) => setConfigErrors(r.validation.errors)); }, []);
  return (
    <div className="settings">
      <nav className="set-tabs">
        {TABS.map((t) => (
          <button key={t.id} id={`set-tab-${t.id}`} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}{t.id === 'general' && configErrors.length ? <span className="bad-dot" title="有设置需要修改" /> : null}
          </button>
        ))}
      </nav>
      <div className="set-body">
        {tab === 'run' ? <RunTab /> : tab === 'remote' ? <RemoteTab /> : tab === 'projects' ? <ProjectsTab /> : tab === 'dirs' ? <DirsTab />
          : tab === 'models' ? <ModelsTab /> : <GeneralTab onValidation={setConfigErrors} />}
      </div>
    </div>
  );
}
