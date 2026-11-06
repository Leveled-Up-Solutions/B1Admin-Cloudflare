import React from "react";
import { Alert, Button, Checkbox, Container, FormControlLabel, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
import { Household, useHousehold } from "../people/components/Household";
import { hasCloudflarePermission } from "./permissions";
import { CloudflareGroupRequests } from "./CloudflareGroupRequests";
import { HouseholdEdit } from "../people/components/HouseholdEdit";
import type { GroupInterface, GroupMemberInterface, HouseholdInterface, PersonInterface } from "@churchapps/helpers";

export const displayName = (person?: PersonInterface) => person?.name?.display || [person?.name?.first, person?.name?.last].filter(Boolean).join(" ") || "Unknown person";
const errorMessage = (err: unknown) => err instanceof Error ? err.message : "The record could not be saved.";

type LocalPerson = PersonInterface & { contactInfo: PersonInterface["contactInfo"] & { country?: string } };
export function CloudflarePerson() {
  const { id } = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const personQuery = useQuery<LocalPerson>({ queryKey: ["/people/" + id, "MembershipApi"] });
  const households = useQuery<HouseholdInterface[]>({ queryKey: ["/households", "MembershipApi"] });
  const [person, setPerson] = React.useState<LocalPerson>();
  const household = useHousehold(personQuery.data || null);
  const [editingHousehold, setEditingHousehold] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const canEdit = UserHelper.checkAccess(Permissions.membershipApi.people.edit);
  React.useEffect(() => { if (personQuery.data) setPerson(structuredClone(personQuery.data)); }, [personQuery.data]);
  React.useEffect(() => setEditingHousehold(false), [id]);
  const finishHousehold = async () => {
    setEditingHousehold(false);
    await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "MembershipApi" });
    household.reload();
  };
  const updateName = (key: string, value: string) => setPerson(p => ({ ...p!, name: { ...p!.name, [key]: value } }));
  const updateContact = (key: string, value: string) => setPerson(p => ({ ...p!, contactInfo: { ...p!.contactInfo, [key]: value } }));
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await ApiHelper.post("/people", [{ ...person, name: { ...person!.name, display: [person!.name.first, person!.name.last].join(" ") } }], "MembershipApi");
      await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "MembershipApi" });
      setMessage("Person saved.");
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("Delete this synthetic person record?")) return;
    setBusy(true); setError("");
    try {
      await ApiHelper.delete("/people/" + id, "MembershipApi");
      navigate("/people");
      cache.removeQueries({ queryKey: ["/people/" + id, "MembershipApi"], exact: true });
      await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "MembershipApi" && q.queryKey[0] !== "/people/" + id });
    }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  }
  if (personQuery.isError) return <Container sx={{ py: 4 }}><Alert severity="error">Could not load this person.</Alert></Container>;
  if (!person) return <Container sx={{ py: 4 }}>Loading person…</Container>;
  return <Container maxWidth="md" sx={{ py: 4 }}><Stack spacing={3}>
    <Button component={Link} to="/people" sx={{ alignSelf: "flex-start" }}>← People</Button>
    <Typography variant="h1">{displayName(person)}</Typography>
    {error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success">{message}</Alert>}
    <Paper component="form" onSubmit={save} sx={{ p: 3 }}><Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="First name" value={person.name?.first || ""} onChange={e => updateName("first", e.target.value)} required disabled={!canEdit} fullWidth />
        <TextField label="Last name" value={person.name?.last || ""} onChange={e => updateName("last", e.target.value)} required disabled={!canEdit} fullWidth />
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="Middle name" value={person.name?.middle || ""} onChange={e => updateName("middle", e.target.value)} disabled={!canEdit} fullWidth />
        <TextField label="Preferred name" value={person.name?.nick || ""} onChange={e => updateName("nick", e.target.value)} disabled={!canEdit} fullWidth />
      </Stack>
      <TextField label="Email" type="email" value={person.contactInfo?.email || ""} onChange={e => updateContact("email", e.target.value)} disabled={!canEdit} />
      <TextField label="Mobile phone" value={person.contactInfo?.mobilePhone || ""} onChange={e => updateContact("mobilePhone", e.target.value)} disabled={!canEdit} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="Home phone" value={person.contactInfo?.homePhone || ""} onChange={e => updateContact("homePhone", e.target.value)} disabled={!canEdit} fullWidth />
        <TextField label="Work phone" value={person.contactInfo?.workPhone || ""} onChange={e => updateContact("workPhone", e.target.value)} disabled={!canEdit} fullWidth />
      </Stack>
      <TextField label="Address" value={person.contactInfo?.address1 || ""} onChange={e => updateContact("address1", e.target.value)} disabled={!canEdit} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="City" value={person.contactInfo?.city || ""} onChange={e => updateContact("city", e.target.value)} disabled={!canEdit} fullWidth />
        <TextField label="State" value={person.contactInfo?.state || ""} onChange={e => updateContact("state", e.target.value)} disabled={!canEdit} />
        <TextField label="Postal code" value={person.contactInfo?.zip || ""} onChange={e => updateContact("zip", e.target.value)} disabled={!canEdit} />
      </Stack>
      <TextField label="Address line 2" value={person.contactInfo?.address2 || ""} onChange={e => updateContact("address2", e.target.value)} disabled={!canEdit} />
      <TextField label="Country" value={person.contactInfo?.country || ""} onChange={e => updateContact("country", e.target.value)} disabled={!canEdit} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="Birth date" type="date" value={String(person.birthDate || "").slice(0, 10)} onChange={e => setPerson({ ...person, birthDate: e.target.value })} disabled={!canEdit} slotProps={{ inputLabel: { shrink: true } }} fullWidth />
        <TextField select label="Gender" value={person.gender || ""} onChange={e => setPerson({ ...person, gender: e.target.value })} disabled={!canEdit} fullWidth>
          <MenuItem value="">Unspecified</MenuItem><MenuItem value="Male">Male</MenuItem><MenuItem value="Female">Female</MenuItem>
        </TextField>
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
        <TextField label="Marital status" value={person.maritalStatus || ""} onChange={e => setPerson({ ...person, maritalStatus: e.target.value })} disabled={!canEdit} fullWidth />
        <TextField label="Anniversary" type="date" value={String(person.anniversary || "").slice(0, 10)} onChange={e => setPerson({ ...person, anniversary: e.target.value })} disabled={!canEdit} slotProps={{ inputLabel: { shrink: true } }} fullWidth />
      </Stack>
      <TextField label="Membership status" value={person.membershipStatus || ""} onChange={e => setPerson({ ...person, membershipStatus: e.target.value })} disabled={!canEdit} />
      <TextField select label="Household" value={person.householdId || ""} onChange={e => setPerson({ ...person, householdId: e.target.value || undefined })} disabled={!canEdit}>
        <MenuItem value="">Unassigned</MenuItem>{(households.data || []).map(h => <MenuItem key={h.id} value={h.id}>{h.name}</MenuItem>)}
      </TextField>
      {canEdit && <Stack direction="row" spacing={2}><Button variant="contained" type="submit" disabled={busy}>Save person</Button>{id !== UserHelper.person?.id && <Button color="error" onClick={remove} disabled={busy}>Delete person</Button>}</Stack>}
    </Stack></Paper>
    <Paper sx={{ p: 3 }}>
      {editingHousehold && household.household && household.members
        ? <HouseholdEdit household={household.household} currentMembers={household.members} currentPerson={person} updatedFunction={finishHousehold} />
        : <Household person={person} household={household.household} members={household.members} onEdit={() => setEditingHousehold(true)} />}
    </Paper>
  </Stack></Container>;
}

