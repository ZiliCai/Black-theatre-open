import { useEffect, useState } from 'react';
import { api, type RemotePayload, type RemoteServer, type ServerTest } from '../../api';
import { Button, Field, Icon, TextArea, TextInput, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { useApp } from '../../shell/context';

const BLANK: RemoteServer = {
  id: '', name: '', host: '', port: 22, user: '', keyFile: '', comfyPort: 8188, startCommand: '', modelSwaps: {},
};

// "本机文件名 => 服务器文件名", one per line, both ways
const swapsToText = (swaps: Record<string, string>) => Object.entries(swaps).map(([a, b]) => `${a} => ${b}`).join('\n');
const textToSwaps = (text: string) => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [a, b] = line.split('=>').map((s) => (s || '').trim());
    if (a && b) out[a] = b;
  }
  return out;
};

const TUNNEL: Record<string, string> = { off: '', connecting: '正在连接…', open: '已连上', down: '连不上' };

// Remote GPU servers: render on a school or rented GPU over SSH instead of this computer.
export function RemoteTab() {
  const { status } = useApp();
  const toast = useToast();
  const { confirm } = useDialog();
  const [data, setData] = useState<RemotePayload | null>(null);
  const [editing, setEditing] = useState<(RemoteServer & { swapsText: string }) | null>(null);
  const [test, setTest] = useState<ServerTest | null>(null);
  const [testing, setTesting] = useState(false);

  const load = async () => setData(await api.remoteGet());
  useEffect(() => { load(); }, [status?.tunnel?.state]);

  const use = async (id: string) => {
    const r = await api.remoteUse({ id });
    if (!r.ok) { toast(r.message, { tone: 'bad' }); return; }
    setData(r);
    toast(id === 'local' ? '改回本机出片' : '改到服务器出片，正在连接…', { tone: 'ok' });
  };
  const edit = (s: RemoteServer) => { setEditing({ ...s, swapsText: swapsToText(s.modelSwaps) }); setTest(null); };
  const formServer = (): RemoteServer => {
    const { swapsText, ...rest } = editing!;
    return { ...rest, port: Number(rest.port), comfyPort: Number(rest.comfyPort), modelSwaps: textToSwaps(swapsText) };
  };
  const save = async () => {
    const r = await api.remoteSave(formServer());
    if (!r.ok) { toast(r.message, { tone: 'bad' }); return; }
    setData(r);
    setEditing(null);
    toast('已保存', { tone: 'ok' });
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try { setTest(await api.remoteTest(formServer())); } finally { setTesting(false); }
  };

  if (!data) return <div className="set-inner" />;
  const t = data.tunnel;
  return (
    <div className="set-inner" id="tab-remote">
      <h2>远程 GPU</h2>
      <p className="lead">
        把出片放到租的云 GPU 服务器（比如 AutoDL）上跑：剧本、素材和成片都还在这台电脑的项目里，出片前自动把参考图传上去，出完把视频和接续文件取回来。
        连接用 SSH 钥匙，软件不保存也不输入密码；服务器上的 ComfyUI 不对外开端口。
      </p>

      <article className={`proj-card ${data.target === 'local' ? 'active' : ''}`}>
        <h3>本机{data.target === 'local' ? <span className="tag acc">正在使用</span> : null}</h3>
        <div className="muted">用这台电脑上的 ComfyUI 出片。</div>
        <div className="actions">
          <Button size="sm" id="btn-remote-local" variant={data.target === 'local' ? 'default' : 'primary'} disabled={data.target === 'local'} onClick={() => use('local')}>
            {data.target === 'local' ? '正在使用' : '改回本机出片'}
          </Button>
        </div>
      </article>

      {data.servers.map((s) => {
        const active = data.target === s.id;
        return (
          <article key={s.id} className={`proj-card ${active ? 'active' : ''}`} data-server={s.id}>
            <h3>
              {s.name}
              {active ? <span className="tag acc">正在使用</span> : null}
              {active && TUNNEL[t.state] ? <span className={`tag ${t.state === 'open' ? 'ok' : t.state === 'down' ? 'bad' : ''}`}>{TUNNEL[t.state]}</span> : null}
            </h3>
            <div className="path">{s.user}@{s.host}:{s.port} · ComfyUI 端口 {s.comfyPort}</div>
            {active && t.state === 'down' && t.message ? <div className="muted" style={{ color: 'var(--bad)' }}>{t.message}</div> : null}
            {active && status?.remote && status.state === 'running' && status.deviceName ? <div className="muted">{status.deviceName}</div> : null}
            <div className="actions">
              <Button size="sm" variant={active ? 'default' : 'primary'} disabled={active} onClick={() => use(s.id)}>{active ? '正在使用' : '在这台上出片'}</Button>
              {active && t.state === 'down' ? <Button size="sm" onClick={async () => setData(await api.remoteRetry())}><Icon name="refresh" />重新连接</Button> : null}
              {active && status?.state === 'remote-stopped' ? <Button size="sm" onClick={async () => {
                toast('正在启动服务器上的 ComfyUI…');
                const r = await api.start();
                toast(r.message || '', { tone: r.ok ? 'ok' : 'bad' });
              }}><Icon name="play" />启动服务器上的 ComfyUI</Button> : null}
              <Button size="sm" onClick={() => edit(s)}>修改</Button>
              <Button size="sm" variant="ghost" onClick={async () => {
                if (!(await confirm({ title: '删除服务器', message: `删除「${s.name}」这套设置？`, detail: '只删软件里的设置，服务器上的文件不动。', okLabel: '删除' }))) return;
                const r = await api.remoteDelete({ id: s.id });
                if (!r.ok) { toast(r.message, { tone: 'bad' }); return; }
                setData(r);
              }}>删除</Button>
            </div>
          </article>
        );
      })}

      <div className="row" style={{ display: 'flex', gap: 8 }}>
        <Button id="btn-remote-add" onClick={() => edit(BLANK)}><Icon name="plus" />添加服务器</Button>
      </div>

      {editing ? (
        <div className="card" id="remote-form">
          <h3>{editing.id ? `修改「${editing.name}」` : '添加服务器'}</h3>
          <div className="grid2">
            <Field label="名字"><TextInput id="srv-name" value={editing.name} placeholder="比如：AutoDL 4090" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="登录用户名"><TextInput id="srv-user" value={editing.user} onChange={(e) => setEditing({ ...editing, user: e.target.value })} /></Field>
            <Field label="服务器地址"><TextInput id="srv-host" value={editing.host} placeholder="IP 或域名" onChange={(e) => setEditing({ ...editing, host: e.target.value })} /></Field>
            <Field label="SSH 端口"><TextInput id="srv-port" type="number" value={editing.port} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })} /></Field>
            <Field label="钥匙文件" hint="留空就用 ssh 默认的钥匙。钥匙要先登记到服务器上"><TextInput id="srv-key" value={editing.keyFile} placeholder="C:\Users\你\.ssh\id_ed25519" onChange={(e) => setEditing({ ...editing, keyFile: e.target.value })} /></Field>
            <Field label="服务器上 ComfyUI 的端口"><TextInput id="srv-comfy-port" type="number" value={editing.comfyPort} onChange={(e) => setEditing({ ...editing, comfyPort: Number(e.target.value) })} /></Field>
          </div>
          <Field label="启动 ComfyUI 的命令" hint="在服务器上运行，要能在 SSH 断开后继续跑（比如放进 tmux）。留空就只能到服务器上手动启动">
            <TextArea id="srv-start" rows={2} value={editing.startCommand} onChange={(e) => setEditing({ ...editing, startCommand: e.target.value })} />
          </Field>
          <Field label="模型替换" hint="服务器上没有本机同款、用别的代替时写在这里，一行一个：本机文件名 => 服务器文件名">
            <TextArea id="srv-swaps" rows={3} value={editing.swapsText} onChange={(e) => setEditing({ ...editing, swapsText: e.target.value })} />
          </Field>
          {test ? (
            <div className={test.ok ? 'note-box' : 'errors'} id="srv-test-result">
              <div>
                {test.message ? <div>{test.message}</div> : null}
                {test.steps.map((s) => <div key={s.label}>{s.ok ? '✓' : '✗'} {s.label}：{s.detail}</div>)}
              </div>
            </div>
          ) : null}
          <div className="row">
            <Button variant="primary" id="btn-srv-save" onClick={save}>保存</Button>
            <Button id="btn-srv-test" disabled={testing} onClick={runTest}>{testing ? '正在测试…' : '测试连接'}</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
