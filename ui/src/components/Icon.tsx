const PATHS: Record<string, string> = {
  film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4',
  pen: 'M4 20h4L19 9l-4-4L4 16z',
  user: 'M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8M4 21c1-4 4-6 8-6s7 2 8 6',
  img: 'M3 4h18v16H3zM21 15l-5-5-9 9',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  gear: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM14 4h4v16h-4z',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  chevron: 'M6 9l6 6 6-6',
  search: 'M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14M21 21l-5-5',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  sparkle: 'M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3',
  building: 'M4 21V5l8-3 8 3v16M2 21h20M10 21v-4h4v4M8 8h2M14 8h2M8 12h2M14 12h2',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9l-5-5M15 9l5-5M9 15l-5 5M15 15l5 5',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const filled = name === 'play' || name === 'pause';
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
