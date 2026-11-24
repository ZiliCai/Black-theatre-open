import { useState } from 'react';
import { api, type Result } from '../../api';
import { Button, Icon, useToast } from '../../components';
import { LauncherFormat as fmt } from '../../legacy';
import { useApp } from '../../shell/context';

const MB = 1024 * 1024;

function Gauge({ label, value, pct, tone, right, note }: { label: string; value: string; pct: number; tone: string; right?: string; note?: string }) {
  return (
    <div className={`gauge ${tone}`}>
      <div className="k"><span>{label}</span><span className="num">{right}</span></div>
      <div className="v num">{value}</div>
      <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

function describeClear(r: Result) {
  if (!r.ok) return `清缓存失败:${r.message}`;
  const parts = [`temp 已清空，释放 ${fmt.formatBytes(r.freedBytes || 0)}`];
  parts.push(r.freedModels ? '已让 ComfyUI 释放模型缓存' : 'ComfyUI 未运行或释放接口不可用');
  if (r.message) parts.push(r.message);
  parts.push('想彻底归还内存请用「重启」');
  return parts.join('；');
}

// What used to be the overview page: is ComfyUI up, how much memory it holds, and the buttons to drive it.
export function RunTab() {
  const { status: s } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const info = s ? fmt.stateInfo(s.state) : { text: '读取中…', tone: 'idle' };
  const up = s?.state === 'running' || s?.state === 'starting';

  const run = async (label: string, fn: () => Promise<Result>, describe?: (r: Result) => string) => {
    setBusy(true);
    toast(`${label}…`);
    try {
      const r = await fn();
      toast(describe ? describe(r) : r.message || '', { tone: r.ok ? 'ok' : 'bad' });
    } catch (e) {
      toast(`${label}失败:${(e as Error).message}`, { tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const vramUsed = s?.vramTotal ? s.vramTotal - (s.vramFree || 0) : 0;
  const vram = s?.vramTotal ? fmt.vramView({ used: vramUsed, total: s.vramTotal, queueRunning: s.queueRunning, queuePending: s.queuePending }) : null;
  const ramUsed = s?.ramTotal ? s.ramTotal - (s.ramFree || 0) : 0;
  const ramPct = s?.ramTotal ? fmt.percent(ramUsed, s.ramTotal) : 0;
  const procPct = s?.processMemMB && s.ramTotal ? fmt.percent(s.processMemMB * MB, s.ramTotal) : 0;

  return (
    <div className="set-inner" id="tab-run">
      <h2>运行</h2>
      <div className="card">
        <div className="status-line">
          <span className="big" id="run-state">{info.text}</span>
          {s?.deviceName ? <span className="tag">{s.deviceName}</span> : null}
          {s?.remote ? <span className="tag acc">远程 · {s.serverName}</span> : null}
        </div>
        {s?.message ? <p className="muted">{s.message}</p> : null}
        <dl className="facts num">
          {s?.remote ? null : <><dt>进程 PID</dt><dd id="v-pid">{s?.pid ? String(s.pid) : '—'}</dd></>}
          <dt>ComfyUI 队列</dt><dd>{s?.queueRunning === null || s?.queueRunning === undefined ? '—' : `${s.queueRunning} 运行 / ${s.queuePending} 等待`}</dd>
        </dl>
        <div className="gauges">
          <Gauge label="显存" value={s?.vramTotal ? `${fmt.formatGB(vramUsed)} / ${fmt.formatGB(s.vramTotal)}` : '—'} pct={vram ? vram.pct : 0}
            tone={vram ? vram.tone : 'idle'} right={vram ? `${Math.round(vram.pct)}%` : ''} note={vram?.holdingModels ? '空闲时占着显存是正常的：模型留在显存里，下次生成更快' : undefined} />
          <Gauge label="电脑内存" value={s?.ramTotal ? `${fmt.formatGB(ramUsed)} / ${fmt.formatGB(s.ramTotal)}` : '—'} pct={ramPct}
            tone={s?.ramTotal ? fmt.usageTone(ramPct) : 'idle'} right={s?.ramTotal ? `${Math.round(ramPct)}%` : ''} />
          {s?.remote ? null : <Gauge label="ComfyUI 自己占用" value={fmt.formatMB(s?.processMemMB ?? null)} pct={procPct}
            tone={fmt.procMemTone(s?.processMemMB ?? null, s?.ramTotal ?? null)} right={s?.ramTotal && s.processMemMB ? `占电脑内存 ${Math.round(procPct)}%` : ''} />}
        </div>
        <div className="row">
          <Button variant="primary" disabled={busy || up || s?.state === 'remote-down' || s?.state === 'remote-connecting'} onClick={() => run('启动', api.start)}><Icon name="play" />{s?.remote ? '启动服务器上的 ComfyUI' : '启动'}</Button>
          {s?.remote ? null : <>
            <Button disabled={busy} onClick={() => run('重启', api.restart)}><Icon name="refresh" />重启</Button>
            <Button disabled={busy || !(up || s?.state === 'timeout')} onClick={() => run('停止', api.stop)}><Icon name="x" />停止</Button>
            <Button disabled={busy} onClick={() => run('清缓存', api.clearCache, describeClear)}><Icon name="trash" />清缓存</Button>
          </>}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" disabled={s?.state !== 'running'} onClick={() => api.openUI()}>打开 ComfyUI 网页</Button>
          <Button variant="ghost" onClick={() => api.openLog()}>打开日志</Button>
          <Button variant="ghost" id="btn-copy-report" onClick={async () => { const r = await api.copyReport(); toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' }); }}><Icon name="copy" />复制报错</Button>
        </div>
      </div>
    </div>
  );
}
