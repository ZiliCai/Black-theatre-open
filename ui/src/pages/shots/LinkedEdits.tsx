import { useState } from 'react';
import { api, type Affect } from '../../api';
import { Button, Modal } from '../../components';

type Row = Affect & { checked: boolean; state: 'todo' | 'running' | 'done' | 'failed'; message: string };

// After a rewrite: the shots that must change with it to stay joined up. The checked ones are rewritten one by one
// with the remark written for them (and tidied, like any rewrite); what a rewrite says about shots further on is
// added below, unchecked. Shots left as they are get a note ("镜头 7 改过……") that stays until their prompt changes.
export function LinkedEdits({ from, items, onClose }: { from: string; items: Affect[]; onClose: (changed: boolean) => void }) {
  const [rows, setRows] = useState<Row[]>(items.map((a) => ({ ...a, checked: true, state: 'todo', message: '' })));
  const [running, setRunning] = useState(false);
  const patch = (shotId: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.shotId === shotId ? { ...r, ...p } : r)));

  const run = async () => {
    setRunning(true);
    for (const row of rows.filter((r) => r.checked && r.state !== 'done')) {
      patch(row.shotId, { state: 'running', message: '' });
      const r = await api.reviseLinkedShot({ shotId: row.shotId, remark: row.remark });
      if (!r.ok) {
        patch(row.shotId, { state: 'failed', message: r.message || '改写失败' });
        continue;
      }
      patch(row.shotId, { state: 'done', message: r.note || '已改' });
      const further = (r.affects || []) as Affect[];
      if (further.length) {
        setRows((rs) => [...rs, ...further.filter((a) => !rs.some((x) => x.shotId === a.shotId))
          .map((a) => ({ ...a, reason: `${a.reason}（因为镜头 ${row.n} 跟着改了）`, checked: false, state: 'todo' as const, message: '' }))]);
      }
    }
    setRunning(false);
  };

  // whatever is left unchanged keeps a note on its shot
  const close = async () => {
    if (running) return;
    for (const row of rows.filter((r) => r.state !== 'done')) {
      await api.noteLinkedShot({ shotId: row.shotId, from, reason: row.reason, remark: row.remark });
    }
    onClose(rows.some((r) => r.state === 'done'));
  };

  const todo = rows.filter((r) => r.checked && r.state !== 'done').length;
  return (
    <Modal id="linked-edits" wide title={`${from}改了，这些镜头可能要跟着改`} onClose={close}
      actions={<>
        <Button onClick={close} disabled={running}>{rows.every((r) => r.state === 'done') ? '完成' : '剩下的先不改'}</Button>
        <Button variant="primary" id="btn-linked-run" disabled={running || !todo} onClick={run}>{running ? '改写中…' : `改选中的 ${todo} 镜`}</Button>
      </>}>
      <p className="hint" style={{ marginTop: 0 }}>勾选的镜头会按下面的说明改写提示词并写回剧本，改完同样会整理一遍。不改的镜头会在镜头列表里标出来，以后可以再改。</p>
      <div className="linked-rows">
        {rows.map((r) => (
          <label key={r.shotId} className={`linked-row ${r.state}`} data-shot={r.shotId}>
            <input type="checkbox" checked={r.checked} disabled={running || r.state === 'done'}
              onChange={(e) => patch(r.shotId, { checked: e.target.checked })} />
            <div>
              <b className="num">镜头 {r.n}</b><span className="why">{r.reason}</span>
              <div className="remark">{r.remark}</div>
              {r.state !== 'todo' ? <div className={`state ${r.state}`}>{r.state === 'running' ? '改写中…' : r.state === 'done' ? `已改：${r.message}` : `没改成：${r.message}`}</div> : null}
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}
