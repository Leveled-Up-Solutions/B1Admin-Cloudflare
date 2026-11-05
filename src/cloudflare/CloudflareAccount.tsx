import React from "react";
import { Alert, Button, Container, Paper, Stack, TextField, Typography } from "@mui/material";
import { ApiHelper, UserHelper } from "@churchapps/apphelper";

interface Props {
  onSessionsRevoked: () => void;
  /** The member portal keeps a separate session instead of using UserHelper. */
  token?: string;
  email?: string;
}

export const CloudflareAccount = ({ onSessionsRevoked, token, email }: Props) => {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [changed, setChanged] = React.useState(false);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy || changed) return;
    setError("");
    if (!currentPassword) { setError("Enter your current password."); return; }
    if ([...newPassword].length < 12 || [...newPassword].length > 128) { setError("Use a password or passphrase with 12–128 characters."); return; }
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try {
      const data = { currentPassword, newPassword };
      let result: { success: boolean; sessionsRevoked: boolean };
      if (token !== undefined) {
        if (!token) throw new Error("Sign in again before changing your password.");
        const response = await fetch("/api/membership/users/updatePassword", {
          method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(data)
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.errors?.[0] || "Could not change your password. Sign in again if your session expired.");
        result = payload;
      } else result = await ApiHelper.post("/users/updatePassword", data, "MembershipApi");
      if (result?.success !== true || result.sessionsRevoked !== true) throw new Error("Password change could not be confirmed.");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setChanged(true);
      // The server already revoked every session; the host clears memory and returns to sign-in.
      onSessionsRevoked();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change your password."); }
    finally { setBusy(false); }
  }

  return <Container maxWidth="sm" sx={{ py: 4 }}>
    <Paper sx={{ p: { xs: 3, sm: 4 } }}>
      <Stack component="form" onSubmit={changePassword} spacing={3} aria-label="Change password">
        <Typography variant="h1">Change password</Typography>
        <Typography color="text.secondary">{email ?? (token !== undefined ? "" : UserHelper.user?.email)}</Typography>
        <Typography>Use a password or passphrase with 12–128 characters. Changing your password signs out every session. Sign in again with your new password afterward.</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {changed && <Alert severity="success" role="status">Your password has changed. Sign in again with your new password.</Alert>}
        <TextField label="Current password" name="currentPassword" type="password" required autoComplete="current-password" value={currentPassword} disabled={busy || changed} onChange={e => setCurrentPassword(e.target.value)} />
        <TextField label="New password" name="newPassword" type="password" required autoComplete="new-password" value={newPassword} disabled={busy || changed} onChange={e => setNewPassword(e.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
        <TextField label="Confirm new password" name="confirmPassword" type="password" required autoComplete="new-password" value={confirmPassword} disabled={busy || changed} onChange={e => setConfirmPassword(e.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
        <Button type="submit" variant="contained" disabled={busy || changed}>{busy ? "Changing password…" : "Change password"}</Button>
      </Stack>
    </Paper>
  </Container>;
};
