import { useState } from 'react';
import { api, type SetupState } from '../../api';
import { Button, Field, TextInput } from '../../components';

const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(2);
const clock = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function SetupProgress({ state, offline }: { state: SetupState; offline: boolean }) {
  const [reserve, setReserve] = useState('30');
  if (state.status === 'idle') return null;
  const steps = [
    ['check', '检查实例'], ['environment', '安装环境与模型'], ['nodes', '检查工作流'],
    ['image', '生成验收图'], ...(state.video === false ? [] : [['video', '生成验收视频']]), ['transfer', '取回并校验'],
  ];
  const completed = state.status === 'done';
  const stage = steps.findIndex(([id]) => id === (state.phase === 'models' ? 'environment' : state.phase));
  const d = state.download;
  const percent = d && d.total > 0 ? Math.floor(100 * d.saved / d.total) : null;
  const now = Date.now();
  const fresh = d && now - d.updated * 1000 < 45000 && d.updated * 1000 <= now + 5000;
  const seconds = d && fresh && !offline && state.phase === 'models' && state.status === 'running' && d.rate > 0 && d.saved < d.total
    ? (d.total - d.saved) / d.rate : null;
  const estimate = seconds === null ? null : now + seconds * 1000;
  const minutes = Number(reserve);
  return <div className="setup-progress">
    <div className="welcome-heading"><strong>{completed ? '配置与验收完成' : stage < 0 ? '配置进度' : steps[stage][1]}</strong>
      {(completed || stage >= 0) && <span className="muted">{completed ? '已完成全部阶段' : '阶段 ' + (stage + 1) + ' / ' + steps.length}</span>}</div>
    <progress aria-label="配置阶段完成进度" max={steps.length} value={completed ? steps.length : stage < 0 ? undefined : stage} />
    {percent !== null && d && <div>
      <div className="welcome-heading"><span>模型数据（含已缓存）</span><strong>{percent}%</strong></div>
      <progress aria-label="模型下载进度" max={d.total} value={d.saved} />
      <p className="muted">{gib(d.saved)} / {gib(d.total)} GiB
        {seconds !== null && <> · {(d.rate / 2 ** 20).toFixed(1)} MiB/s · 约剩 {Math.ceil(seconds / 60)} 分钟</>}</p>
    </div>}
    <div className={state.status === 'failed' ? 'errors' : 'note-box'} role="status">{state.message}</div>
    {estimate !== null && <div className="shutdown-plan">
      <p>预计下载完成于 {clock(estimate)}（本机时间）</p>
      <Field label="为剩余安装和验收预留（分钟）"><TextInput type="number" min="0" max="1440" step="1"
        value={reserve} onChange={(e) => setReserve(e.target.value)} /></Field>
      {reserve && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 && <p>关机预设参考时间：{clock(estimate + minutes * 60000)}（含预留）。请在控制台确认。</p>}
    </div>}
    <p className="muted">{completed ? '验收素材已保存到本机。如果这台实例没有其他任务，现在可以关机。' :
      offline ? '正在重新连接。恢复进度更新后会重新估算下载时间。' :
      state.status === 'failed' ? '云端配置已中断，可以重试或到控制台关机。' :
      '下载估时随网速变化。环境安装和实际生成另需时间，设置定时关机时请为验收留出余量。'}</p>
    <div><Button size="sm" onClick={() => api.cloudOpen('instance')}>到 AutoDL 控制台安排关机</Button></div>
  </div>;
}
