import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Button, Field, Modal, TextInput } from './index';

type Choice = { label: string; value: string; variant?: 'default' | 'primary' | 'danger' };
type Open =
  | { kind: 'ask'; title: string; label: string; value: string; placeholder?: string; okLabel: string; validate?: (t: string) => string; resolve: (v: string | null) => void }
  | { kind: 'choose'; title: string; message: ReactNode; detail?: ReactNode; choices: Choice[]; resolve: (v: string | null) => void };

type DialogApi = {
  ask: (o: { title: string; label: string; value?: string; placeholder?: string; okLabel?: string; validate?: (t: string) => string }) => Promise<string | null>;
  confirm: (o: { title: string; message: ReactNode; detail?: ReactNode; okLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
  choose: (o: { title: string; message: ReactNode; detail?: ReactNode; choices: Choice[] }) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi>(null as unknown as DialogApi);
export const useDialog = () => useContext(DialogContext);

// Questions as promises: `if (await confirm({...}))`, `const name = await ask({...})`. Closing means "no".
export function DialogHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const ask = useCallback<DialogApi['ask']>((o) => new Promise((resolve) => {
    setText(o.value || '');
    setError('');
    setOpen({ kind: 'ask', okLabel: '确定', value: o.value || '', ...o, resolve });
  }), []);
  const choose = useCallback<DialogApi['choose']>((o) => new Promise((resolve) => setOpen({ kind: 'choose', ...o, resolve })), []);
  const confirm = useCallback<DialogApi['confirm']>(async (o) => (await choose({
    title: o.title, message: o.message, detail: o.detail,
    choices: [{ label: o.cancelLabel || '取消', value: '' }, { label: o.okLabel || '确定', value: 'ok', variant: o.danger ? 'danger' : 'primary' }],
  })) === 'ok', [choose]);

  const finish = (v: string | null) => {
    if (!open) return;
    open.resolve(v);
    setOpen(null);
  };
  const submit = () => {
    if (!open || open.kind !== 'ask') return;
    const problem = open.validate ? open.validate(text) : '';
    if (problem) { setError(problem); return; }
    finish(text);
  };

  return (
    <DialogContext.Provider value={{ ask, confirm, choose }}>
      {children}
      {open && open.kind === 'ask' ? (
        <Modal id="dialog" title={open.title} onClose={() => finish(null)} actions={<>
          <Button onClick={() => finish(null)}>取消</Button>
          <Button variant="primary" id="dialog-ok" onClick={submit}>{open.okLabel}</Button>
        </>}>
          <Field label={open.label}>
            <TextInput id="dialog-input" autoFocus value={text} placeholder={open.placeholder} onChange={(e) => { setText(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </Field>
          {error ? <p style={{ color: 'var(--bad)' }}>{error}</p> : null}
        </Modal>
      ) : null}
      {open && open.kind === 'choose' ? (
        <Modal id="dialog" title={open.title} onClose={() => finish(null)} actions={<>
          {open.choices.map((c) => <Button key={c.value} variant={c.variant || 'default'} data-choice={c.value} onClick={() => finish(c.value || null)}>{c.label}</Button>)}
        </>}>
          <div>{open.message}</div>
          {open.detail ? <div style={{ color: 'var(--sub)', fontSize: 13 }}>{open.detail}</div> : null}
        </Modal>
      ) : null}
    </DialogContext.Provider>
  );
}
