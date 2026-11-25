import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Button, Field, Icon, Select, TextInput } from '../../components';
import './onboarding.css';

export function ProfileSelect({ value, disabled, change }: { value: string; disabled: boolean; change: (v: string) => void }) {
  return <Field label="安装工作流"><Select value={value} disabled={disabled} onChange={(e) => change(e.target.value)}>
    <option value="wenwu">Qwen 素材 + 文武双全（含接续）</option>
    <option value="hybrid">Qwen 素材 + Hybrid</option>
    <option value="image">仅 Qwen 素材出图</option>
  </Select></Field>;
}

type Step = 'choose' | 'instance' | 'deepseek' | 'start';
const STEPS: { id: Step; label: string }[] = [
  { id: 'choose', label: '出片方式' }, { id: 'instance', label: 'AutoDL 实例' },
  { id: 'deepseek', label: 'DeepSeek' }, { id: 'start', label: '开始配置' },
];
// Mirrors cloud-onboarding.parseLogin closely enough to catch a wrong paste before the network round trip.
const LOGIN = /^ssh\s+(?:-p\s+\d{1,5}\s+root@\S+|root@\S+\s+-p\s+\d{1,5})$/;

export type OnboardingExit = 'remote' | 'general' | null;

/**
 * First-run setup after installation (full screen), and the same steps later from 远程 GPU
 * ("add", which starts at the instance step and can be closed).
 */
