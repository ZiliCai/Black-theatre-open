import { useEffect, useRef, useState } from 'react';
import { api, type ChatEdit, type ChatMessage, type ScriptChat as Chat } from '../../api';
import { Button, Icon, TextArea, useToast } from '../../components';
import { useDialog } from '../../components/dialog';
import { LinkedEdits } from '../shots/LinkedEdits';
import { MarkdownView } from './MarkdownView';

const titleOf = (rel: string) => (rel.split('/').pop() || rel).replace(/\.(md|txt)$/i, '');
const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)} 千字` : `${n} 字`);

// Talking the whole script over with the AI. It reads the documents ticked under 「AI 看的文档」 (saved versions);
// a reply may carry edits to those documents, applied one at a time (and undoable), and shots whose prompts should
// change, which go through the same dialog as a linked edit on the shot page.
export function ScriptChat({ dirtyDoc, onDocChanged, onOpenDoc, onClose }: {
  dirtyDoc: string; onDocChanged: (relPath: string) => void; onOpenDoc: (relPath: string) => void; onClose: () => void;
}) {
  const toast = useToast();
  const { confirm } = useDialog();
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [shots, setShots] = useState<ChatMessage | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { api.loadScriptChat().then((r) => { if (r.ok) setChat(r); }); }, []);
  const count = chat ? chat.messages.length : 0;
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [count, sending]);

  const took = (r: Chat) => {
    if (!r.ok) { toast(r.message || '没成功', { tone: 'bad' }); return false; }
    setChat(r);
    if (r.doc) onDocChanged(r.doc);
    return true;
  };

  const send = async () => {
    const q = text.trim();
    if (!q || sending) return;
    if (dirtyDoc) toast(`「${titleOf(dirtyDoc)}」还没保存，AI 看到的是保存过的版本`);
    setSending(true);
    const r = await api.sendScriptChat({ text: q });
    setSending(false);
    if (took(r)) setText('');
  };

  const apply = async (m: ChatMessage, e: ChatEdit) => {
    if (dirtyDoc === e.doc) { toast(`「${titleOf(e.doc)}」有没保存的修改，先保存再应用`, { tone: 'bad' }); return false; }
    const r = await api.applyScriptChatEdit({ messageId: m.id, editId: e.id });
    setFailed((f) => ({ ...f, [`${m.id}/${e.id}`]: r.ok ? '' : r.message || '没改成' }));
    if (!r.ok) return false;
    setChat(r);
    if (r.doc) onDocChanged(r.doc);
    return true;
  };
  const undo = async (m: ChatMessage, e: ChatEdit) => {
    if (dirtyDoc === e.doc) { toast(`「${titleOf(e.doc)}」有没保存的修改，先保存再撤销`, { tone: 'bad' }); return; }
    took(await api.undoScriptChatEdit({ messageId: m.id, editId: e.id }));
  };
  const applyAll = async (m: ChatMessage) => {
    for (const e of (m.edits || []).filter((x) => x.state === 'todo')) await apply(m, e);
  };

  const setDocs = async (relPaths: string[]) => took(await api.setScriptChatDocs({ relPaths }));
  const chosen = chat ? chat.docs.filter((d) => d.chosen) : [];

  return (
    <aside className="chat-side" id="script-chat">
      <div className="chat-head">
        <b>AI 讨论剧本</b>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" id="btn-chat-new" disabled={!count || sending} onClick={async () => {
          if (await confirm({ title: '开始新对话', message: '这段对话会清掉（已经应用的修改留在文档里）。', okLabel: '清掉' })) took(await api.clearScriptChat());
        }}>新对话</Button>
        <Button size="sm" variant="ghost" onClick={onClose} title="收起"><Icon name="x" /></Button>
      </div>
      {chat ? (
        <button className={`chat-docs ${chat.chosenChars > chat.limit ? 'over' : ''}`} id="btn-chat-docs" onClick={() => setPicking(!picking)}>
          <span>AI 看的文档：{chosen.length} 篇 · 约 {thousands(chat.chosenChars)}</span>
          <Icon name="chevron" />
        </button>
      ) : null}
      {chat && picking ? (
        <div className="chat-pick" id="chat-pick">
          {chat.docs.map((d) => (
            <label key={d.relPath}>
              <input type="checkbox" checked={d.chosen} onChange={(ev) => setDocs(chat.docs.filter((x) => (x.relPath === d.relPath ? ev.target.checked : x.chosen)).map((x) => x.relPath))} />
              <span className="ellipsis">{d.relPath}</span><span className="num">{thousands(d.chars)}</span>
            </label>
          ))}
          {chat.chosenChars > chat.limit ? <p className="warn">太长了，AI 一次看不完（上限约 {thousands(chat.limit)}），请少选几篇。</p> : null}
        </div>
      ) : null}

      <div className="chat-list" ref={list}>
        {chat && !count ? (
          <div className="chat-empty">
            <p>和 AI 整体地聊剧本：人物、情节、节奏、前后对不对得上、哪几镜要改。</p>
            <p>说定了怎么改，它会给出具体的修改：文档里的改动一条条点「应用」，镜头提示词会按说明逐镜改写。</p>
          </div>
        ) : null}
        {(chat?.messages || []).map((m) => m.role === 'user' ? (
          <div key={m.id} className="chat-msg user">{m.text}</div>
        ) : (
          <div key={m.id} className="chat-msg ai" data-msg={m.id}>
            {m.text ? <MarkdownView text={m.text} /> : null}
            {(m.edits || []).map((e, i) => {
              const err = failed[`${m.id}/${e.id}`];
              return (
                <div key={e.id} className={`chat-edit ${e.state}`} data-edit={e.id}>
                  <div className="eh">
                    <span className="num">{i + 1}</span>
                    <button className="doc ellipsis" onClick={() => onOpenDoc(e.doc)} title="打开这篇文档">{titleOf(e.doc)}</button>
                    <span style={{ flex: 1 }} />
                    {e.state === 'applied'
                      ? <><span className="done"><Icon name="check" />已应用</span><Button size="sm" variant="ghost" onClick={() => undo(m, e)}>撤销</Button></>
                      : <Button size="sm" variant="primary" className="btn-apply" onClick={() => apply(m, e)}>应用</Button>}
                  </div>
                  {e.why ? <div className="why">{e.why}</div> : null}
                  <pre className="old">{e.find}</pre>
                  {e.replace ? <pre className="new">{e.replace}</pre> : <div className="why">（删掉这段）</div>}
                  {err ? <div className="err">{err}</div> : null}
                </div>
              );
            })}
            {(m.edits || []).filter((e) => e.state === 'todo').length > 1
              ? <Button size="sm" onClick={() => applyAll(m)}>全部应用（{(m.edits || []).filter((e) => e.state === 'todo').length} 处）</Button> : null}
            {(m.shots || []).length ? (
              <div className={`chat-shots ${m.shotsDone ? 'done' : ''}`}>
                <div className="eh"><b>要改提示词的镜头</b><span style={{ flex: 1 }} />
                  <Button size="sm" variant={m.shotsDone ? 'ghost' : 'primary'} className="btn-shots" onClick={() => setShots(m)}>{m.shotsDone ? '再看看' : `改这 ${(m.shots || []).length} 镜…`}</Button>
                </div>
                {(m.shots || []).map((s) => <div key={s.shotId} className="row"><span className="num">{s.shotId.replace(/^MOTION-/, '')}</span>{s.remark}</div>)}
              </div>
            ) : null}
          </div>
        ))}
        {sending ? <div className="chat-msg ai pending">AI 正在看剧本…（文档长的话要一两分钟）</div> : null}
      </div>

      <div className="chat-input">
        <TextArea id="chat-text" value={text} rows={3} placeholder="比如：第二场节奏太慢，老周的戏能不能压缩？（Ctrl+Enter 发送）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <Button variant="primary" id="btn-chat-send" disabled={!text.trim() || sending || !chosen.length} onClick={send}>{sending ? '回答中…' : '发送'}</Button>
      </div>

      {shots ? (
        <LinkedEdits from="剧本讨论里" items={shots.shots || []} onClose={async () => {
          const m = shots;
          setShots(null);
          took(await api.scriptChatShotsDone({ messageId: m.id }));
        }} />
      ) : null}
    </aside>
  );
}
