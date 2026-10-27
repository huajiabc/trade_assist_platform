/** Shared by the interactive chart and the clean AI capture. Canvas overlays
 * keep semantic colors separate from candles and never change price anchors. */
export const CHART_THEME = {
  background: '#10141c',
  text: '#9da9bb',
  foreground: '#dce3ee',
  grid: 'rgba(157,169,187,.065)',
  divider: '#252d3a',
  crosshair: '#65758b',
  crosshairLabel: '#303c50',
  up: '#26a69a',
  down: '#ef5350',
  wickUp: '#33968b',
  wickDown: '#cf6268',
  bullish: '#55b9a4',
  bearish: '#dc8290',
  neutral: '#a0aec2',
  blue: '#839ed8',
  gold: '#cfad76',
  zone: {
    FVG: { bullish: '#8797d2', bearish: '#ad91c9' },
    OB: { bullish: '#65b4a6', bearish: '#ce9785' },
  },
  retired: '#8792a5',
  labelBackground: 'rgba(16,20,28,.86)',
  selectedBackground: '#29364a',
} as const;

export function withAlpha(hex: string, opacity: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${opacity})`;
}
