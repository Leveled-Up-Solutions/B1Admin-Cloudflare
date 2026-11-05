import React from "react";
import { Alert, Box, Button, Container, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Checkbox, MenuItem, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
import type { GroupInterface } from "@churchapps/helpers";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { CalendarRecurrenceEditor } from "./CalendarRecurrenceEditor";

dayjs.extend(utc);
dayjs.extend(timezone);

type Calendar = { id?: string; name: string; description: string; color: string; timeZone: string; groupId: string | null };
type CalendarEvent = {
  id?: string; calendarId: string; groupId: string | null; title: string; description: string; start: string; end: string; allDay: boolean; location: string; timeZone: string;
  recurrenceRule?: string | null; exceptionDates?: string[]; occurrenceId?: string; seriesId?: string | null; occurrenceDate?: string | null; recurrenceIndex?: number;
  recurrenceParentId?: string | null; recurrenceOriginalDate?: string | null; savedStart?: string; savedEnd?: string;
};
const newCalendar = (): Calendar => ({ name: "", description: "", color: "#2563eb", timeZone: "UTC", groupId: null });
const datePart = (value: string, zone: string) => value.includes("T") ? dayjs(value).tz(zone).format("YYYY-MM-DD") : value;
const inputTime = (value: string, zone: string) => value ? dayjs(value).tz(zone).format("YYYY-MM-DDTHH:mm") : "";

export function CloudflareCalendars() {
  const cache = useQueryClient();
  const calendars = useQuery<Calendar[]>({ queryKey: ["/calendars", "ContentApi"] });
  const groups = useQuery<GroupInterface[]>({ queryKey: ["/groups", "MembershipApi"] });
  const [calendarId, setCalendarId] = React.useState("");
  const selected = calendars.data?.find(c => c.id === calendarId);
  const zone = selected?.timeZone || "UTC";
  const [calendarEdit, setCalendarEdit] = React.useState<Calendar | null>(null);
  const [eventEdit, setEventEdit] = React.useState<CalendarEvent | null>(null);
  const [view, setView] = React.useState("list");
  const [week, setWeek] = React.useState(() => dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD"));
  const windowEnd = dayjs(week).add(view === "week" ? 7 : 90, "day").format("YYYY-MM-DD");
  const events = useQuery<CalendarEvent[]>({ queryKey: [`/events/instances?calendarId=${calendarId}&start=${week}&end=${windowEnd}`, "ContentApi"], enabled: !!calendarId });
  const [recurringAction, setRecurringAction] = React.useState<{ event: CalendarEvent; action: "edit" | "delete" } | null>(null);
  const [editScope, setEditScope] = React.useState<"all" | "this" | "future">("all");
  const [resetExceptions, setResetExceptions] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [dialogError, setDialogError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const canEdit = UserHelper.checkAccess(Permissions.contentApi.content.edit);
  React.useEffect(() => {
    if (!calendarId && calendars.data?.[0]?.id) setCalendarId(calendars.data[0].id);
  }, [calendarId, calendars.data]);

  async function action(fn: () => Promise<unknown>, success: string, close?: () => void) {
    setBusy(true); setError(""); setDialogError(""); setMessage("");
    try { await fn(); await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "ContentApi" }); close?.(); setMessage(success); } catch (err) { const text = err instanceof Error ? err.message : "The change could not be saved."; if (calendarEdit || eventEdit) setDialogError(text); else setError(text); } finally { setBusy(false); }
  }
  function editEvent(event: CalendarEvent, scope: "all" | "this" | "future" = "all") {
    setDialogError(""); setEditScope(scope); setResetExceptions(false);
    let recurrenceRule = event.recurrenceRule;
    if (scope === "this") recurrenceRule = null;
    if (scope === "future" && recurrenceRule?.includes("COUNT=") && event.recurrenceIndex) recurrenceRule = recurrenceRule.replace(/COUNT=(\d+)/, (_, count) => `COUNT=${Number(count) - event.recurrenceIndex! + 1}`);
    setEventEdit({ ...event, recurrenceRule, savedStart: event.start, savedEnd: event.end, start: event.allDay ? event.start : inputTime(event.start, event.timeZone), end: event.allDay ? event.end : inputTime(event.end, event.timeZone) });
  }
  async function applyRecurringAction(scope: "all" | "this" | "future") {
    const selectedAction = recurringAction!;
    setRecurringAction(null);
    const event = selectedAction.event;
    const seriesId = event.seriesId || event.recurrenceParentId || event.id;
    const date = event.occurrenceDate || event.recurrenceOriginalDate;
    if (selectedAction.action === "delete") {
      const path = scope === "all" ? `/events/${seriesId}` : `/events/${seriesId}/${scope === "this" ? "occurrences" : "future"}/${date}`;
      await action(() => ApiHelper.delete(path, "ContentApi"), scope === "this" ? "Occurrence skipped." : scope === "future" ? "This and future occurrences deleted." : "Series deleted.");
    } else {
      setBusy(true); setError("");
      try {
        if (scope === "all") editEvent(await ApiHelper.get(`/events/${seriesId}`, "ContentApi"), scope);
        else if (scope === "future" && !event.recurrenceRule) {
          const original = await ApiHelper.get(`/events/${seriesId}/occurrences/${date}`, "ContentApi");
          editEvent({ ...event, recurrenceRule: original.recurrenceRule, recurrenceIndex: original.recurrenceIndex }, scope);
        } else editEvent(event, scope);
      } catch (err) { setError(err instanceof Error ? err.message : "The event could not be loaded."); } finally { setBusy(false); }
    }
  }
  function startEvent() {
    const start = dayjs().tz(zone).add(1, "day").hour(9).minute(0);
    setDialogError(""); setEditScope("all"); setResetExceptions(false);
    setEventEdit({ calendarId, groupId: selected?.groupId || null, title: "", description: "", start: start.format("YYYY-MM-DDTHH:mm"), end: start.add(1, "hour").format("YYYY-MM-DDTHH:mm"), allDay: false, location: "", timeZone: zone });
  }
  function changeAllDay(allDay: boolean) {
    setEventEdit(current => {
      if (!current) return current;
      if (!allDay) return { ...current, allDay, start: current.start + "T00:00", end: current.end + "T00:00" };
      const start = current.start.slice(0, 10);
      const endDate = current.end.slice(0, 10);
      const end = current.end.slice(11, 16) === "00:00" && endDate > start ? endDate : dayjs(endDate).add(1, "day").format("YYYY-MM-DD");
      return { ...current, allDay, start, end };
    });
  }
  function toUtc(value: string, timeZone: string) {
    const parsed = dayjs.tz(value, timeZone);
    if (!parsed.isValid() || parsed.format("YYYY-MM-DDTHH:mm") !== value) throw new Error("This time does not exist in the selected time zone. Choose another time.");
    return parsed.toISOString();
  }
  async function saveEvent() {
    const item = eventEdit!;
    await action(async () => {
      const start = item.allDay ? item.start : item.savedStart && inputTime(item.savedStart, item.timeZone) === item.start ? item.savedStart : toUtc(item.start, item.timeZone);
      const end = item.allDay ? item.end : item.savedEnd && inputTime(item.savedEnd, item.timeZone) === item.end ? item.savedEnd : toUtc(item.end, item.timeZone);
      if (end <= start) throw new Error("The event must end after it starts.");
      const payload = { ...item, start, end, resetExceptions };
      if (editScope === "this" || editScope === "future") {
        const seriesId = item.seriesId || item.recurrenceParentId || item.id;
        await ApiHelper.post(`/events/${seriesId}/${editScope === "this" ? "occurrences" : "future"}/${item.occurrenceDate || item.recurrenceOriginalDate}`, payload, "ContentApi");
      } else await ApiHelper.post("/events", [payload], "ContentApi");
    }, "Event saved.", () => setEventEdit(null));
  }
  const days = Array.from({ length: 7 }, (_, i) => dayjs(week).add(i, "day").format("YYYY-MM-DD"));
  function occurs(event: CalendarEvent, date: string) {
    const start = datePart(event.start, zone);
    const end = datePart(event.end, zone);
    return start <= date && (event.allDay ? end > date : end >= date);
  }
  const eventCard = (event: CalendarEvent) => <Paper key={event.occurrenceId || event.id} variant="outlined" sx={{ p: 2, borderLeft: 4, borderLeftColor: selected?.color || "primary.main" }}>
    <Stack spacing={1}>
      <Typography fontWeight={600}>{event.title}</Typography>
      <Typography variant="body2" color="text.secondary">{event.allDay ? `${event.start} – ${event.end} (end exclusive)` : `${dayjs(event.start).tz(zone).format("MMM D, YYYY HH:mm")} – ${dayjs(event.end).tz(zone).format("MMM D, YYYY HH:mm")}`}</Typography>
      {(event.recurrenceRule || event.seriesId) && <Typography variant="body2" color="text.secondary">Recurring event{event.recurrenceParentId ? " · edited occurrence" : ""}</Typography>}
      {event.location && <Typography variant="body2">{event.location}</Typography>}
      {event.groupId && <Typography variant="body2" color="text.secondary">Group: {groups.data?.find(g => g.id === event.groupId)?.name || "Group"}</Typography>}
      {event.description && <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{event.description}</Typography>}
      {canEdit && <Stack direction="row" spacing={1}>
        <Button size="small" onClick={() => event.recurrenceRule || event.seriesId ? setRecurringAction({ event, action: "edit" }) : editEvent(event)} aria-label={"Edit " + event.title}>Edit</Button>
        <Button size="small" color="error" disabled={busy} onClick={() => { if (event.recurrenceRule || event.seriesId) { setRecurringAction({ event, action: "delete" }); return; } if (window.confirm(`Delete event “${event.title}”?`)) action(() => ApiHelper.delete("/events/" + event.id, "ContentApi"), "Event deleted."); }} aria-label={"Delete " + event.title}>Delete</Button>
      </Stack>}
    </Stack>
  </Paper>;
  return <Container maxWidth="xl" sx={{ py: 4 }}><Stack spacing={3}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={2}>
      <Typography variant="h1">Calendars & scheduling</Typography>
      {canEdit && <Button variant="outlined" onClick={() => { setDialogError(""); setCalendarEdit(newCalendar()); }}>New calendar</Button>}
    </Stack>
    <Typography color="text.secondary">Plan church and group events with explicit local times, recurring schedules and occurrence exceptions. List view shows 90 days from the selected date.</Typography>
    {error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success">{message}</Alert>}
    {calendars.isError && <Alert severity="error">Calendars could not be loaded.</Alert>}
    <Paper sx={{ p: 3 }}><Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
        <TextField select label="Calendar" value={calendarId} onChange={e => setCalendarId(e.target.value)} sx={{ minWidth: 240 }}><MenuItem value="">Choose a calendar</MenuItem>{(calendars.data || []).map(c => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}</TextField>
        {selected && <Typography color="text.secondary">Times shown in {zone}</Typography>}
        {selected && canEdit && <><Button onClick={() => { setDialogError(""); setCalendarEdit({ ...selected }); }}>Edit calendar</Button><Button variant="contained" onClick={startEvent}>New event</Button></>}
      </Stack>
      {selected?.description && <Typography>{selected.description}</Typography>}
      {selected && <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
        <ToggleButtonGroup exclusive value={view} onChange={(_, value) => value && setView(value)} size="small" aria-label="Calendar view"><ToggleButton value="list">List</ToggleButton><ToggleButton value="week">Week</ToggleButton></ToggleButtonGroup>
        <Stack direction="row" alignItems="center" spacing={1}><Button onClick={() => setWeek(dayjs(week).subtract(7, "day").format("YYYY-MM-DD"))}>Previous week</Button><TextField size="small" label="View from" type="date" value={week} onChange={e => e.target.value && setWeek(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} /><Button onClick={() => setWeek(dayjs(week).add(7, "day").format("YYYY-MM-DD"))}>Next week</Button></Stack>
      </Stack>}
    </Stack></Paper>
    {events.isError && <Alert severity="error">Events could not be loaded.</Alert>}
    {selected && (view === "week" ? <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(7, minmax(0, 1fr))" }, gap: 1 }}>
      {days.map(date => <Paper key={date} sx={{ p: 1.5 }}><Stack spacing={1}><Typography variant="h3">{dayjs(date).format("ddd D")}</Typography>{(events.data || []).filter(e => occurs(e, date)).map(eventCard)}{!(events.data || []).some(e => occurs(e, date)) && <Typography variant="body2" color="text.secondary">No events</Typography>}</Stack></Paper>)}
    </Box> : <Stack spacing={2}>{(events.data || []).map(eventCard)}{!events.data?.length && !events.isLoading && <Typography color="text.secondary">No events in the selected window.</Typography>}</Stack>)}
    {!calendars.data?.length && !calendars.isLoading && <Typography color="text.secondary">No calendars yet.</Typography>}
    <Dialog open={!!calendarEdit} onClose={() => !busy && setCalendarEdit(null)} fullWidth maxWidth="sm">
      <Box component="form" onSubmit={e => { e.preventDefault(); action(async () => { const result = await ApiHelper.post("/calendars", [calendarEdit], "ContentApi"); setCalendarId(result[0].id); }, "Calendar saved.", () => setCalendarEdit(null)); }}>
        <DialogTitle>{calendarEdit?.id ? "Edit calendar" : "New calendar"}</DialogTitle><DialogContent><Stack spacing={3} sx={{ pt: 1 }}>
          {dialogError && <Alert severity="error">{dialogError}</Alert>}
          <TextField label="Calendar name" required value={calendarEdit?.name || ""} onChange={e => setCalendarEdit({ ...calendarEdit!, name: e.target.value })} />
          <TextField label="Description" multiline value={calendarEdit?.description || ""} onChange={e => setCalendarEdit({ ...calendarEdit!, description: e.target.value })} />
          <TextField label="Time zone" required value={calendarEdit?.timeZone || ""} onChange={e => setCalendarEdit({ ...calendarEdit!, timeZone: e.target.value })} helperText="IANA name, for example America/New_York or UTC." />
          <TextField label="Color" type="color" value={calendarEdit?.color || "#2563eb"} onChange={e => setCalendarEdit({ ...calendarEdit!, color: e.target.value })} />
          <TextField select label="Default group" value={calendarEdit?.groupId || ""} onChange={e => setCalendarEdit({ ...calendarEdit!, groupId: e.target.value || null })}><MenuItem value="">No group</MenuItem>{(groups.data || []).map(g => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}</TextField>
        </Stack></DialogContent><DialogActions>
          {calendarEdit?.id && <Button color="error" disabled={busy} onClick={() => { if (window.confirm("Delete this calendar? Calendars with events cannot be deleted.")) action(async () => { await ApiHelper.delete("/calendars/" + calendarEdit.id, "ContentApi"); setCalendarId(""); }, "Calendar deleted.", () => setCalendarEdit(null)); }}>Delete calendar</Button>}
          <Button onClick={() => setCalendarEdit(null)} disabled={busy}>Cancel</Button><Button type="submit" variant="contained" disabled={busy}>Save calendar</Button>
        </DialogActions>
      </Box>
    </Dialog>
    <Dialog open={!!recurringAction} onClose={() => setRecurringAction(null)} fullWidth maxWidth="xs">
      <DialogTitle>{recurringAction?.action === "delete" ? "Delete recurring event" : "Edit recurring event"}</DialogTitle>
      <DialogContent><Stack spacing={2}><Typography>Choose which occurrences of “{recurringAction?.event.title}” to {recurringAction?.action}. Deleting this and future occurrences also removes their occurrence edits.</Typography>
        <Button variant="outlined" onClick={() => applyRecurringAction("this")}>This event only</Button>
        <Button variant="outlined" onClick={() => applyRecurringAction("future")}>This and future events</Button>
        <Button variant="outlined" color={recurringAction?.action === "delete" ? "error" : "primary"} onClick={() => applyRecurringAction("all")}>Entire series</Button>
      </Stack></DialogContent><DialogActions><Button onClick={() => setRecurringAction(null)}>Cancel</Button></DialogActions>
    </Dialog>
    <Dialog open={!!eventEdit} onClose={() => !busy && setEventEdit(null)} fullWidth maxWidth="sm">
      <Box component="form" onSubmit={e => { e.preventDefault(); saveEvent(); }}><DialogTitle>{eventEdit?.id ? editScope === "this" ? "Edit this occurrence" : editScope === "future" ? "Edit this and future occurrences" : eventEdit.recurrenceRule ? "Edit entire series" : "Edit event" : "New event"}</DialogTitle><DialogContent><Stack spacing={3} sx={{ pt: 1 }}>
        {dialogError && <Alert severity="error">{dialogError}</Alert>}
        <TextField label="Event title" required value={eventEdit?.title || ""} onChange={e => setEventEdit({ ...eventEdit!, title: e.target.value })} />
        <TextField label="Description" multiline value={eventEdit?.description || ""} onChange={e => setEventEdit({ ...eventEdit!, description: e.target.value })} />
        <FormControlLabel label="All-day event" control={<Checkbox checked={!!eventEdit?.allDay} onChange={e => changeAllDay(e.target.checked)} />} />
        <Typography variant="body2" color="text.secondary">{eventEdit?.allDay ? "End date is exclusive: a one-day event ends on the following date." : `Enter local times in ${eventEdit?.timeZone}.`}</Typography>
        <TextField label="Start" type={eventEdit?.allDay ? "date" : "datetime-local"} required value={eventEdit?.start || ""} onChange={e => setEventEdit({ ...eventEdit!, start: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label={eventEdit?.allDay ? "End date (exclusive)" : "End"} type={eventEdit?.allDay ? "date" : "datetime-local"} required value={eventEdit?.end || ""} onChange={e => setEventEdit({ ...eventEdit!, end: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        {editScope !== "this" && <><FormControlLabel label="Recurring event" control={<Checkbox checked={!!eventEdit?.recurrenceRule} onChange={e => setEventEdit({ ...eventEdit!, recurrenceRule: e.target.checked ? "FREQ=WEEKLY;INTERVAL=1;COUNT=10" : null })} />} />
          {eventEdit?.recurrenceRule && <CalendarRecurrenceEditor value={eventEdit.recurrenceRule} start={eventEdit.start} onChange={value => setEventEdit(current => current ? { ...current, recurrenceRule: value } : current)} />}
          {eventEdit?.id && (eventEdit.recurrenceRule || eventEdit.exceptionDates?.length) && <FormControlLabel label="Reset skipped dates and occurrence edits affected by this schedule change" control={<Checkbox checked={resetExceptions} onChange={e => setResetExceptions(e.target.checked)} />} />}
          {editScope === "all" && !!eventEdit?.exceptionDates?.length && <Box><Typography variant="body2">Skipped or edited dates</Typography><Stack direction="row" flexWrap="wrap" gap={1}>{eventEdit.exceptionDates.map(date => <Button key={date} size="small" disabled={busy} onClick={() => {
            if (!window.confirm(`Restore the original occurrence on ${date}? Any replacement for that date will be removed.`)) return;
            action(async () => {
              const exceptions: { id: string; exceptionDate: string }[] = await ApiHelper.get(`/eventExceptions?eventId=${eventEdit.id}`, "ContentApi");
              const exception = exceptions.find(item => item.exceptionDate === date);
              if (exception) await ApiHelper.delete(`/eventExceptions/${exception.id}`, "ContentApi");
              setEventEdit(current => current ? { ...current, exceptionDates: current.exceptionDates?.filter(value => value !== date) } : current);
            }, "Original occurrence restored.");
          }}>Restore {date}</Button>)}</Stack></Box>}

        </>}
        <TextField label="Location" value={eventEdit?.location || ""} onChange={e => setEventEdit({ ...eventEdit!, location: e.target.value })} />
        <TextField select disabled={editScope === "this" || !!selected?.groupId} label="Group" value={eventEdit?.groupId || ""} onChange={e => setEventEdit({ ...eventEdit!, groupId: e.target.value || null })}><MenuItem value="">No group</MenuItem>{(groups.data || []).map(g => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}</TextField>
      </Stack></DialogContent><DialogActions><Button onClick={() => setEventEdit(null)} disabled={busy}>Cancel</Button><Button type="submit" variant="contained" disabled={busy}>Save event</Button></DialogActions></Box>
    </Dialog>
  </Stack></Container>;
}
