// Centralized line-icon set. All icons are 24x24, inherit `currentColor`, and
// scale with `size`. Keeps iconography consistent across every section.

const paths = {
  cog: (
    <>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 2.5l1.4 2.4 2.7-.6.5 2.7 2.4 1.1-.9 2.6 1.8 2.1-1.8 2.1.9 2.6-2.4 1.1-.5 2.7-2.7-.6L12 21.5l-1.4-2.4-2.7.6-.5-2.7-2.4-1.1.9-2.6L4.1 11l1.8-2.1-.9-2.6 2.4-1.1.5-2.7 2.7.6L12 2.5z" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 9v6h3l9 4V5L7 9H4z" />
      <path d="M19 9a3.5 3.5 0 010 6" />
    </>
  ),
  trophy: (
    <>
      <path d="M7 4h10v3a5 5 0 01-10 0V4z" />
      <path d="M7 5H4.5v1.5A2.5 2.5 0 007 9M17 5h2.5v1.5A2.5 2.5 0 0117 9" />
      <path d="M9.5 13.5h5M10.5 20h3M12 13.5V20" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="14.5" r="5.5" />
      <path d="M9 9.5L7 3M15 9.5l2-6M10.5 3h3" />
    </>
  ),
  bars: <path d="M4 20h16M7 20v-7m5 7V8m5 12v-5" />,
  star: <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 18.8 6.8 19.2l1-5.8L3.5 9.2l5.9-.9L12 3z" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 6.5l8 6 8-6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
    </>
  ),
  building: <path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6" />,
  pin: (
    <>
      <path d="M12 21s7-5.7 7-11a7 7 0 10-14 0c0 5.3 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  external: (
    <>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  wrench: <path d="M14.5 6a3.5 3.5 0 00-4.6 4.3l-5.1 5.1a1.6 1.6 0 002.3 2.3l5.1-5.1A3.5 3.5 0 0018 9.5L15.5 12 12 8.5 14.5 6z" />,
  cpu: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 7V4m4 3V4m-4 16v-3m4 3v-3M7 10H4m3 4H4m16-4h-3m3 4h-3" />
    </>
  ),
  code: <path d="M8 9l-4 3 4 3m8-6l4 3-4 3m-2-9l-4 12" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9h16M8 3v4m8-4v4" />
    </>
  ),
  heart: <path d="M12 20s-7-4.6-7-9.5A3.5 3.5 0 0112 7a3.5 3.5 0 017 3.5C19 15.4 12 20 12 20z" />,
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="1" />
      <path d="M4 13h16M12 9v11" />
      <path d="M12 9S10.5 4 8 4a2 2 0 000 5h4zm0 0s1.5-5 4-5a2 2 0 010 5h-4z" />
    </>
  ),
  spark: <path d="M12 3v5m0 8v5m9-9h-5M8 12H3m13.5-6.5l-3.5 3.5m-3 3l-3.5 3.5m13-0l-3.5-3.5m-3-3L5.5 5.5" />,
  flag: <path d="M5 21V4m0 0l10 0-2 4 2 4H5" />,

  /* --- Portal --- */
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.2" />
      <rect x="13" y="4" width="7" height="7" rx="1.2" />
      <rect x="4" y="13" width="7" height="7" rx="1.2" />
      <rect x="13" y="13" width="7" height="7" rx="1.2" />
    </>
  ),
  folder: <path d="M4 19V6a1 1 0 011-1h4l2 2.5h8a1 1 0 011 1V19a1 1 0 01-1 1H5a1 1 0 01-1-1z" />,
  // Node-and-edge glyph — the graph section, matching graphify's own vocabulary.
  share: (
    <>
      <circle cx="18" cy="6" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="18" r="2.6" />
      <path d="M8.4 10.8l7.2-3.6M8.4 13.2l7.2 3.6" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5h9a3 3 0 013 3V20H8a3 3 0 01-3-3V4.5z" />
      <path d="M5 17a3 3 0 013-3h9" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6" />
      <path d="M16 5.4a3.2 3.2 0 010 5.2M17.5 14.9c2.1.7 3.5 2.5 3.5 5.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="M15.6 15.6L20 20" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  alert: (
    <>
      <path d="M12 4l8.5 15H3.5L12 4z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
}

export default function Icon({ name, size = 22, strokeWidth = 1.6, className = '', ...rest }) {
  const d = paths[name]
  if (!d) return null
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
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {d}
    </svg>
  )
}

export const iconNames = Object.keys(paths)
