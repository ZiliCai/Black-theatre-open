import { useState } from 'react';
import { api, type SetupState } from '../../api';
import { Button, TextInput } from '../../components';

const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(2);
const size = (bytes: number) => bytes >= 2 ** 30 ? `${gib(bytes)} GiB` : `${Math.round(bytes / 2 ** 20)} MB`;
const speed = (rate: number) => rate >= 2 ** 20 ? `${(rate / 2 ** 20).toFixed(1)} MB/s` : `${Math.round(rate / 1024)} KB/s`;
const span = (seconds: number) => seconds < 60 ? `${Math.max(0, Math.round(seconds))} 秒` : seconds < 3600
  ? `${Math.floor(seconds / 60)} 分钟` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
// No byte moved and no log line for this long reads as stuck rather than slow.
const STALL = 180;
const clock = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function SetupProgress({ state, offline }: { state: SetupState; offline: boolean }) {
  const [reserve, setReserve] = useState('30');
  if (state.status === 'idle') return null;
  const steps = state.modelsOnly ? [['check', '检查实例'], ['models', '下载并校验模型']] : [
    ['check', '检查实例'], ['environment', '安装环境与模型'], ['nodes', '检查工作流'],
    ['image', '生成验收图'], ...(state.video === false ? [] : [['video', '生成验收视频']]), ['transfer', '取回并校验'], ['selfcheck', '使用前自检'],
  ];
  const completed = state.status === 'done' || state.status === 'downloaded';
  const stage = steps.findIndex(([id]) => id === (state.phase === 'models' && !state.modelsOnly ? 'environment' : state.phase));
  const d = state.download;
  const percent = d && d.total > 0 ? Math.floor(100 * d.saved / d.total) : null;
  const now = Date.now();
  const fresh = d && now - d.updated * 1000 < 45000 && d.updated * 1000 <= now + 5000;
  const downloading = !!d && state.phase === 'models' && state.status === 'running';
  const seconds = d && fresh && !offline && downloading && d.rate > 0 && d.saved < d.total ? (d.total - d.saved) / d.rate : null;
  const estimate = seconds === null ? null : now + seconds * 1000;
  const minutes = Number(reserve);
  const problem = state.status === 'failed' || state.status === 'attention';
  const running = state.status === 'running' && !offline;
  // Seconds on the instance's clock where the installer reports them, so a skewed local clock does not lie.
  const act = running ? state.activity : undefined;
  const cloudNow = act ? act.clock : now / 1000;
  const elapsed = running && state.since ? cloudNow - state.since : null;
  const idle = act ? act.clock - act.updated : 0;
  const title = state.historical ? '上次自检结果' : state.status === 'downloaded' ? '模型已就绪' : completed ? '自检通过'
    : state.status === 'attention' ? '自检需要处理' : stage < 0 ? '配置进度' : steps[stage][1];
  // Only states that ask the user to act get a sentence of their own.
  const next = state.status === 'downloaded' ? '到 AutoDL 控制台关机，改用有卡模式开机，再点「重新配置…」取消勾选无卡模式并开始验收。已下载的模型直接复用。'
    : completed ? '选择或新建剧本项目后即可出图' + (state.video ? '和出片' : '') + '，使用时保持实例开机。'
    : state.status === 'attention' ? '修复提示中的问题后，点「重新自检」复查。'
    : state.status === 'failed' ? '可以在「重新配置…」里重试，已下载的文件会复用。'
    : offline ? '正在重新连接，恢复后会继续显示进度。' : '';
  return <div className="setup-progress">
    <div className="welcome-heading"><strong>{title}</strong>
      {(completed || stage >= 0) && <span className="muted">{completed ? '已完成全部阶段' : '阶段 ' + (stage + 1) + ' / ' + steps.length}</span>}</div>
    {!completed && <progress aria-label="配置阶段完成进度" max={steps.length} value={stage < 0 ? undefined : stage} />}
    {percent !== null && d && (downloading || state.status === 'downloaded') && <div className="setup-download">
      <div className="welcome-heading"><span>模型 {percent}%</span>
        <span className="muted">{gib(d.saved)} / {gib(d.total)} GiB{seconds !== null && <> · {(d.rate / 2 ** 20).toFixed(1)} MiB/s · 约剩 {Math.ceil(seconds / 60)} 分钟</>}</span></div>
      <progress aria-label="模型下载进度" max={d.total} value={d.saved} />
    </div>}
    <div className={problem ? 'errors' : 'setup-message muted'} role="status">{state.message}</div>
    {act && <div className="setup-activity" id="setup-activity">
      <span>{act.label}{act.detail ? '：' + act.detail : ''}</span>
      <span className="muted">本阶段已下载 {size(act.bytes)}{act.rate > 0 ? ' · ' + speed(act.rate) : ''} · {idle < 10 ? '刚刚有进展' : span(idle) + '前有进展'}</span>
    </div>}
    {elapsed !== null && elapsed >= 60 && <p className="muted setup-elapsed">本阶段已进行 {span(elapsed)}。实例开机期间一直在计费。</p>}
    {act && idle >= STALL && <div className="errors" role="alert">已经 {span(idle)}没有任何进展，可能是网络卡住了。{'可以再等几分钟；如果超过 15 分钟仍没有变化，到 AutoDL 控制台关机止损，下次开机后点「重试配置并验收」，已下载的内容会复用。'}</div>}
    {state.report && <section aria-label="配置自检报告" className="check-report">
      <div className="welcome-heading"><strong>配置自检报告</strong><span className="muted">{clock(state.report.at)}</span></div>
      <ul>{state.report.checks.map((item) => <li key={item.id}>
        <span className={'check-result ' + item.status}>{item.status === 'pass' ? '通过' : item.status === 'fail' ? '需处理' : '跳过'}</span>
        <div><strong>{item.label}</strong><p className="muted">{item.detail}</p></div>
      </li>)}</ul>
    </section>}
    {estimate !== null && <div className="shutdown-plan">
      <span>预计 {clock(estimate)} 下载完成</span>
      {!state.modelsOnly && <>
        <span className="muted">· 再留</span>
        <TextInput small type="number" min="0" max="1440" step="1" aria-label="为剩余安装和验收预留的分钟数"
          value={reserve} onChange={(e) => setReserve(e.target.value)} />
        <span className="muted">分钟安装和验收{reserve && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? `，可在 ${clock(estimate + minutes * 60000)} 关机` : ''}</span>
      </>}
    </div>}
    {next && <p className="muted">{next}</p>}
    <div><Button size="sm" onClick={() => api.cloudOpen('instance')}>打开 AutoDL 控制台{estimate !== null ? '安排关机' : ''}</Button></div>
  </div>;
}
