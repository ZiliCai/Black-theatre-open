import { Icon, type IconName } from '../components';
import { useApp, type PageId } from './context';

const MAIN: { id: PageId; label: string; icon: IconName }[] = [
  { id: 'script', label: '剧本', icon: 'pen' },
  { id: 'scene', label: '场景', icon: 'building' },
  { id: 'assets', label: '素材', icon: 'user' },
  { id: 'shots', label: '镜头', icon: 'film' },
  { id: 'gallery', label: '成片', icon: 'box' },
];

export function NavRail({ page }: { page: PageId }) {
  const { go } = useApp();
  const item = (p: { id: PageId; label: string; icon: IconName }) => (
    <button key={p.id} id={`nav-${p.id}`} className={page === p.id ? 'on' : ''} onClick={() => go(p.id)} aria-current={page === p.id}>
      <Icon name={p.icon} size={18} />{p.label}
    </button>
  );
  return (
    <nav className="nav">
      {MAIN.map(item)}
      <div className="grow" />
      {item({ id: 'settings', label: '设置', icon: 'gear' })}
    </nav>
  );
}
