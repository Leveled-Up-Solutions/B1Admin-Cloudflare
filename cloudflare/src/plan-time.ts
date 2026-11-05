import type { Context } from './types';
import { first, HttpError, requiredString } from './http';

export function validTimeZone(value: unknown): string {
  const zone = requiredString(value, 'timeZone', 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  } catch {
    throw new HttpError(400, 'Invalid IANA timeZone');
  }
  return zone;
}
export async function churchTimeZone(ctx: Context): Promise<string> {
  const church = await first(ctx, 'SELECT timeZone FROM churches WHERE id=?', ctx.principal.churchId);
  return validTimeZone(church?.timeZone || 'UTC');
}
function wallClock(instant: number, zone: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant))
    parts[p.type] = p.value;
  return (
    Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`) +
    new Date(instant).getUTCMilliseconds()
  );
}
export function localDay(instant: number, zone: string): string {
  return new Date(wallClock(instant, zone)).toISOString().slice(0, 10);
}
/** Move a service time by civil days, preserving its church-local time and day offset.
 * A repeated hour uses the source offset if available, otherwise its earlier instant.
 * A skipped local time fails the whole copy rather than silently changing the schedule.
 */
export function shiftServiceTime(value: string, dayDelta: number, zone: string): string {
  const source = Date.parse(value);
  const sourceWall = wallClock(source, zone);
  const targetWall = sourceWall + dayDelta * 86400000;
  const sourceOffset = sourceWall - source;
  const offsets = new Set<number>([sourceOffset]);
  // Sampling both sides covers DST changes, including half-hour transitions and
  // date-line changes, without assuming all UTC offsets are whole hours.
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = targetWall + hours * 3600000;
    offsets.add(wallClock(sample, zone) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => targetWall - offset)
    .filter((candidate) => wallClock(candidate, zone) === targetWall)
    .sort((a, b) => a - b);
  if (!candidates.length)
    throw new HttpError(409, `Copied time does not exist in ${zone}; choose a valid service time before copying`);
  const chosen = candidates.find((candidate) => targetWall - candidate === sourceOffset) ?? candidates[0];
  return new Date(chosen).toISOString();
}