export function Onboarding({ mode, onClose }: { mode: 'first-run' | 'add'; onClose: (to: OnboardingExit) => void }) {
  const steps = mode === 'first-run' ? STEPS : STEPS.slice(1);
  const [step, setStep] = useState<Step>(steps[0].id);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [modelsOnly, setModelsOnly] = useState(false);
  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [profile, setProfile] = useState('wenwu');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
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
        if (info.busy || submitting) timer = setTimeout(refresh, 1000);
      } catch { if (live) setError('无法读取配置状态，请重新打开此页。'); }
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [submitting]);

  const index = steps.findIndex((s) => s.id === step);
  const go = (to: Step) => { setError(''); setStep(to); };
  const back = index > 0 ? () => go(steps[index - 1].id) : null;
  const loginOk = LOGIN.test(login.trim());
  const where = /root@(\S+)/.exec(login)?.[1] ?? '';
  const sshPort = /-p\s+(\d+)/.exec(login)?.[1] ?? '';

  async function skip(to: OnboardingExit) {
    if (await api.cloudSkip()) onClose(to);
  }

  async function install() {
    if (busy) return;
    setError('');
    setSubmitting(true);
    try {
      const result = api.cloudInstall({ login: login.trim(), password, apiKey: key, profile, modelsOnly });
      setPassword('');
      const response = await result;
      if (!response.ok) throw new Error(response.message);
      setKey('');
      onClose('remote');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  const body = step === 'choose' ? <>
    <h1>欢迎使用黑箱剧场</h1>
    <p className="lead">先选择在哪里生成画面。以后可以在「设置 → 远程 GPU」随时更改。</p>
    <div className="ob-choices">
      <button type="button" className="ob-choice" id="onboard-cloud" onClick={() => go('instance')}>
        <strong>租用云 GPU（AutoDL）<span className="tag acc">推荐</span></strong>
        <span>不需要高端显卡。软件在你租的实例上自动安装环境和模型，生成后取回成片。</span>
      </button>
      <button type="button" className="ob-choice" id="onboard-local" onClick={() => skip('general')}>
        <strong>用这台电脑的显卡</strong>
        <span>需要 NVIDIA 显卡和 ComfyUI 便携版。下一步到「设置 → 常规」选择便携版文件夹。</span>
      </button>
    </div>
  </> : step === 'instance' ? <>
    <h1>连接 AutoDL 实例</h1>
    <p className="lead">在 AutoDL「我的实例」里开机，复制实例的 SSH 登录指令和密码。</p>
    <Button size="sm" className="ob-link" onClick={() => api.cloudOpen('instance')}><Icon name="link" />打开 AutoDL 控制台</Button>
    <Field label="SSH 登录指令"><TextInput autoFocus disabled={busy} spellCheck={false} autoComplete="off" id="welcome-login"
      placeholder="ssh -p 端口 root@主机" value={login} onChange={(e) => setLogin(e.target.value)} /></Field>
    {login.trim() && !loginOk && <p className="ob-warn">请粘贴控制台里完整的一行，例如 ssh -p 12345 root@connect.xxx.seetacloud.com</p>}
    <Field label="实例密码" hint="只用于第一次登记本机密钥，不会保存"><TextInput disabled={busy} type="password"
      autoComplete="off" id="welcome-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
    <label className="check ob-check"><input type="checkbox" id="welcome-models-only" checked={modelsOnly} disabled={busy}
      onChange={(e) => setModelsOnly(e.target.checked)} /> 实例以无卡模式开机：先只下载模型</label>
    <p className="ob-hint">模型约 66 GiB，下载要一两个小时。用「无卡模式开机」下载按低价计费，下完再换有卡模式验收。</p>
  </> : step === 'deepseek' ? <>
    <h1>连接 DeepSeek</h1>
    <p className="lead">剧本讨论、改写提示词和拆分镜使用你自己的 DeepSeek API Key，按用量计费。</p>
    <Button size="sm" className="ob-link" onClick={() => api.cloudOpen('deepseek')}><Icon name="link" />注册并创建 API Key</Button>
    <Field label="DeepSeek API Key" hint={keySaved ? '已加密保存，可留空沿用' : '保存在本机系统加密存储中'}>
      <TextInput autoFocus disabled={busy} type="password" autoComplete="off" id="welcome-key"
        placeholder={keySaved ? '使用已保存的密钥' : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} /></Field>
  </> : <>
    <h1>开始配置</h1>
    <p className="lead">{modelsOnly ? '先在无卡模式的实例上下载并校验模型。'
      : `在实例上安装环境和模型，生成${profile === 'image' ? '一张图' : '一张图和一段短片'}验收，再做一次 DeepSeek 自检。`}</p>
    <div id="tab-welcome"><ProfileSelect value={profile} disabled={busy} change={setProfile} /></div>
    <dl className="ob-summary">
      <dt>实例</dt><dd>{where} · SSH 端口 {sshPort}</dd>
      <dt>方式</dt><dd>{modelsOnly ? '无卡模式：只下载模型' : '下载模型、安装环境并验收'}</dd>
      <dt>DeepSeek</dt><dd>{key ? '使用刚填写的密钥' : '使用已保存的密钥'}</dd>
    </dl>
    <p className="ob-hint">GPU 租用和 API 调用分别由 AutoDL 和 DeepSeek 计费。配置在云端独立运行，关掉软件也会继续。</p>
    {busy && <div role="status" className="ob-busy">{message || '正在提交配置…'}<progress aria-label="连接并启动云端配置" /></div>}
  </>;

  const next = step === 'instance' ? <Button variant="primary" id="onboard-next" disabled={!loginOk || busy} onClick={() => go('deepseek')}>下一步</Button>
    : step === 'deepseek' ? <Button variant="primary" id="onboard-next" disabled={(!key.trim() && !keySaved) || busy} onClick={() => go('start')}>下一步</Button>
    : step === 'start' ? <Button variant="primary" id="welcome-install" disabled={busy} onClick={install}>
      {busy ? '正在配置…' : modelsOnly ? '开始下载模型' : '开始配置并自检'}</Button>
    : null;

  return <div className={mode === 'first-run' ? 'onboard full' : 'onboard overlay'} id="onboarding">
    <div className="ob-panel" role={mode === 'add' ? 'dialog' : undefined} aria-modal={mode === 'add' ? true : undefined}>
      <header className="ob-top">
        <ol className="ob-steps">{steps.map((s, i) => <li key={s.id} className={i === index ? 'on' : i < index ? 'done' : ''}>
          <span className="n">{i < index ? <Icon name="check" size={12} /> : i + 1}</span>{s.label}</li>)}</ol>
        {mode === 'add' && <Button variant="ghost" size="sm" aria-label="关闭" disabled={busy} onClick={() => onClose(null)}><Icon name="x" /></Button>}
      </header>
      <div className="ob-body">
        {body}
        {error && <div role="alert" className="errors">{error}</div>}
      </div>
      <footer className="ob-foot">
        {back ? <Button disabled={busy} onClick={back}>上一步</Button> : <span />}
        <div className="ob-foot-right">
          {mode === 'first-run' && <Button variant="ghost" id="onboard-later" disabled={busy} onClick={() => skip(null)}>稍后再说</Button>}
          {next}
        </div>
      </footer>
    </div>
  </div>;
}
