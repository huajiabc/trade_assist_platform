import { TickMarkType, type Time } from 'lightweight-charts';
import { formatDisplayTime } from '../../shared/displayTime';

function timestamp(time: Time): number {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Date.parse(time + 'T00:00:00Z') / 1000;
  return Date.UTC(time.year, time.month - 1, time.day) / 1000;
}

export function chartTimeFormatter(time: Time): string {
  return formatDisplayTime(timestamp(time));
}

export function chartTickFormatter(time: Time, type: TickMarkType): string {
  const date = chartTimeFormatter(time);
  switch (type) {
    case TickMarkType.Year: return date.slice(0, 4);
    case TickMarkType.Month: return Number(date.slice(5, 7)) + '月';
    case TickMarkType.DayOfMonth: return date.slice(5, 10);
    case TickMarkType.TimeWithSeconds: return formatDisplayTime(timestamp(time), true).slice(11);
    default: return date.slice(11);
  }
}
