import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Container, Paper, Stack, TextField, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
interface ChurchSettings { id: string; name: string; timeZone: string }
export function CloudflareChurchSettings() {
  const cache = useQueryClient();
  const query = useQuery<ChurchSettings>({ queryKey: ["/churches/current", "MembershipApi"] });
  const [settings, setSettings] = useState<ChurchSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canEdit = UserHelper.checkAccess(Permissions.membershipApi.settings.edit);
  useEffect(() => { if (query.data) setSettings({ id: query.data.id, name: query.data.name, timeZone: query.data.timeZone }); }, [query.data]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setMessage(""); setError("");
    try {
      await ApiHelper.post("/churches", [settings], "MembershipApi");
      await cache.invalidateQueries({ queryKey: ["/churches/current", "MembershipApi"] });
      setMessage("Church settings saved.");
    } catch { setError("Could not save settings. Use a valid IANA time zone such as America/Chicago."); }
    finally { setBusy(false); }
  }
  return <Container maxWidth="sm" sx={{ py: 4 }}><Paper component="form" onSubmit={save} sx={{ p: 3 }}><Stack spacing={3}>
    <Typography variant="h1">Church settings</Typography>
    {query.isError && <Alert severity="error">Could not load church settings.</Alert>}
    {message && <Alert severity="success">{message}</Alert>}{error && <Alert severity="error">{error}</Alert>}
    <TextField label="Church name" value={settings?.name || ""} onChange={e => settings && setSettings({ ...settings, name: e.target.value })} disabled={!canEdit || busy} required />
    <TextField label="Church time zone" value={settings?.timeZone || ""} onChange={e => settings && setSettings({ ...settings, timeZone: e.target.value })} disabled={!canEdit || busy} required helperText="Use an IANA name, for example America/Chicago. Service plan copies preserve local times in this zone. Calendars keep their own time zones." />
    {canEdit && <Button type="submit" variant="contained" disabled={busy || !settings}>Save church settings</Button>}
  </Stack></Paper></Container>;
}
