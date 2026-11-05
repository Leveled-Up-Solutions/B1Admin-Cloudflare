import React from "react";
import { Alert, Box, Button, Container, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Checkbox, MenuItem, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
import type { GroupInterface } from "@churchapps/helpers";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

type Calendar = { id?: string; name: string; description: string; color: string; timeZone: string; groupId: string | null };
type CalendarEvent = { id?: string; calendarId: string; groupId: string | null; title: string; description: string; start: string; end: string; allDay: boolean; location: string; timeZone: string };
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
  const events = useQuery<CalendarEvent[]>({ queryKey: ["/events?calendarId=" + calendarId, "ContentApi"], enabled: !!calendarId });
  const [calendarEdit, setCalendarEdit] = React.useState<Calendar | null>(null);
  const [eventEdit, setEventEdit] = React.useState<CalendarEvent | null>(null);
  const [view, setView] = React.useState("list");
  const [week, setWeek] = React.useState(() => dayjs().subtract((dayjs().day() + 6) % 7, "day").format("YYYY-MM-DD"));
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
    try { await fn(); await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "ContentApi" }); close?.(); setMessage(success); }
    catch (err) { const text = err instanceof Error ? err.message : "The change could not be saved."; if (calendarEdit || eventEdit) setDialogError(text); else setError(text); }
    finally { setBusy(false); }
  }
  function editEvent(event: CalendarEvent) {
    setDialogError("");
    setEventEdit({ ...event, start: event.allDay ? event.start : inputTime(event.start, event.timeZone), end: event.allDay ? event.end : inputTime(event.end, event.timeZone) });
  }
  function startEvent() {
    const start = dayjs().tz(zone).add(1, "day").hour(9).minute(0);
    setDialogError("");
    setEventEdit({ calendarId, groupId: selected?.groupId || null, title: "", description: "", start: start.format("YYYY-MM-DDTHH:mm"), end: start.add(1, "hour").format("YYYY-MM-DDTHH:mm"), allDay: false, location: "", timeZone: zone });
  }
  function toUtc(value: string, timeZone: string) {
    const parsed = dayjs.tz(value, timeZone);
    if (!parsed.isValid() || parsed.format("YYYY-MM-DDTHH:mm") !== value) throw new Error("This time does not exist in the selected time zone. Choose another time.");
    return parsed.toISOString();
  }
  async function saveEvent() {
    const item = eventEdit!;
    await action(async () => {
      const start = item.allDay ? item.start : toUtc(item.start, item.timeZone);
      const end = item.allDay ? item.end : toUtc(item.end, item.timeZone);
      if (end <= start) throw new Error("The event must end after it starts.");
      await ApiHelper.post("/events", [{ ...item, start, end }], "ContentApi");
    }, "Event saved.", () => setEventEdit(null));
  }
  const days = Array.from({ length: 7 }, (_, i) => dayjs(week).add(i, "day").format("YYYY-MM-DD"));
  function occurs(event: CalendarEvent, date: string) {
    const start = datePart(event.start, zone);
    const end = datePart(event.end, zone);
    return start <= date && (event.allDay ? end > date : end >= date);
  }
  const eventCard = (event: CalendarEvent) => <Paper key={event.id} variant="outlined" sx={{ p: 2, borderLeft: 4, borderLeftColor: selected?.color || "primary.main" }}>
    <Stack spacing={1}>
      <Typography fontWeight={600}>{event.title}</Typography>
      <Typography variant="body2" color="text.secondary">{event.allDay ? `${event.start} – ${event.end} (end exclusive)` : `${dayjs(event.start).tz(zone).format("MMM D, YYYY HH:mm")} – ${dayjs(event.end).tz(zone).format("MMM D, YYYY HH:mm")}`}</Typography>
      {event.location && <Typography variant="body2">{event.location}</Typography>}
      {event.groupId && <Typography variant="body2" color="text.secondary">Group: {groups.data?.find(g => g.id === event.groupId)?.name || "Group"}</Typography>}
      {event.description && <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{event.description}</Typography>}
      {canEdit && <Stack direction="row" spacing={1}>
        <Button size="small" onClick={() => editEvent(event)} aria-label={"Edit " + event.title}>Edit</Button>
        <Button size="small" color="error" disabled={busy} onClick={() => { if (window.confirm(`Delete event “${event.title}”?`)) action(() => ApiHelper.delete("/events/" + event.id, "ContentApi"), "Event deleted."); }} aria-label={"Delete " + event.title}>Delete</Button>
      </Stack>}
    </Stack>
  </Paper>;
  return <Container maxWidth="xl" sx={{ py: 4 }}><Stack spacing={3}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={2}>
      <Typography variant="h1">Calendars & scheduling</Typography>
      {canEdit && <Button variant="outlined" onClick={() => { setDialogError(""); setCalendarEdit(newCalendar()); }}>New calendar</Button>}
    </Stack>
    <Typography color="text.secondary">Plan church and group events with explicit times, locations and time zones. Recurring events, volunteer assignments, booking approvals and invitations are not included yet.</Typography>
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
        {view === "week" && <Stack direction="row" alignItems="center" spacing={1}><Button onClick={() => setWeek(dayjs(week).subtract(7, "day").format("YYYY-MM-DD"))}>Previous week</Button><Typography>{dayjs(week).format("MMM D, YYYY")}</Typography><Button onClick={() => setWeek(dayjs(week).add(7, "day").format("YYYY-MM-DD"))}>Next week</Button></Stack>}
      </Stack>}
    </Stack></Paper>
    {events.isError && <Alert severity="error">Events could not be loaded.</Alert>}
    {selected && (view === "week" ? <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(7, minmax(0, 1fr))" }, gap: 1 }}>
      {days.map(date => <Paper key={date} sx={{ p: 1.5 }}><Stack spacing={1}><Typography variant="h3">{dayjs(date).format("ddd D")}</Typography>{(events.data || []).filter(e => occurs(e, date)).map(eventCard)}{!(events.data || []).some(e => occurs(e, date)) && <Typography variant="body2" color="text.secondary">No events</Typography>}</Stack></Paper>)}
    </Box> : <Stack spacing={2}>{(events.data || []).map(eventCard)}{!events.data?.length && !events.isLoading && <Typography color="text.secondary">No events in this calendar. Create an event to start scheduling.</Typography>}</Stack>)}
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
    <Dialog open={!!eventEdit} onClose={() => !busy && setEventEdit(null)} fullWidth maxWidth="sm">
      <Box component="form" onSubmit={e => { e.preventDefault(); saveEvent(); }}><DialogTitle>{eventEdit?.id ? "Edit event" : "New event"}</DialogTitle><DialogContent><Stack spacing={3} sx={{ pt: 1 }}>
        {dialogError && <Alert severity="error">{dialogError}</Alert>}
        <TextField label="Event title" required value={eventEdit?.title || ""} onChange={e => setEventEdit({ ...eventEdit!, title: e.target.value })} />
        <TextField label="Description" multiline value={eventEdit?.description || ""} onChange={e => setEventEdit({ ...eventEdit!, description: e.target.value })} />
        <FormControlLabel label="All-day event" control={<Checkbox checked={!!eventEdit?.allDay} onChange={e => setEventEdit({ ...eventEdit!, allDay: e.target.checked, start: e.target.checked ? eventEdit!.start.slice(0, 10) : eventEdit!.start + "T09:00", end: e.target.checked ? dayjs(eventEdit!.end.slice(0, 10)).add(1, "day").format("YYYY-MM-DD") : eventEdit!.end + "T09:00" })} />} />
        <Typography variant="body2" color="text.secondary">{eventEdit?.allDay ? "End date is exclusive: a one-day event ends on the following date." : `Enter local times in ${eventEdit?.timeZone}.`}</Typography>
        <TextField label="Start" type={eventEdit?.allDay ? "date" : "datetime-local"} required value={eventEdit?.start || ""} onChange={e => setEventEdit({ ...eventEdit!, start: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label={eventEdit?.allDay ? "End date (exclusive)" : "End"} type={eventEdit?.allDay ? "date" : "datetime-local"} required value={eventEdit?.end || ""} onChange={e => setEventEdit({ ...eventEdit!, end: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="Location" value={eventEdit?.location || ""} onChange={e => setEventEdit({ ...eventEdit!, location: e.target.value })} />
        <TextField select label="Group" value={eventEdit?.groupId || ""} onChange={e => setEventEdit({ ...eventEdit!, groupId: e.target.value || null })}><MenuItem value="">No group</MenuItem>{(groups.data || []).map(g => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}</TextField>
      </Stack></DialogContent><DialogActions><Button onClick={() => setEventEdit(null)} disabled={busy}>Cancel</Button><Button type="submit" variant="contained" disabled={busy}>Save event</Button></DialogActions></Box>
    </Dialog>
  </Stack></Container>;
}
