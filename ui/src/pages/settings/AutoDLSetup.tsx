import { useEffect, useState } from 'react';
import { api, mediaUrl, type SetupState, type RemoteServer } from '../../api';
import { SetupProgress } from './SetupProgress';
import { ProfileSelect } from './CloudWelcome';
import { Button } from '../../components';

export function AutoDLSetup({ server, initial }: { server: RemoteServer; initial?: { profile: string; upscale: boolean } }) {
  const storageKey = 'autodl-setup:' + JSON.stringify([server.id, server.host, server.port, server.user, server.comfyPort]);
  const [watch, setWatch] = useState(() => !!initial || localStorage.getItem(storageKey) === '1');
  const [profile, setProfile] = useState(initial?.profile || 'wenwu');
  const [upscale, setUpscale] = useState(initial?.upscale || false);
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const [retesting, setRetesting] = useState(false);
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
        if (['done', 'attention', 'failed', 'idle'].includes(next.status)) return;
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
    localStorage.setItem(storageKey, '1');
    setWatch(true);
    try {
      const result = await api.autodlStart({ id: server.id, profile, upscale });
      if (!result.ok) throw new Error(result.message);
      setState({ status: 'running', message: '安装包已送达，正在读取云端进度…' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState(null);
      setWatch(false);
    } finally {
      setUploading(false);
      setRound((n) => n + 1);
    }
  }
  const busy = retesting || uploading || (watch && !state && !error) || state?.status === 'running' || state?.status === 'ready';
  return <section className="card">
    <div className="welcome-heading"><h3>AutoDL 一键配置</h3><span className="muted">{server.name}</span></div>
    {state && !uploading && <SetupProgress state={state} offline={!!error} />}
    {watch && !state && !error && !uploading && <div role="status">正在读取云端进度…<progress aria-label="正在读取云端进度" /></div>}
    {state?.report && !uploading && <div className="actions"><Button id="btn-setup-retest" disabled={busy} variant={state.status === 'attention' ? 'primary' : 'default'} onClick={retest}>{retesting ? '正在复查…' : '重新自检'}</Button></div>}
    <p className="muted">环境和模型安装到实例的数据盘。云端会实际生成验收素材，选择视频工作流时还会取回约 4 秒的短片。已配置 DeepSeek 时，自检会发送一次简短测试请求，按 API 用量计费。实例用完请到 AutoDL 关机。</p>
    <ProfileSelect value={profile} disabled={busy} change={setProfile} />
    <label><input type="checkbox" checked={upscale} disabled={busy} onChange={(e) => setUpscale(e.target.checked)} /> 同时安装 SeedVR2 超分</label>
    <div className="actions">
      <Button id="btn-autodl-setup" variant="primary" disabled={busy} onClick={install}>
        {uploading ? '正在上传安装包…' : busy ? '配置进行中…' : state?.status === 'failed' ? '重试配置并验收' : state?.report ? '重新配置并验收' : '配置并验收'}
      </Button>
      {!busy && <Button size="sm" onClick={() => { setWatch(true); setRound((n) => n + 1); }}>查看云端进度</Button>}
    </div>
    {uploading && <progress aria-label="正在上传安装包" />}
    {state?.gpu && <p className="muted">{state.gpu}</p>}
    {state?.space && <p className="muted">{state.space}</p>}
    {error && <div role="status" className="errors">{error}</div>}
    {state?.preview && (state.preview.endsWith('.mp4')
      ? <video controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 320 }} src={mediaUrl('autodl', state.preview)} />
      : <img alt="AutoDL 验收图" style={{ maxWidth: '100%', maxHeight: 320 }} src={mediaUrl('autodl', state.preview)} />)}
  </section>;
}
