import { Box, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";

// Same RRULE fields as ChurchApps' RRuleEditor, with civil-date UNTIL and no browser-zone conversion.
export function CalendarRecurrenceEditor({ value, start, onChange }: { value: string; start: string; onChange: (value: string) => void }) {
  const fields: Record<string, string> = Object.fromEntries(value.replace(/^RRULE:/, "").split(";").map(part => part.split("=")));
  const date = new Date(start.slice(0, 10) + "T12:00:00Z");
  const day = Number.isNaN(date.getTime()) ? 1 : date.getUTCDate();
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getUTCDay()] || "MO";
  function change(values: Record<string, string | undefined>) {
    const next = { ...fields, ...values };
    onChange(Object.entries(next).filter(([, val]) => !!val).map(([key, val]) => `${key}=${val}`).join(";"));
  }
  const ends = fields.COUNT ? "count" : fields.UNTIL ? "date" : "never";
  const weekdays = fields.BYDAY?.split(",") || [weekday];
  const dayNames: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
  const ordinal = (value: string) => value === "-1" ? "last" : Number(value) < 0 ? `${Math.abs(Number(value))} from last` : (value === "1" ? "1st" : value === "2" ? "2nd" : value === "3" ? "3rd" : `${value}th`);
  const monthlyWeekdays = (fields.BYDAY || weekday).split(",").map(code => { const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(code); return match ? `${match[1] ? ordinal(match[1]) + " " : ""}${dayNames[match[2]] || match[2]}` : code; }).join(", ");
  const monthlyPosition = fields.BYSETPOS ? fields.BYSETPOS.split(",").map(ordinal).join(", ") : fields.BYDAY ? "" : ordinal(String(Math.floor((day - 1) / 7) + 1));
  return <Stack spacing={2}>
    <Stack direction="row" spacing={2}>
      <TextField label="Repeat every" type="number" value={fields.INTERVAL || "1"} slotProps={{ htmlInput: { min: 1, max: 366 } }} onChange={e => change({ INTERVAL: e.target.value })} />
      <TextField select fullWidth label="Frequency" value={fields.FREQ || "WEEKLY"} onChange={e => change({ FREQ: e.target.value, BYDAY: e.target.value === "WEEKLY" ? weekday : undefined, BYMONTHDAY: e.target.value === "MONTHLY" ? String(day) : undefined, BYSETPOS: undefined, BYMONTH: undefined })}>
        <MenuItem value="DAILY">Days</MenuItem><MenuItem value="WEEKLY">Weeks</MenuItem><MenuItem value="MONTHLY">Months</MenuItem><MenuItem value="YEARLY">Years</MenuItem>
      </TextField>
    </Stack>
    {fields.FREQ === "WEEKLY" && <Box><Typography variant="body2" sx={{ mb: 1 }}>On weekdays</Typography><Stack direction="row" flexWrap="wrap" gap={0.5}>{["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((code, i) => <Button key={code} size="small" aria-label={"Repeat on " + ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]} aria-pressed={weekdays.includes(code)} variant={weekdays.includes(code) ? "contained" : "outlined"} onClick={() => { const next = weekdays.includes(code) ? weekdays.filter(item => item !== code) : [...weekdays, code]; if (next.length) change({ BYDAY: next.join(",") }); }}>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</Button>)}</Stack></Box>}
    {fields.FREQ === "MONTHLY" && <TextField select label="Monthly pattern" value={fields.BYDAY ? "weekday" : "date"} onChange={e => change(e.target.value === "date" ? { BYMONTHDAY: String(day), BYDAY: undefined, BYSETPOS: undefined } : { BYMONTHDAY: undefined, BYDAY: weekday, BYSETPOS: String(Math.floor((day - 1) / 7) + 1) })}>
      <MenuItem value="date">On day {fields.BYMONTHDAY || day} of the month</MenuItem><MenuItem value="weekday">On {monthlyPosition} {monthlyWeekdays}</MenuItem>
    </TextField>}
    <Stack direction="row" spacing={2}>
      <TextField select fullWidth label="Recurrence ends" value={ends} onChange={e => change({ COUNT: e.target.value === "count" ? "10" : undefined, UNTIL: e.target.value === "date" ? start.slice(0, 10).replaceAll("-", "") : undefined })}><MenuItem value="never">Never</MenuItem><MenuItem value="count">After a count</MenuItem><MenuItem value="date">On a date</MenuItem></TextField>
      {ends === "count" && <TextField label="Occurrences" type="number" value={fields.COUNT} slotProps={{ htmlInput: { min: 1, max: 1000 } }} onChange={e => change({ COUNT: e.target.value })} />}
      {ends === "date" && <TextField label="Last occurrence date" type="date" value={fields.UNTIL?.slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")} slotProps={{ inputLabel: { shrink: true } }} onChange={e => change({ UNTIL: e.target.value.replaceAll("-", "") })} />}
    </Stack>
    <Typography variant="body2" color="text.secondary">Times stay local in the event time zone. Nonexistent daylight-saving times and missing month dates are skipped. End dates are inclusive.</Typography>
  </Stack>;
}
