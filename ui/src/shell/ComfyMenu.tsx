import { useCallback, useRef, useState } from 'react';
import { api, type Result } from '../api';
import { Icon, Pill, useToast } from '../components';
import { LauncherFormat } from '../legacy';
import { useApp } from './context';
import { useOutside } from './useOutside';

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'muted' };

// The ComfyUI status pill: state and GPU memory at a glance, start / stop and friends on click.
export function ComfyMenu() {
  const { status, go } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, open, close);
  const toast = useToast();

  const info = status ? LauncherFormat.stateInfo(status.state) : { text: '读取中…', tone: 'idle' as const };
  const vram = status && status.vramTotal && status.vramFree !== null
    ? `${LauncherFormat.formatGB(status.vramTotal - status.vramFree)} / ${LauncherFormat.formatGB(status.vramTotal)}`
    : '';
  const running = status?.state === 'running';
  const remote = !!status?.remote;
  const stopped = !status || status.state === 'stopped' || status.state === 'timeout' || status.state === 'error' || status.state === 'remote-stopped';

  const run = async (fn: () => Promise<Result | void>) => {
    setOpen(false);
    const r = await fn();
    if (r && r.message) toast(r.message, { tone: r.ok ? 'ok' : 'bad' });
  };

  return (
    <div className="menu-wrap no-drag" ref={ref}>
      <Pill id="comfy-status" tone={TONE[info.tone] || 'muted'} onClick={() => setOpen((o) => !o)}>
        <span id="state-badge">{remote ? status?.serverName : 'ComfyUI'} {info.text}</span>{vram ? <span className="num">· 显存 {vram}</span> : null}
      </Pill>
      {open ? (
        <div className="menu" id="comfy-menu">
          {status?.message ? <div className="note">{status.message}</div> : null}
          <button id="btn-start" disabled={!stopped} onClick={() => run(api.start)}><Icon name="play" />{remote ? '启动服务器上的 ComfyUI' : '启动'}</button>
          {remote ? <>
            {status?.state === 'remote-down' ? <button id="btn-remote-retry" onClick={() => run(api.remoteRetry)}><Icon name="refresh" />重新连接服务器</button> : null}
            <button id="btn-remote-local" onClick={() => run(() => api.remoteUse({ id: 'local' }))}>改回本机出片</button>
          </> : <>
            <button id="btn-restart" disabled={!running} onClick={() => run(api.restart)}><Icon name="refresh" />重启</button>
            <button id="btn-stop" disabled={stopped} onClick={() => run(api.stop)}><Icon name="x" />停止</button>
            <button id="btn-clear" onClick={() => run(api.clearCache)}><Icon name="trash" />清缓存</button>
          </>}
          <div className="hr" />
          <button id="btn-open-ui" disabled={!running} onClick={() => run(api.openUI)}>打开 ComfyUI 网页</button>
          <button id="btn-open-log" onClick={() => run(api.openLog)}>打开日志所在文件夹</button>
          <button onClick={() => { setOpen(false); go('settings', 'run'); }}>运行详情…</button>
          <button id="btn-remote-settings" onClick={() => { setOpen(false); go('settings', 'remote'); }}>{remote ? '远程 GPU 设置…' : '改到远程 GPU 出片…'}</button>
        </div>
      ) : null}
    </div>
  );
}
