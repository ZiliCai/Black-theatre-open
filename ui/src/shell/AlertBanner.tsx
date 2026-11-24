import { useEffect, useState } from 'react';
import { api, type Alert } from '../api';
import { Button, Icon, useToast } from '../components';
import { useApp } from './context';

// The project (or a folder setting) changed while ComfyUI runs: it still writes to the old folders until a restart,
// and the shot page will not start new takes until then.
export function PendingBanner() {
  const { status, project } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const dirs = status?.dirs;
  if (status?.state !== 'running' || !dirs || !(dirs.output?.pending || dirs.input?.pending)) return null;
  return (
    <div className="banner info" id="pending-banner">
      <Icon name="refresh" />
      <span className="t">{project ? `已切换到《${project.name}》` : '目录已更改'}</span>
      <span className="s">ComfyUI 还在使用原来的输出/输入文件夹，重启后才会改用新的。</span>
      <Button size="sm" variant="primary" disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await api.restart();
        setBusy(false);
        toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
      }}>重启 ComfyUI</Button>
    </div>
  );
}

// ComfyUI wrote an error to its log: say so, and let the user copy a ready-made report.
export function AlertBanner() {
  const [alert, setAlert] = useState<Alert>(null);
  const toast = useToast();
  useEffect(() => api.onAlert(setAlert), []);
  if (!alert) return null;
  return (
    <div className="banner" id="alert-banner" role="alert">
      <Icon name="warn" />
      <span className="t">{alert.title}</span>
      <span className="s ellipsis">{alert.sub}</span>
      <Button size="sm" id="btn-alert-copy" onClick={async () => {
        const r = await api.copyReport();
        toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
      }}><Icon name="copy" />复制报错</Button>
      <Button size="sm" variant="ghost" id="btn-alert-dismiss" onClick={() => api.dismissAlert()}>关闭</Button>
    </div>
  );
}