type LocalGroup = GroupInterface & { parentId?: string; joinPolicy?: "open" | "request" | "closed" };
export function CloudflareGroup() {
  const { id } = useParams();
  const cache = useQueryClient();
  const globalEdit = UserHelper.checkAccess(Permissions.membershipApi.groups.edit);
  const canEdit = globalEdit || hasCloudflarePermission(Permissions.membershipApi.groups.edit, id);
  const canManage = canEdit || UserHelper.checkAccess(Permissions.membershipApi.groupMembers.edit) || hasCloudflarePermission(Permissions.membershipApi.groupMembers.edit, id);
  const canViewMembers = canManage || UserHelper.checkAccess(Permissions.membershipApi.groupMembers.view) || hasCloudflarePermission(Permissions.membershipApi.groupMembers.view, id);
  const canSearchPeople = UserHelper.checkAccess(Permissions.membershipApi.people.view) || UserHelper.checkAccess(Permissions.membershipApi.people.edit) || UserHelper.checkAccess(Permissions.membershipApi.people.viewNames);
  const allGroups = useQuery<LocalGroup[]>({ queryKey: ["/groups", "MembershipApi"] });
  const groupQuery = useQuery<LocalGroup>({ queryKey: ["/groups/" + id, "MembershipApi"] });
  const members = useQuery<GroupMemberInterface[]>({ queryKey: ["/groupmembers?groupId=" + id, "MembershipApi"], enabled: canViewMembers });
  const people = useQuery<PersonInterface[]>({ queryKey: ["/people/list", "MembershipApi"], enabled: canSearchPeople });
  const [group, setGroup] = React.useState<LocalGroup>();
  const [personId, setPersonId] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (groupQuery.data) setGroup(structuredClone(groupQuery.data)); }, [groupQuery.data]);
  async function action(fn: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); await cache.invalidateQueries({ predicate: q => q.queryKey[1] === "MembershipApi" }); setMessage(success); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  if (groupQuery.isError) return <Container sx={{ py: 4 }}><Alert severity="error">Could not load this group.</Alert></Container>;
  if (!group) return <Container sx={{ py: 4 }}>Loading group…</Container>;
  const canReviewRequests = UserHelper.checkAccess(Permissions.membershipApi.groupMembers.edit) || hasCloudflarePermission(Permissions.membershipApi.groupMembers.edit, id) || !!members.data?.some(member => member.personId === UserHelper.person?.id && member.leader);
  const available = (people.data || []).filter(p => !members.data?.some(m => m.personId === p.id));
  return <Container maxWidth="md" sx={{ py: 4 }}><Stack spacing={3}>
    <Button component={Link} to="/groups" sx={{ alignSelf: "flex-start" }}>← Groups</Button><Typography variant="h1">{group.name}</Typography>
    {error && <Alert severity="error">{error}</Alert>}{message && <Alert severity="success">{message}</Alert>}
    <Paper component="form" onSubmit={e => { e.preventDefault(); action(() => ApiHelper.post("/groups", [group], "MembershipApi"), "Group saved."); }} sx={{ p: 3 }}><Stack spacing={2}>
      <TextField label="Group name" value={group.name || ""} onChange={e => setGroup({ ...group, name: e.target.value })} required disabled={!canEdit} />
      <TextField label="Category" value={group.categoryName || ""} onChange={e => setGroup({ ...group, categoryName: e.target.value })} disabled={!canEdit} />
      <TextField select label="Parent group" value={group.parentId || ""} onChange={e => setGroup({ ...group, parentId: e.target.value || undefined })} disabled={!globalEdit}>
        <MenuItem value="">No parent</MenuItem>{(allGroups.data || []).filter(item => item.id !== id).map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
      </TextField>
      <TextField label="Meeting time" value={group.meetingTime || ""} onChange={e => setGroup({ ...group, meetingTime: e.target.value })} disabled={!canEdit} />
      <TextField label="Meeting location" value={group.meetingLocation || ""} onChange={e => setGroup({ ...group, meetingLocation: e.target.value })} disabled={!canEdit} />
      <TextField select label="Joining this group" value={group.joinPolicy || "closed"} onChange={e => setGroup({ ...group, joinPolicy: e.target.value as LocalGroup["joinPolicy"] })} disabled={!canEdit}>
        <MenuItem value="closed">By invitation only</MenuItem><MenuItem value="request">Request approval</MenuItem><MenuItem value="open">Members can join</MenuItem>
      </TextField>
      <FormControlLabel control={<Checkbox checked={!!group.archived} onChange={e => setGroup({ ...group, archived: e.target.checked })} disabled={!canEdit} />} label="Archived" />
      {canEdit && <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: "flex-start" }}>Save group</Button>}
    </Stack></Paper>
    <Paper sx={{ p: 3 }}><Stack spacing={2}>
      {canReviewRequests && <CloudflareGroupRequests groupId={id} />}
      <Typography variant="h2">Members</Typography>
      <Table><TableHead><TableRow><TableCell>Name</TableCell><TableCell>Leader</TableCell><TableCell /></TableRow></TableHead><TableBody>
        {(members.data || []).map(m => <TableRow key={m.id}><TableCell>{canSearchPeople ? <Button component={Link} to={"/people/" + m.personId}>{displayName(m.person || people.data?.find(p => p.id === m.personId))}</Button> : <Typography>{displayName(m.person)}</Typography>}</TableCell>
          <TableCell><Checkbox inputProps={{ "aria-label": "Group leader" }} checked={!!m.leader} disabled={!canManage || busy} onChange={e => action(() => ApiHelper.post("/groupmembers", [{ ...m, leader: e.target.checked }], "MembershipApi"), "Member updated.")} /></TableCell>
          <TableCell>{canManage && <Button color="error" disabled={busy} onClick={() => action(() => ApiHelper.delete("/groupmembers/" + m.id, "MembershipApi"), "Member removed.")}>Remove</Button>}</TableCell></TableRow>)}
      </TableBody></Table>
      {!canViewMembers && <Typography color="text.secondary">You do not have permission to view this group’s roster.</Typography>}
      {canViewMembers && !members.data?.length && <Typography color="text.secondary">No members yet.</Typography>}
      {canManage && canSearchPeople && <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={2} onSubmit={e => { e.preventDefault(); action(() => ApiHelper.post("/groupmembers", [{ groupId: id, personId, leader: false }], "MembershipApi"), "Member added."); setPersonId(""); }}>
        <TextField select label="Person to add" value={personId} onChange={e => setPersonId(e.target.value)} required fullWidth><MenuItem value="">Choose a person</MenuItem>{available.map(p => <MenuItem key={p.id} value={p.id}>{displayName(p)}</MenuItem>)}</TextField>
        <Button type="submit" variant="contained" disabled={!personId || busy}>Add member</Button>
      </Stack>}
    </Stack></Paper>
  </Stack></Container>;
}
