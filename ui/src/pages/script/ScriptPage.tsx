import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Loose } from '../../api';
import { Button, EmptyState, Field, Icon, Modal, Segmented, Select, TextArea, TextInput, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { LauncherFormat as fmt } from '../../legacy';
import { useApp } from '../../shell/context';
import { MarkdownView } from './MarkdownView';
import { ScriptChat } from './ScriptChat';
import './script.css';

type Doc = { relPath: string; name: string; category: string; mtimeMs: number; size: number };
type Open = { relPath: string; version: string; savedContent: string; readOnly: boolean; readOnlyReason?: string; mtimeMs?: number; size?: number };
const titleOf = (name: string) => name.replace(/\.(md|txt)$/i, '');
const nameOf = (rel: string) => rel.split('/').pop() || rel;
// same rule as the main process, only to pre-select the category while a name is typed
const guess = (name: string) => (/分镜/.test(name) ? '分镜头' : /细纲/.test(name) ? '细纲' : /大纲/.test(name) ? '大纲' : /设定/.test(name) ? '故事设定' : '其他');

// The project's story documents: grouped list, search, preview / edit, save with history and conflict handling.
export function ScriptPage() {
  const { projectVersion, go, setLeaveGuard } = useApp();
  const toast = useToast();
  const { ask, confirm, choose } = useDialog();
  const [list, setList] = useState<(Loose & { docs: Doc[]; categories: string[] }) | null>(null);
  const [empty, setEmpty] = useState<'' | 'noProject' | 'noFolder'>('');
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Loose[] | null>(null);
  const [notice, setNotice] = useState<'' | 'changed' | 'gone'>('');
  const [creating, setCreating] = useState<{ name: string; category: string; touched: boolean; error: string } | null>(null);
  const [history, setHistory] = useState<{ items: Loose[]; chosen: Loose | null; active: string } | null>(null);
  const dirty = !!open && text !== open.savedContent;
  const [chatOpen, setChatOpen] = useState(() => {
    try { return localStorage.getItem('blackbox.script.chat') === '1'; } catch { return false; }
  });
  const showChat = (on: boolean) => {
    setChatOpen(on);
    try { localStorage.setItem('blackbox.script.chat', on ? '1' : '0'); } catch { /* remembered for this run only */ }
  };
  const state = useRef({ open, text, dirty });
  state.current = { open, text, dirty };

  const loadList = useCallback(async () => {
    const r = await api.listDocs();
    if (r.noProject) { setEmpty('noProject'); setList(null); setOpen(null); return null; }
    setList(r as Loose & { docs: Doc[]; categories: string[] });
    setEmpty(r.exists ? '' : 'noFolder');
    return r;
  }, []);

  const openDoc = useCallback(async (relPath: string) => {
    const r = await api.readDoc({ relPath });
    if (!r.ok) { toast(r.message, { tone: 'bad' }); return; }
    setOpen({ relPath, version: r.version, savedContent: r.content, readOnly: !!r.readOnly, readOnlyReason: r.readOnlyReason, mtimeMs: r.mtimeMs, size: r.size });
    setText(r.content);
    setNotice('');
    if (r.readOnly) setMode('preview');
  }, [toast]);

  const save = useCallback(async ({ overwrite = false, content }: { overwrite?: boolean; content?: string } = {}) => {
    const { open: cur, text: body } = state.current;
    if (!cur || cur.readOnly) return false;
    const next = content !== undefined ? content : body;
    const r = await api.saveDoc({ relPath: cur.relPath, content: next, version: cur.version, overwrite });
    if (r.conflict) { setNotice('changed'); return false; }
    if (r.gone) { setNotice('gone'); return false; }
    if (!r.ok) { toast(r.message || '保存失败', { tone: 'bad' }); return false; }
    setOpen({ ...cur, version: r.version, savedContent: next, mtimeMs: r.mtimeMs ?? cur.mtimeMs, size: r.size ?? cur.size });
    if (content !== undefined) setText(next);
    setNotice('');
    toast(r.unchanged ? '没有改动' : '已保存', { tone: 'ok' });
    loadList();
    return true;
  }, [loadList, toast]);

  // true when it is fine to leave the open document: nothing to lose, saved, or thrown away on purpose
  const canLeave = useCallback(async () => {
    if (!state.current.dirty || !state.current.open) return true;
    const a = await choose({
      title: '有未保存的修改', message: `「${titleOf(nameOf(state.current.open.relPath))}」有没保存的修改。`,
      choices: [{ label: '取消', value: '' }, { label: '不保存', value: 'discard', variant: 'danger' }, { label: '保存', value: 'save', variant: 'primary' }],
    });
    if (!a) return false;
    if (a === 'discard') { setText(state.current.open.savedContent); return true; }
    return save();
  }, [choose, save]);

  useEffect(() => { setLeaveGuard(dirty ? canLeave : null); }, [dirty, canLeave, setLeaveGuard]);
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard]);

  // a different project: nothing of the old one stays on screen
  useEffect(() => { setOpen(null); setResults(null); setQuery(''); loadList(); }, [projectVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // another page asked for a document to be opened here (the assets page's 打开清单)
  useEffect(() => {
    let wanted = '';
    try {
      wanted = sessionStorage.getItem('blackbox.script.open') || '';
      sessionStorage.removeItem('blackbox.script.open');
    } catch { /* nothing asked */ }
    if (wanted) openDoc(wanted);
  }, [openDoc]);

  // edits made outside (Claude, another editor) show up when the window comes back
  useEffect(() => {
    const onFocus = async () => {
      const r = await loadList();
      const cur = state.current.open;
      if (!r || !cur) return;
      const entry = (r.docs as Doc[]).find((d) => d.relPath === cur.relPath);
      if (!entry || (entry.mtimeMs === cur.mtimeMs && entry.size === cur.size)) return;
      if (!state.current.dirty) { await openDoc(cur.relPath); toast('已载入文件的最新内容', { tone: 'ok' }); } else setNotice('changed');
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadList, openDoc, toast]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    const t = window.setTimeout(async () => {
      if (!query.trim()) { setResults(null); return; }
      const r = await api.searchDocs({ query: query.trim() });
      setResults(r.ok ? r.results : []);
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const pick = async (relPath: string) => {
    if (open && open.relPath === relPath) return;
    if (await canLeave()) openDoc(relPath);
  };

  const create = async () => {
    if (!creating) return;
    const r = await api.createDoc({ name: creating.name, category: creating.category });
    if (!r.ok) { setCreating({ ...creating, error: r.message || '创建失败' }); return; }
    setCreating(null);
    await loadList();
    await openDoc(r.relPath);
    setMode('edit');
  };

  const rename = async () => {
    if (!open || !(await canLeave())) return;
    const cur = titleOf(nameOf(open.relPath));
    const name = await ask({ title: '重命名文档', label: '新的名字', value: cur, okLabel: '改名' });
    if (name === null || name === cur) return;
    const r = await api.renameDoc({ relPath: open.relPath, name });
    if (!r.ok) { toast(r.message || '改名失败', { tone: 'bad' }); return; }
    await loadList();
    await openDoc(r.relPath);
    toast('已改名', { tone: 'ok' });
  };

  const saveAsNew = async () => {
    if (!open) return;
    const name = await ask({ title: '另存为新文档', label: '新文档的名字', value: `${titleOf(nameOf(open.relPath))}（我的修改）`, okLabel: '另存' });
    if (name === null) return;
    const entry = list?.docs.find((d) => d.relPath === open.relPath);
    const made = await api.createDoc({ name, category: entry?.category || '其他' });
    if (!made.ok) { toast(made.message || '另存失败', { tone: 'bad' }); return; }
    const fresh = await api.readDoc({ relPath: made.relPath });
    const r = await api.saveDoc({ relPath: made.relPath, content: text, version: fresh.version });
    if (!r.ok) { toast(r.message || '另存失败', { tone: 'bad' }); return; }
    await loadList();
    await openDoc(made.relPath);
    toast('已另存为新文档', { tone: 'ok' });
  };

  const showHistory = async () => {
    if (!open) return;
    const h = await api.docHistory({ relPath: open.relPath });
    if (!h.ok) { toast(h.message, { tone: 'bad' }); return; }
    if (!h.history.length) { toast('这篇文档还没有历史版本（每次保存都会留下上一个版本）'); return; }
    setHistory({ items: h.history, chosen: null, active: '' });
  };

  if (empty === 'noProject') {
    return <EmptyState title="还没有选择剧本项目" body="新建一个，或者导入你已有的剧本文件夹，设定文档就保存在项目里。"
      action={<Button variant="primary" onClick={() => go('settings', 'projects')}>去设置 · 项目</Button>} />;
  }
  if (!list) return <div className="script" />;
  if (empty === 'noFolder') {
    return <EmptyState title={`设定文件夹「${list.folderName}」还不存在`} action={<Button variant="primary" onClick={async () => {
      const e = await api.ensureDocsFolder();
      toast(e.ok ? '已创建文件夹' : e.message || '', { tone: e.ok ? 'ok' : 'bad' });
      loadList();
    }}>创建文件夹</Button>} />;
  }

  const byPath = Object.fromEntries(list.docs.map((d) => [d.relPath, d]));
  const item = (d: Doc, snippets?: Loose[], total?: number) => (
    <button key={d.relPath} className={`doc-item ${open?.relPath === d.relPath ? 'on' : ''}`} data-doc={d.relPath} onClick={() => pick(d.relPath)}>
      <span className="t">{titleOf(d.name)}{dirty && open?.relPath === d.relPath ? <i /> : null}</span>
      <span className="s">{d.relPath.includes('/') ? `${d.relPath.slice(0, d.relPath.lastIndexOf('/'))} · ` : ''}{d.mtimeMs ? fmt.formatAgo(d.mtimeMs, Date.now()) : ''}</span>
      {(snippets || []).map((m, i) => <span key={i} className="snip">{m.line}: {m.text}</span>)}
      {total && snippets && total > snippets.length ? <span className="s">…这篇里还有 {total - snippets.length} 处</span> : null}
    </button>
  );
  const entry = open ? byPath[open.relPath] : null;

  return (
    <div className={`script ${chatOpen ? 'with-chat' : ''}`} id="script">
      <aside className="doc-side">
        <div className="head">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Button id="btn-script-chat" on={chatOpen ? 'acc' : false} onClick={() => showChat(!chatOpen)}><Icon name="sparkle" />AI 讨论</Button>
        <Button id="btn-doc-new" onClick={async () => { if (await canLeave()) setCreating({ name: '', category: '其他', touched: false, error: '' }); }}><Icon name="plus" />新建文档</Button>
          </div>
          <TextInput small id="doc-search" value={query} placeholder="搜索全部文档…" onChange={(e) => setQuery(e.target.value)} />
          <span className="folder ellipsis" id="doc-folder">设定文件夹：{list.folderName}</span>
        </div>
        <div className="doc-list" id="doc-list">
          {results ? (results.length ? results.map((r) => item(byPath[r.relPath] || { relPath: r.relPath, name: nameOf(r.relPath), category: '', mtimeMs: 0, size: 0 }, r.matches, r.total))
            : <div className="doc-none">没有找到</div>)
            : list.docs.length ? list.categories.map((cat) => {
              const docs = list.docs.filter((d) => d.category === cat);
              return docs.length ? <div key={cat}>{(cat !== '其他' || list.docs.some((d) => d.category !== cat)) && <div className="doc-cat"><span>{cat}</span><span className="num">{docs.length}</span></div>}{docs.map((d) => item(d))}</div> : null;
            }) : <div className="doc-none">还没有文档。点「新建文档」开始写。</div>}
        </div>
        <div className="foot">
          <Button size="sm" variant="ghost" id="btn-doc-folder" onClick={async () => {
            if (!(await canLeave())) return;
            const r = await api.pickDocsFolder();
            if (r.cancelled) return;
            toast(r.ok ? '已改用这个文件夹存放设定文档' : r.message || '', { tone: r.ok ? 'ok' : 'bad' });
            if (r.ok) { setOpen(null); loadList(); }
          }}>换文件夹…</Button>
          <Button size="sm" variant="ghost" onClick={async () => { const r = await api.revealDoc({}); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>打开文件夹</Button>
        </div>
      </aside>

      <section className="doc-main">
        {open ? (
          <>
            <div className="doc-tools">
              <h2>{titleOf(nameOf(open.relPath))}</h2>
              {dirty ? <span className="dirty" id="doc-dirty">● 未保存</span> : null}
              <span style={{ flex: 1 }} />
              <Segmented value={mode} onChange={(m) => { if (m === 'edit' && open.readOnly) return; setMode(m); }}
                options={[{ value: 'preview', label: '预览' }, { value: 'edit', label: '编辑' }]} id="doc-mode" />
              <Select small id="doc-category" style={{ width: 110 }} value={entry?.category || '其他'} onChange={async (e) => {
                const r = await api.setDocCategory({ relPath: open.relPath, category: e.target.value });
                if (!r.ok) toast(r.message || '', { tone: 'bad' });
                loadList();
              }}>{list.categories.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
              <Button size="sm" variant="primary" id="btn-doc-save" disabled={!dirty || open.readOnly} onClick={() => save()}>保存</Button>
              <Button size="sm" id="btn-doc-copy" onClick={async () => { const r = await api.copyText({ text }); toast(r.ok ? '已复制全文' : r.message || '', { tone: r.ok ? 'ok' : 'bad' }); }}>复制全文</Button>
              <Button size="sm" id="btn-doc-history" onClick={showHistory}>历史版本</Button>
              <Button size="sm" id="btn-doc-reveal" onClick={async () => { const r = await api.revealDoc({ relPath: open.relPath }); if (!r.ok) toast(r.message || '', { tone: 'bad' }); }}>在文件夹中显示</Button>
              <Button size="sm" id="btn-doc-rename" onClick={rename}>改名</Button>
              <Button size="sm" variant="danger" id="btn-doc-trash" onClick={async () => {
                const r = await api.trashDoc({ relPath: open.relPath });
                if (r.cancelled) return;
                if (!r.ok) { toast(r.message || '', { tone: 'bad' }); return; }
                toast('已移到回收站', { tone: 'ok' });
                setOpen(null);
                loadList();
              }}><Icon name="trash" /></Button>
            </div>
            {open.readOnly ? <div className="doc-notice">{open.readOnlyReason}</div> : null}
            {notice ? (
              <div className="doc-notice" id="doc-notice">
                <span>{notice === 'gone' ? '这个文件已经不在原来的位置了（被删除或改名），没有保存。' : '这个文件在你打开之后被改过了（可能是别的程序或 Claude）。你的修改还没有保存。'}</span>
                {notice === 'changed' ? <>
                  <Button size="sm" onClick={async () => { await openDoc(open.relPath); toast('已载入文件的最新内容', { tone: 'ok' }); }}>重新载入（放弃我的修改）</Button>
                  <Button size="sm" variant="danger" onClick={() => save({ overwrite: true })}>覆盖保存</Button>
                </> : null}
                <Button size="sm" variant="primary" onClick={saveAsNew}>另存为新文档…</Button>
              </div>
            ) : null}
            <div className="doc-body">
              {mode === 'edit' ? <TextArea className="doc-editor" id="doc-editor" value={text} readOnly={open.readOnly} onChange={(e) => setText(e.target.value)} autoFocus />
                : <div className="inner"><MarkdownView text={text} /></div>}
            </div>
          </>
        ) : <EmptyState title="选一篇文档" body="从左边选一篇文档开始，或者点「新建文档」写一篇。"
          action={<details className="doc-howto"><summary>分镜文档怎么写？</summary>
            <p>每个镜头单独起一个标题，比如「## MOTION-E01-01 · 清晨的街道」。E01 是第几集，后面的 01 是第几个镜头；标题下面写这个镜头的画面。这样写，镜头页就能自动读到。</p>
          </details>} />}
      </section>

      {chatOpen ? (
        <ScriptChat dirtyDoc={dirty && open ? open.relPath : ''} onClose={() => showChat(false)}
          onOpenDoc={(rel) => pick(rel)}
          // an applied (or undone) edit: the open document shows it at once, the list its new time
          onDocChanged={async (rel) => {
            await loadList();
            if (state.current.open && state.current.open.relPath === rel && !state.current.dirty) await openDoc(rel);
          }} />
      ) : null}

      {creating ? (
        <Modal title="新建设定文档" onClose={() => setCreating(null)} actions={<>
          <Button onClick={() => setCreating(null)}>取消</Button>
          <Button variant="primary" id="btn-doc-create" onClick={create}>创建</Button>
        </>}>
          <Field label="文档名"><TextInput id="new-doc-name" autoFocus value={creating.name} placeholder="例如：第二集分镜"
            onChange={(e) => setCreating({ ...creating, name: e.target.value, category: creating.touched ? creating.category : guess(e.target.value), error: '' })}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></Field>
          <Field label="类别"><Select value={creating.category} onChange={(e) => setCreating({ ...creating, category: e.target.value, touched: true })}>
            {list.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select></Field>
          {creating.error ? <p style={{ color: 'var(--bad)' }}>{creating.error}</p> : null}
        </Modal>
      ) : null}

      {history && open ? (
        <Modal wide title={`历史版本 · ${titleOf(nameOf(open.relPath))}`} onClose={() => setHistory(null)} actions={<>
          <Button onClick={() => setHistory(null)}>关闭</Button>
          <Button variant="primary" disabled={!history.chosen} onClick={async () => {
            if (!history.chosen) return;
            if (dirty && !(await confirm({ title: '恢复历史版本', message: '编辑区里有没保存的修改，恢复会丢掉它们。继续吗？', okLabel: '继续恢复', danger: true }))) return;
            if (await save({ content: history.chosen.content })) { toast('已恢复。恢复前的内容也保存在历史版本里', { tone: 'ok' }); setHistory(null); }
          }}>恢复这个版本</Button>
        </>}>
          <div className="hist">
            <div className="hist-list">
              {history.items.map((h) => (
                <button key={h.id} className={`doc-item ${history.active === h.id ? 'on' : ''}`} onClick={async () => {
                  const r = await api.readDocHistory({ relPath: open.relPath, id: h.id });
                  setHistory({ ...history, active: h.id, chosen: r.ok ? r : null });
                }}>
                  <span className="t num">{new Date(h.time).toLocaleString('zh-CN', { hour12: false })}</span>
                  <span className="s num">{fmt.formatBytes(h.size)}</span>
                </button>
              ))}
            </div>
            <pre className="hist-view">{history.chosen ? history.chosen.content : '点左边的一个版本查看'}</pre>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
