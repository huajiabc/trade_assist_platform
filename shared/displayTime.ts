/** Display only. Market timestamps, snapshot anchors and session rules stay in UTC. */
export const DISPLAY_TIME_ZONE = 'UTC+8';
export const DISPLAY_UTC_OFFSET_SECONDS = 8 * 60 * 60;

export function formatDisplayTime(timestamp: number, seconds = false): string {
  return new Date((timestamp + DISPLAY_UTC_OFFSET_SECONDS) * 1000)
    .toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ');
}

export function shortDisplayTime(timestamp: number, seconds = false): string {
  return formatDisplayTime(timestamp, seconds).slice(5);
}
