import React from "react";
import { MemberPagination } from "./MemberPagination";
import { useMemberPage } from "./useMemberPage";

export interface MemberEvent { id: string; title: string; start: string; end: string; allDay: boolean; timeZone: string; location?: string; description?: string; occurrenceId?: string }
interface Props { token: string; refresh: number; onExpired: () => void }
function day(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function localDate(value: string, days = 0): Date {
  const [year, month, date] = value.split("-").map(Number);
  return new Date(year, month - 1, date + days);
}
function initialWindow() { const today = day(new Date()); return { from: today, through: day(localDate(today, 89)) }; }
function label(value: string, allDay = false) {
  const date = allDay ? localDate(value.slice(0, 10)) : new Date(value);
  return date.toLocaleString(undefined, allDay ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" });
}
export const MemberEventCard = ({ event }: { event: MemberEvent }) => <article className="mp-card">
  <span className="mp-eyebrow">{label(event.start, event.allDay)}{event.allDay ? " · All day" : ""}</span><h3>{event.title}</h3>
  {!event.allDay && <p className="mp-muted">Ends {label(event.end)}</p>}{event.location && <p><strong>Where:</strong> {event.location}</p>}{event.description && <p className="mp-description">{event.description}</p>}
</article>;

export const MemberCalendar = ({ token, refresh, onExpired }: Props) => {
  const [dates, setDates] = React.useState(initialWindow);
  const [window, setWindow] = React.useState(() => ({ from: localDate(dates.from).toISOString(), to: localDate(dates.through, 1).toISOString() }));
  const [error, setError] = React.useState("");
  const page = useMemberPage<MemberEvent>("/api/member/v1/calendar", token, window, refresh, onExpired);
  function apply(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!dates.from || !dates.through || dates.through < dates.from) { setError("Choose an end date on or after the start date."); return; }
    const from = localDate(dates.from), to = localDate(dates.through, 1);
    if (to.getTime() - from.getTime() > 366 * 86400000) { setError("Choose a date range of at most one year."); return; }
    setWindow({ from: from.toISOString(), to: to.toISOString() });
  }
  return <><h1>Church calendar</h1><p className="mp-muted">Church events and gatherings for your groups. Times and date filters use your device time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). All-day event dates stay in their calendar’s time zone.</p>
    <form className="mp-card mp-calendar-filter" onSubmit={apply}><div className="mp-grid"><label>From date<input type="date" required min="1900-01-01" max="2200-12-31" value={dates.from} onChange={event => setDates(value => ({ ...value, from: event.target.value }))} /></label><label>Through date<input type="date" required min={dates.from || "1900-01-01"} max="2200-12-31" value={dates.through} onChange={event => setDates(value => ({ ...value, through: event.target.value }))} /></label></div><button className="mp-primary">Show events</button></form>
    {error && <p className="mp-alert" role="alert">{error}</p>}
    <div className="mp-grid">{page.items.map(event => <MemberEventCard key={event.occurrenceId || event.id} event={event} />)}</div>
    {!page.loading && !page.error && !page.items.length && <p className="mp-empty">No events are available in this date range.</p>}
    <MemberPagination page={page} label="Calendar" />
  </>;
};

export const MemberUpcomingEvents = ({ token, refresh, onExpired }: Props) => {
  const page = useMemberPage<MemberEvent>("/api/member/v1/calendar", token, {}, refresh, onExpired, true, 2);
  return <><div className="mp-grid">{page.items.map(event => <MemberEventCard key={event.occurrenceId || event.id} event={event} />)}</div>
    {page.loading && <p role="status">Loading upcoming events…</p>}{page.error && <p className="mp-alert" role="alert">{page.error} <button onClick={page.reload}>Try again</button></p>}
    {!page.loading && !page.error && !page.items.length && <p className="mp-empty">No upcoming events have been published.</p>}
  </>;
};
