import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api';
import { Button, Field, Select, TextInput } from '../../components';

export function ProfileSelect({ value, disabled, change }: { value: string; disabled: boolean; change: (v: string) => void }) {
  return <Field label="安装工作流"><Select value={value} disabled={disabled} onChange={(e) => change(e.target.value)}>
    <option value="wenwu">Qwen 素材 + 文武双全（含接续）</option>
    <option value="hybrid">Qwen 素材 + Hybrid</option>
    <option value="image">仅 Qwen 素材出图</option>
  </Select></Field>;
}

export function CloudWelcome({ onRemote, onSkip }: { onRemote: () => void; onSkip: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [profile, setProfile] = useState('wenwu');
  const [modelsOnly, setModelsOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [watching, setWatching] = useState(false);
  const busy = submitting || !!message;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const info = await api.cloudInfo();
        if (!live) return;
        setKeySaved(info.keySaved);
        setMessage(info.message);
        setWatching(info.watching);
        if (info.busy || submitting) timer = setTimeout(refresh, 1000);
      } catch { if (live) setError('无法读取配置状态，请重新打开此页。'); }
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [submitting]);

  async function install(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setSubmitting(true);
    try {
      const result = api.cloudInstall({ login, password, apiKey: key, profile, modelsOnly });
      setPassword('');
      const response = await result;
      if (!response.ok) throw new Error(response.message);
      setKey('');
      onRemote();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }
  return <form className="set-inner" id="tab-welcome" onSubmit={install}>
    <h2>首次云端配置</h2>
    <p className="lead">用自己的 AutoDL 实例生成画面，用 DeepSeek 写剧本和改提示词。</p>
    <section className="card">
      <div className="welcome-heading"><h3>连接 AutoDL 显卡</h3>
        <Button size="sm" onClick={() => api.cloudOpen('instance')}>打开 AutoDL 租卡</Button></div>
      <p className="muted">在「我的实例」租用并启动 Linux GPU，复制该实例的 SSH 指令和密码。文武双全在 RTX 40 系列上约需 66 GiB 模型空间，另需约 14 GiB 安装空间。</p>
      <Field label="SSH 登录指令"><TextInput required disabled={busy} spellCheck={false} autoComplete="off" id="welcome-login"
        placeholder="ssh -p 端口 root@主机" value={login} onChange={(e) => setLogin(e.target.value)} /></Field>
      <Field label="实例 SSH 密码" hint="首次登录时填写，已登记本机密钥可留空"><TextInput disabled={busy} type="password"
        autoComplete="off" id="welcome-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    </section>
    <section className="card">
      <div className="welcome-heading"><h3>连接 DeepSeek</h3>
        <Button size="sm" onClick={() => api.cloudOpen('deepseek')}>注册并创建 API Key</Button></div>
      <Field label="DeepSeek API Key" hint={keySaved ? '已加密保存，可留空沿用' : '在 DeepSeek 开放平台创建，保存在本机系统加密存储中'}>
        <TextInput required={!keySaved} disabled={busy} type="password" autoComplete="off" id="welcome-key"
          placeholder={keySaved ? '使用已保存的密钥' : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} /></Field>
    </section>
    <section className="card">
      <ProfileSelect value={profile} disabled={busy} change={setProfile} />
      <label><input type="checkbox" id="welcome-models-only" checked={modelsOnly} disabled={busy} onChange={(e) => setModelsOnly(e.target.checked)} /> 实例以无卡模式开机：先只下载模型</label>
      <p className="muted">{modelsOnly
        ? '模型约 66 GiB，下载可能要几个小时。无卡模式按低价计费，适合先把模型下完。下完后关机，改用有卡模式开机，再到「设置 → 远程 GPU」点「配置并验收」。'
        : '点击后会在已租用的实例上安装环境和模型，生成验收素材，并向 DeepSeek 发送一次简短测试请求。GPU 运行和 API 调用分别按用量计费。'}</p>
      <div className="actions"><Button type="submit" variant="primary" disabled={busy} id="welcome-install">{busy ? '正在配置…' : modelsOnly ? '连接并开始下载模型' : '一键配置并自检'}</Button>
        <Button disabled={busy} onClick={async () => { if (await api.cloudSkip()) onSkip(); }}>稍后配置</Button>
        {!busy && watching && <Button onClick={onRemote}>查看实例配置进度</Button>}</div>
      {busy && <div role="status">{message || '正在提交配置…'}<progress aria-label="连接并启动云端配置" /></div>}
      {error && <div role="alert" className="errors">{error}</div>}
    </section>
  </form>;
}
