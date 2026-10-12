// What the app's page and its alerts both use.

// How far along a limit is, as the color it is shown in, by quarters: 'low' (green) up to
// 25%, '' (the theme's blue) up to 50%, 'warn' (orange) up to 75% and 'crit' (red) from
// there on. The colors are fixed; when the notifications go off is the user's to set.
function level(pct) {
  if (pct >= 75) return 'crit';
  if (pct >= 50) return 'warn';
  return pct >= 25 ? '' : 'low';
}

// Line drawings on a 24 × 24 grid, each one stroke of a path. On the app's page they stand
// for what a tip or a step of the tour is about; on an alert, for what the alert is about.
const ICONS = {
  prompt: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 15.5h5',
  newChat: 'M4 5h16v11h-9l-4 4v-4H4zM12 8v5M9.5 10.5h5',
  bill: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 12h6',
  graph: 'M3.7 7a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0M15.7 6a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0M9.4 17a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0M7 9l3.6 5.8M17 8.1l-3.6 6.7M8.3 6.8l7.4-.6',
  bell: 'M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.2 1.6 1 2.4 1.8 2.6C10.5 8.5 11 5.5 12 3z',
  tidy: 'M4 9h16M4 15h16M9 3l3 3 3-3M9 21l3-3 3 3',
  gauge: 'M4 17a8 8 0 0 1 16 0M12 17l4-6M3 20h18',
  plug: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5 5 5M15 9.5v.1',
  target: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 12v.1',
  // A limit that started over, one about to run out, changing accounts, a new version.
  reset: 'M5.5 13a6.5 6.5 0 1 0 1.9-5.1M5 4.5v4h4',
  hourglass: 'M7 3h10M7 21h10M8 3v3.5l4 5.5 4-5.5V3M8 21v-3.5l4-5.5 4 5.5V21',
  swap: 'M4 8.5h14M14.5 5l3.5 3.5-3.5 3.5M20 15.5H6M9.5 12L6 15.5 9.5 19',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14',
};
