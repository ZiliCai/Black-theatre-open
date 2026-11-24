import { useEffect, useState } from 'react';
import { api, mediaUrl, type SetupState, type RemoteServer } from '../../api';
import { Button, Field, Select } from '../../components';

export function AutoDLSetup({ server }: { server: RemoteServer }) {
  const storageKey = 'autodl-setup:' + JSON.stringify([server.id, server.host, server.port, server.user, server.comfyPort]);
  const [watch, setWatch] = useState(() => localStorage.getItem(storageKey) === '1');
  const [profile, setProfile] = useState('wenwu');
  const [upscale, setUpscale] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!watch || uploading) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.autodlStatus({ id: server.id });
        if (!live) return;
        setState(next);
        setError('');
        if (['done', 'failed', 'idle'].includes(next.status)) return;
      } catch (e) {
        if (!live) return;
        setError(String(e instanceof Error ? e.message : e));
      }
      if (live) timer = setTimeout(poll, 8000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [server.id, watch, uploading, round]);

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
  const busy = uploading || state?.status === 'running' || state?.status === 'ready';
  return <section className="card">
    <h3>AutoDL 一键配置</h3>
    <p className="muted">环境和模型安装到实例的数据盘。云端会实际生成验收素材，选择视频工作流时还会取回约 4 秒的短片。实例按平台规则计费，用完请到 AutoDL 关机。</p>
    <Field label="安装工作流"><Select value={profile} disabled={busy} onChange={(e) => setProfile(e.target.value)}>
      <option value="wenwu">Qwen 素材 + 文武双全（含接续）</option>
      <option value="hybrid">Qwen 素材 + Hybrid</option>
      <option value="image">仅 Qwen 素材出图</option>
    </Select></Field>
    <label><input type="checkbox" checked={upscale} disabled={busy} onChange={(e) => setUpscale(e.target.checked)} /> 同时安装 SeedVR2 超分</label>
    <div className="actions">
      <Button id="btn-autodl-setup" variant="primary" disabled={busy} onClick={install}>
        {uploading ? '正在上传安装包…' : busy ? '配置进行中…' : state?.status === 'failed' ? '重试配置并验收' : '配置并验收'}
      </Button>
      {!busy && <Button size="sm" onClick={() => { setWatch(true); setRound((n) => n + 1); }}>查看云端进度</Button>}
    </div>
    {state?.message && <div role="status" className={state.status === 'failed' ? 'errors' : 'note-box'}>{state.message}</div>}
    {state?.gpu && <p className="muted">{state.gpu}</p>}
    {state?.space && <p className="muted">{state.space}</p>}
    {error && <div role="status" className="errors">{error}</div>}
    {state?.preview && (state.preview.endsWith('.mp4')
      ? <video controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 320 }} src={mediaUrl('autodl', state.preview)} />
      : <img alt="AutoDL 验收图" style={{ maxWidth: '100%', maxHeight: 320 }} src={mediaUrl('autodl', state.preview)} />)}
  </section>;
}
