import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Container, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
interface ChurchSettings { id: string; name: string; timeZone: string; directoryApprovalGroupId: string }
export function CloudflareChurchSettings() {
  const cache = useQueryClient();
  const query = useQuery<ChurchSettings>({ queryKey: ["/churches/current", "MembershipApi"] });
  const [settings, setSettings] = useState<ChurchSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const canEdit = UserHelper.checkAccess(Permissions.membershipApi.settings.edit);
  const groups = useQuery<{ id: string; name: string }[]>({ queryKey: ["/churches/directoryReviewGroups", "MembershipApi"], enabled: canEdit });
  useEffect(() => { if (query.data) setSettings({ id: query.data.id, name: query.data.name, timeZone: query.data.timeZone, directoryApprovalGroupId: query.data.directoryApprovalGroupId || "" }); }, [query.data]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setMessage(""); setError("");
    try {
      await ApiHelper.post("/churches", [settings], "MembershipApi");
      await cache.invalidateQueries({ queryKey: ["/churches/current", "MembershipApi"] });
      setMessage("Church settings saved.");
    } catch {
      setError("Could not save settings. Refresh and check the time zone and active review group before trying again.");
    } finally { setBusy(false); }
  }
  return <Container maxWidth="sm" sx={{ py: 4 }}><Paper component="form" onSubmit={save} sx={{ p: 3 }}><Stack spacing={3}>
    <Typography variant="h1">Church settings</Typography>
    {query.isError && <Alert severity="error">Could not load church settings.</Alert>}
    {message && <Alert severity="success">{message}</Alert>}{error && <Alert severity="error">{error}</Alert>}
    <TextField label="Church name" value={settings?.name || ""} onChange={e => settings && setSettings({ ...settings, name: e.target.value })} disabled={!canEdit || busy} required />
    <TextField label="Church time zone" value={settings?.timeZone || ""} onChange={e => settings && setSettings({ ...settings, timeZone: e.target.value })} disabled={!canEdit || busy} required helperText="Use an IANA name, for example America/Chicago. Service plan copies preserve local times in this zone. Calendars keep their own time zones." />
    {groups.isError && <Alert severity="error">Could not load review groups. Refresh before selecting a group.</Alert>}
    <TextField select label="Directory approval group" value={settings?.directoryApprovalGroupId || ""} onChange={e => settings && setSettings({ ...settings, directoryApprovalGroupId: e.target.value })} disabled={!canEdit || busy || groups.isLoading} helperText="Choose a group to review members' own profile changes and new family additions. Reviewers also need People Edit permission.">
      <MenuItem value="">No review group</MenuItem>
      {(groups.data || []).map(group => <MenuItem key={group.id} value={group.id}>{group.name}</MenuItem>)}
      {settings?.directoryApprovalGroupId && !(groups.data || []).some(group => group.id === settings.directoryApprovalGroupId) && <MenuItem value={settings.directoryApprovalGroupId} disabled>{canEdit ? "Unavailable review group — select a replacement or clear it" : "Configured review group"}</MenuItem>}
    </TextField>
    <Typography variant="body2" color="text.secondary">With no review group, members save their own profile changes and new family additions directly. Changes to an existing family member always require staff review. Changing this setting keeps pending requests, but they must be cancelled or declined and submitted again under the new policy.</Typography>
    {canEdit && <Button type="submit" variant="contained" disabled={busy || !settings}>Save church settings</Button>}
  </Stack></Paper></Container>;
}
