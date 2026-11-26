/** Biểu tượng nét đơn 24×24 (stroke = currentColor). Hằng số tĩnh — không chứa dữ liệu người dùng. */
import type { IconName } from './icon-names';

export type { IconName } from './icon-names';

const PATHS: Record<IconName, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path><path d="M10 21v-6h4v6"></path>',
  users: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"></path><path d="M18 14.8c1.9.7 3.1 2.4 3.5 5.2"></path>',
  queue: '<rect x="3" y="4" width="18" height="5" rx="1.5"></rect><rect x="3" y="11" width="18" height="4" rx="1.5"></rect><rect x="3" y="17" width="18" height="3" rx="1.5"></rect>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M3 10h18"></path><path d="M8 3v4"></path><path d="M16 3v4"></path>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"></rect>',
  search: '<circle cx="11" cy="11" r="6.5"></circle><path d="m20 20-4.2-4.2"></path>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"></path><path d="M10 21h4"></path>',
  steth: '<path d="M6 3v6a4 4 0 0 0 8 0V3"></path><path d="M10 13v2a5 5 0 0 0 10 0v-2"></path><circle cx="20" cy="11" r="2"></circle>',
  pill: '<rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)"></rect><path d="m8.5 8.5 7 7"></path>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5Z"></path><path d="m3 7.5 9 4.5 9-4.5"></path><path d="M12 12v9"></path>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><circle cx="16.5" cy="15" r="1.2"></circle>',
  chart: '<path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M3 20h18"></path>',
  trend: '<path d="m3 17 6-6 4 4 8-8"></path><path d="M15 7h6v6"></path>',
  spark: '<path d="M12 3v4"></path><path d="M12 17v4"></path><path d="M3 12h4"></path><path d="M17 12h4"></path><path d="m5.6 5.6 2.8 2.8"></path><path d="m15.6 15.6 2.8 2.8"></path><path d="m18.4 5.6-2.8 2.8"></path><path d="m8.4 15.6-2.8 2.8"></path>',
  handover: '<path d="M3 13h4l3 3h4a2 2 0 0 0 0-4h-3"></path><path d="M3 20h12l6-5"></path><rect x="12" y="3" width="8" height="7" rx="1.5"></rect>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6Z"></path><path d="m9 12 2 2 4-4"></path>',
  plug: '<path d="M9 3v5"></path><path d="M15 3v5"></path><path d="M6 8h12v3a6 6 0 0 1-12 0Z"></path><path d="M12 17v4"></path>',
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="9" cy="11" r="2.2"></circle><path d="M5.5 16.5c.6-1.6 1.9-2.4 3.5-2.4s2.9.8 3.5 2.4"></path><path d="M15 10h3.5"></path><path d="M15 13.5h3.5"></path>',
  gear: '<circle cx="12" cy="12" r="3"></circle><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"></path>',
  x: '<path d="M6 6l12 12"></path><path d="M18 6 6 18"></path>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3Z"></path><path d="M12 14v6"></path>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 16l-4-4 4-4"></path><path d="M6 12h10"></path>',
  check: '<path d="m4 12.5 5 5L20 6.5"></path>',
};

export function Icon({ name, size = 22, strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
