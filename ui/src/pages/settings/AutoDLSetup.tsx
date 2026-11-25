import { useEffect, useState } from 'react';
import { api, mediaUrl, type SetupState, type RemoteServer } from '../../api';
import { SetupProgress } from './SetupProgress';
import { ProfileSelect } from './Onboarding';
import { Button, Pill } from '../../components';

// One word for where the cloud installation stands, next to the card title.
function summary(state: SetupState | null, watching: boolean): { tone: 'ok' | 'warn' | 'bad' | 'muted'; text: string } {
  if (!state) return watching ? { tone: 'muted', text: '读取中' } : { tone: 'muted', text: '未配置' };
  if (state.historical) return { tone: 'muted', text: '离线' };
  switch (state.status) {
    case 'done': return { tone: 'ok', text: '可以使用' };
    case 'downloaded': return { tone: 'ok', text: '模型已就绪' };
    case 'attention': return { tone: 'warn', text: '需要处理' };
    case 'failed': return { tone: 'bad', text: '已中断' };
    case 'idle': return { tone: 'muted', text: '未配置' };
    default: return { tone: 'warn', text: state.phase === 'models' && state.download ? '下载模型中' : '配置中' };
  }
}

export function AutoDLSetup({ server, initial }: { server: RemoteServer; initial?: { profile: string; upscale: boolean } }) {
  const storageKey = 'autodl-setup:' + JSON.stringify([server.id, server.host, server.port, server.user, server.comfyPort]);
  const [watch, setWatch] = useState(() => !!initial || localStorage.getItem(storageKey) === '1');
  const [profile, setProfile] = useState(initial?.profile || 'wenwu');
  const [upscale, setUpscale] = useState(initial?.upscale || false);
  const [modelsOnly, setModelsOnly] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const [retesting, setRetesting] = useState(false);
  const [optionsToggled, setOptionsToggled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!watch || uploading || retesting) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.autodlStatus({ id: server.id });
        if (!live) return;
        setState(next);
        setError('');
        // The next run after a GPU-less download is the real acceptance.
        if (next.status === 'downloaded') setModelsOnly(false);
        if (['done', 'attention', 'failed', 'idle', 'downloaded'].includes(next.status)) return;
        timer = setTimeout(poll, next.phase === 'selfcheck' ? 2000 : 8000);
        return;
      } catch (e) {
        if (!live) return;
        setError(String(e instanceof Error ? e.message : e));
      }
      if (live) timer = setTimeout(poll, 8000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [server.id, watch, uploading, retesting, round]);

  async function retest() {
    setRetesting(true);
    setError('');
    try { setState(await api.autodlStatus({ id: server.id, retest: true })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRetesting(false); setRound((n) => n + 1); }
  }

  async function install() {
    setUploading(true);
    setError('');
    setOptionsToggled(false);
    localStorage.setItem(storageKey, '1');
    setWatch(true);
    try {
      const result = await api.autodlStart({ id: server.id, profile, upscale, modelsOnly });
      if (!result.ok) throw new Error(result.message);
      setState({ status: 'running', modelsOnly, message: '安装包已送达，正在读取云端进度…' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState(null);
      setWatch(false);
      setOptionsToggled(true);
    } finally {
      setUploading(false);
      setRound((n) => n + 1);
    }
  }
  const busy = retesting || uploading || (watch && !state && !error) || state?.status === 'running' || state?.status === 'ready';
  const started = !!state && state.status !== 'idle';
  // Options stay folded once an installation exists; the progress and its result come first.
  const optionsOpen = optionsToggled ?? !started;
  const badge = summary(state, watch);
  const startLabel = uploading ? '正在上传安装包…' : busy ? '配置进行中…' : modelsOnly ? '开始下载模型'
    : state?.status === 'failed' ? '重试配置并验收' : started && state?.status !== 'downloaded' ? '重新配置并验收' : '配置并验收';
  return <section className="card setup-card" id="autodl-setup" data-profile={profile}>
    <div className="welcome-heading">
      <h3>云端配置</h3>
      <Pill tone={badge.tone}>{badge.text}</Pill>
    </div>
    {!started && !uploading && !(watch && !error) && <p className="muted">在这台实例的数据盘上安装出片环境和模型，并实际生成验收素材。</p>}
    {watch && !state && !error && !uploading && <div role="status" className="muted">正在读取云端进度…<progress aria-label="正在读取云端进度" /></div>}
    {uploading && <div role="status" className="muted">正在上传安装包…<progress aria-label="正在上传安装包" /></div>}
    {state && !uploading && <SetupProgress state={state} offline={!!error} />}
    {error && <div role="status" className="errors">{error}</div>}
    {state?.preview && (state.preview.endsWith('.mp4')
      ? <video controls preload="metadata" className="setup-preview" src={mediaUrl('autodl', state.preview)} />
      : <img alt="AutoDL 验收图" className="setup-preview" src={mediaUrl('autodl', state.preview)} />)}
    {(state?.gpu || state?.space) && <p className="muted setup-facts">{[state.gpu, state.space].filter(Boolean).join(' · ')}</p>}
    <div className="row">
      {state?.report && !uploading && <Button size="sm" id="btn-setup-retest" disabled={busy} variant={state.status === 'attention' ? 'primary' : 'default'} onClick={retest}>{retesting ? '正在复查…' : '重新自检'}</Button>}
      {started && <Button size="sm" variant="ghost" id="btn-setup-options" aria-expanded={optionsOpen} onClick={() => setOptionsToggled(!optionsOpen)}>
        {optionsOpen ? '收起配置选项' : '重新配置…'}</Button>}
      {!busy && watch && <Button size="sm" variant="ghost" onClick={() => setRound((n) => n + 1)}>刷新进度</Button>}
    </div>
    <div className="setup-options" hidden={!optionsOpen}>
      <ProfileSelect value={profile} disabled={busy} change={setProfile} />
      <label className="check"><input type="checkbox" checked={upscale} disabled={busy} onChange={(e) => setUpscale(e.target.checked)} /> 同时安装 SeedVR2 超分</label>
      <label className="check"><input type="checkbox" id="autodl-models-only" checked={modelsOnly} disabled={busy} onChange={(e) => setModelsOnly(e.target.checked)} /> 无卡模式：只下载模型</label>
      <p className="muted">{modelsOnly
        ? '实例以「无卡模式」开机时使用：只下载并校验模型，按低价计费。下完换有卡模式开机，再取消勾选点「配置并验收」。'
        : '模型约 66 GiB。会实际生成一张图和约 4 秒短片，并向 DeepSeek 发送一次简短测试请求。'}</p>
      <div><Button id="btn-autodl-setup" variant="primary" disabled={busy} onClick={install}>{startLabel}</Button></div>
    </div>
  </section>;
}
