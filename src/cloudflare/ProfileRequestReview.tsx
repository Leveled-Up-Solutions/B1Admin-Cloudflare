import React from "react";
import { UserHelper } from "@churchapps/apphelper";
import { Alert, Box, Button, Card, CardContent, Stack, TextField, Typography } from "@mui/material";
import { memberErrorMessage, memberRequest, memberSessionExpired } from "./memberApi";

export interface ProfileChangeRequest {
  id: string; taskId: string; kind: "profile" | "family-add" | "family-edit";
  status: "pending" | "approved" | "declined" | "cancelled";
  target: { id: string | null; name: { display: string } };
  requester: { id: string; name: { display: string } };
  changes: Record<string, string | null>; createdAt: string; decidedAt: string | null; reason: string | null; canReview: boolean;
}
export const profileFieldLabels: Record<string, string> = {
  firstName: "First name",
  first: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  last: "Last name",
  nickName: "Preferred name",
  mobilePhone: "Mobile phone",
  homePhone: "Home phone",
  address1: "Address line 1",
  address2: "Address line 2",
  city: "City",
  state: "State or region",
  zip: "Postal code",
  birthDate: "Birth date",
  householdRole: "Household role"
};
interface CardProps { request: ProfileChangeRequest; token?: string; canCancel?: boolean; onChanged?: () => void; onExpired?: () => void }

export const ProfileRequestCard = ({ request, token, canCancel = false, onChanged, onExpired }: CardProps) => {
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
  const [declining, setDeclining] = React.useState(false), [reason, setReason] = React.useState("");
  const [updated, setUpdated] = React.useState<ProfileChangeRequest | null>(null);
  const row = updated || request;
  async function act(action: "approve" | "decline" | "cancel") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const bearer = token === undefined ? UserHelper.currentUserChurch?.jwt || "" : token;
      if (!bearer) throw new Error("Sign in again before reviewing changes.");
      const result = await memberRequest<ProfileChangeRequest>(`/api/member/v1/profile-requests/${encodeURIComponent(row.id)}${action === "cancel" ? "" : `/${action}`}`, bearer, { method: action === "cancel" ? "DELETE" : "POST", ...(action === "cancel" ? {} : { body: JSON.stringify(action === "decline" ? { reason } : {}) }) });
      setUpdated(result); setDeclining(false); setReason(""); onChanged?.();
    } catch (problem) { if (memberSessionExpired(problem)) onExpired?.(); setError(memberErrorMessage(problem)); } finally { setBusy(false); }
  }
  return <Card variant="outlined" data-testid={`profile-request-${row.id}`} sx={{ my: 2 }}><CardContent>
    <Typography variant="h2" sx={{ fontSize: "1.25rem", mb: 1 }}>{row.kind === "family-add" ? "Add family member" : row.kind === "family-edit" ? "Family member changes" : "Profile changes"}: {row.target.name.display}</Typography>
    <Typography>Requested by {row.requester.name.display}</Typography><Typography><strong>Status:</strong> {row.status}</Typography>
    <Typography variant="body2" color="text.secondary">{new Date(row.createdAt).toLocaleString()}</Typography>
    <Box component="dl" sx={{ overflowWrap: "anywhere" }}>{Object.entries(row.changes).map(([field, value]) => <React.Fragment key={field}><Box component="dt" sx={{ fontWeight: 600 }}>{profileFieldLabels[field] || field}</Box><Box component="dd" sx={{ ml: 0, mb: 1 }}>{value === null || value === "" ? "Clear this field" : value}</Box></React.Fragment>)}</Box>
    {row.reason && <Typography>Reason: {row.reason}</Typography>}
    {error && <Alert severity="error">{error}</Alert>}
    {row.status === "pending" && <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ mt: 2 }}>
      {row.canReview && <><Button variant="contained" disabled={busy} onClick={() => act("approve")}>Approve changes</Button><Button disabled={busy} onClick={() => setDeclining(true)}>Decline changes</Button></>}
      {canCancel && <Button disabled={busy} onClick={() => act("cancel")}>Cancel request</Button>}
    </Stack>}
    {declining && <Stack component="form" spacing={2} sx={{ mt: 2 }} onSubmit={event => { event.preventDefault(); act("decline"); }}>
      <TextField label="Reason shown to requester" value={reason} onChange={event => setReason(event.target.value)} multiline minRows={2} slotProps={{ htmlInput: { maxLength: 500 } }} disabled={busy} />
      <Stack direction="row" spacing={1}><Button type="submit" variant="contained" disabled={busy}>Confirm decline</Button><Button disabled={busy} onClick={() => setDeclining(false)}>Keep pending</Button></Stack>
    </Stack>}
  </CardContent></Card>;
};

interface ReviewProps { requestId?: string; taskId?: string; token?: string; onChanged?: () => void; onExpired?: () => void }
/** Shared by the member portal and the original protected My Work task page. */
export const ProfileRequestReview = ({ requestId, taskId, token, onChanged, onExpired }: ReviewProps) => {
  const bearer = token === undefined ? UserHelper.currentUserChurch?.jwt || "" : token;
  const [row, setRow] = React.useState<ProfileChangeRequest | null>(null), [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController(); let current = true; setRow(null); setError("");
    const path = taskId ? `task/${encodeURIComponent(taskId)}` : encodeURIComponent(requestId || "");
    memberRequest<ProfileChangeRequest>(`/api/member/v1/profile-requests/${path}`, bearer, { signal: controller.signal })
      .then(result => { if (current) setRow(result); })
      .catch(problem => { if (current) { if (memberSessionExpired(problem)) onExpired?.(); setError(memberErrorMessage(problem)); } });
    return () => { current = false; controller.abort(); };
  }, [requestId, taskId, bearer, retry, onExpired]);
  if (error) return <Alert severity="error" action={<Button onClick={() => setRetry(value => value + 1)}>Try again</Button>}>{error}</Alert>;
  if (!row) return <Typography role="status">Loading proposed changes…</Typography>;
  return <ProfileRequestCard request={row} token={bearer} onChanged={onChanged} onExpired={onExpired} />;
};
