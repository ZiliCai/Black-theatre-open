import logo from '../../../renderer/assets/app-icon.png';
import { ComfyMenu } from './ComfyMenu';
import { ProjectSwitcher } from './ProjectSwitcher';
import { QueueIndicator } from './QueueIndicator';

// The window has no system title bar, so this bar is also what the user drags; buttons opt out of dragging.
export function TopBar({ setSlots }: { setSlots: (s: { top: HTMLElement | null; crumb: HTMLElement | null }) => void }) {
  return (
    <header className="top drag">
      <div className="logo"><img src={logo} alt="" />黑箱剧场</div>
      <div className="crumbs" id="crumbs">
        <span ref={(el) => setSlots({ top: null, crumb: el })} style={{ display: 'contents' }} />
      </div>
      <div className="sp" />
      <ProjectSwitcher />
      <QueueIndicator />
      <ComfyMenu />
      <div className="slot no-drag" ref={(el) => setSlots({ top: el, crumb: null })} />
    </header>
  );
}
