import { useEffect, useRef, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, Field, Icon, TextInput, useToast } from '../../components';
import { UsageCard } from './UsageCard';

type Form = { workdir: string; port: string; logPath: string; reserveVram: string; lowvram: boolean; disablePinnedMemory: boolean; extraArgs: string };

const toForm = (c: Loose): Form => ({
  workdir: c.workdir, port: String(c.port), logPath: c.logPath, reserveVram: String(c.flags.reserveVram),
  lowvram: !!c.flags.lowvram, disablePinnedMemory: !!c.flags.disablePinnedMemory, extraArgs: c.flags.extraArgs || '',
});

// ComfyUI location, port and launch flags (saved as they are typed), and the DeepSeek / LLM settings.
export function GeneralTab({ onValidation }: { onValidation: (errors: string[]) => void }) {
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [llm, setLlm] = useState({ baseUrl: '', model: '', key: '', keySet: false, status: '' });
  const timer = useRef(0);

  useEffect(() => {
    api.getConfig().then((r) => {
      setForm(toForm(r.config));
      setErrors(r.validation.errors);
      setLlm({ baseUrl: r.config.llm.baseUrl || '', model: r.config.llm.model || '', key: '', keySet: !!r.config.llm.apiKeySet, status: '' });
    });
    return () => window.clearTimeout(timer.current);
  }, []);

  const save = async (f: Form) => {
    const r = await api.setConfig({
      workdir: f.workdir, port: f.port, logPath: f.logPath,
      flags: { reserveVram: f.reserveVram, lowvram: f.lowvram, disablePinnedMemory: f.disablePinnedMemory, extraArgs: f.extraArgs },
    });
    setErrors(r.validation.errors);
    onValidation(r.validation.errors);
  };
  const change = (patch: Partial<Form>, now = false) => {
    if (!form) return;
    const next = { ...form, ...patch };
    setForm(next);
    window.clearTimeout(timer.current);
    if (now) save(next); else timer.current = window.setTimeout(() => save(next), 400);
  };

  const saveLlm = async () => {
    const r = await api.setConfig({ llm: { baseUrl: llm.baseUrl, model: llm.model, optimizer: 'refine' }, llmApiKey: llm.key });
    setLlm((l) => ({ ...l, key: '', keySet: !!r.config.llm.apiKeySet }));
    return r;
  };

  if (!form) return <div className="set-inner" />;
  return (
    <div className="set-inner" id="tab-general">
      <h2>常规</h2>
      {errors.length ? <div className="errors" id="config-errors">{errors.map((e) => <div key={e}>{e}</div>)}</div> : null}
      <div className="card">
        <h3>ComfyUI</h3>
        <Field label="ComfyUI 便携版文件夹" hint="里面有 python_embeded 和 ComfyUI">
          <div style={{ display: 'flex', gap: 8 }}>
            <TextInput id="workdir" value={form.workdir} onChange={(e) => change({ workdir: e.target.value })} />
            <Button id="btn-pick-workdir" onClick={async () => { const dir = await api.pickWorkdir(); if (dir) change({ workdir: dir }, true); }}><Icon name="folder" />选择…</Button>
          </div>
        </Field>
        <div className="grid2">
          <Field label="端口"><TextInput id="port" value={form.port} onChange={(e) => change({ port: e.target.value })} /></Field>
          <Field label="保留显存（GB）" hint="留给系统和其他程序"><TextInput id="reserve-vram" value={form.reserveVram} onChange={(e) => change({ reserveVram: e.target.value })} /></Field>
        </div>
        <label className="check" title="--lowvram"><input type="checkbox" checked={form.lowvram} onChange={(e) => change({ lowvram: e.target.checked }, true)} />低显存模式</label>
        <label className="check" title="--disable-pinned-memory"><input type="checkbox" checked={form.disablePinnedMemory} onChange={(e) => change({ disablePinnedMemory: e.target.checked }, true)} />禁用锁页内存</label>
        <Field label="额外启动参数" hint="空格分隔"><TextInput id="extra-args" value={form.extraArgs} onChange={(e) => change({ extraArgs: e.target.value })} /></Field>
        <Field label="日志文件"><TextInput id="log-path" value={form.logPath} onChange={(e) => change({ logPath: e.target.value })} /></Field>
        <p className="muted">改动自动保存，下次启动或重启 ComfyUI 时生效。</p>
      </div>
      <div className="card">
        <h3>DeepSeek / 大模型<span className={`tag ${llm.keySet ? 'ok' : ''}`} id="llm-key-status">{llm.keySet ? '已配置密钥' : '未配置密钥'}</span></h3>
        <p className="muted">镜头页和素材页的「AI 改写」都用它：直接用大白话说想怎么改，比如「让男主稍微帅一点」。兼容 OpenAI 接口的服务都可以，比如 https://api.deepseek.com。</p>
        <div className="grid2">
          <Field label="接口地址"><TextInput id="llm-base-url" value={llm.baseUrl} placeholder="https://api.deepseek.com" onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} /></Field>
          <Field label="模型"><TextInput id="llm-model" value={llm.model} placeholder="deepseek-chat" onChange={(e) => setLlm({ ...llm, model: e.target.value })} /></Field>
        </div>
        <Field label="API 密钥" hint="只写入，用系统安全存储加密保存">
          <TextInput id="llm-api-key" type="password" value={llm.key} placeholder={llm.keySet ? '已保存，留空则不修改' : 'sk-…'} onChange={(e) => setLlm({ ...llm, key: e.target.value })} />
        </Field>
        <div className="row">
          <Button variant="primary" id="btn-llm-save" onClick={async () => { try { await saveLlm(); toast('已保存', { tone: 'ok' }); } catch (e) { toast(`保存失败:${(e as Error).message}`, { tone: 'bad' }); } }}>保存</Button>
          <Button id="btn-llm-test" onClick={async () => {
            try {
              await saveLlm();
              const r = await api.testLlm();
              setLlm((l) => ({ ...l, status: r.message || '' }));
              toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
            } catch (e) { toast(`测试失败:${(e as Error).message}`, { tone: 'bad' }); }
          }}>测试连接</Button>
          <Button variant="ghost" id="btn-llm-clear" onClick={async () => {
            const r = await api.setConfig({ llmClearApiKey: true });
            setLlm((l) => ({ ...l, key: '', keySet: !!r.config.llm.apiKeySet }));
            toast('API 密钥已清除', { tone: 'ok' });
          }}>清除密钥</Button>
          {llm.status ? <span className="muted" id="llm-status">{llm.status}</span> : null}
        </div>
      </div>
      <UsageCard />
    </div>
  );
}
