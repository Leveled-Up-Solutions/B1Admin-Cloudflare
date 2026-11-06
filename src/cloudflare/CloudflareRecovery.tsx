import React from "react";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { ApiHelper } from "@churchapps/apphelper";
interface Props { token: string; onDone: (email?: string) => void; }
export const CloudflareRecovery = ({ token, onDone }: Props) => {
  const [preview, setPreview] = React.useState<{ requiresMfa: boolean; resetMfa: boolean; expiresAt: string } | null>(null);
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { let active = true; ApiHelper.postAnonymous("/users/recovery/preview", { recoveryToken: token }, "MembershipApi").then(result => { if (active) setPreview(result); }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Recovery link is invalid or expired."); }); return () => { active = false; }; }, [token]);
  async function complete(event: React.FormEvent) {
    event.preventDefault(); if (busy || !preview) return;
    setError("");
    if ([...password].length < 12 || [...password].length > 128) { setError("Use a password or passphrase with 12–128 characters."); return; }
    if (password !== confirm) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try {
      const result = await ApiHelper.postAnonymous("/users/recovery/complete", { recoveryToken: token, newPassword: password, ...(preview.requiresMfa ? { mfaCode: code } : {}) }, "MembershipApi");
      if (result?.success !== true || result?.sessionsRevoked !== true) throw new Error("Recovery could not be confirmed.");
      setPassword(""); setConfirm(""); setCode(""); onDone(result.email);
    } catch (err) { setError(err instanceof Error ? err.message : "Recovery failed."); } finally { setBusy(false); }
  }
  return <Stack component="form" spacing={2} onSubmit={complete} aria-label="Recover account">
    <Typography variant="h2">Recover your local account</Typography>
    {error && <Alert severity="error">{error}</Alert>}
    {preview ? <>
      <Typography>This one-use recovery link was issued by the local operator and expires {new Date(preview.expiresAt).toLocaleString()}. Completing recovery signs out every session.</Typography>
      {preview.resetMfa && <Alert severity="warning">The operator authorized removing your authenticator. Set it up again after signing in.</Alert>}
      <TextField label="Recovery new password" type="password" autoComplete="new-password" required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
      <TextField label="Confirm recovery password" type="password" autoComplete="new-password" required value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
      {preview.requiresMfa && <TextField label="Authenticator or backup code" autoComplete="one-time-code" required value={code} disabled={busy} onChange={event => setCode(event.target.value)} />}
      <Button variant="contained" type="submit" disabled={busy}>Set recovered password</Button>
    </> : !error && <Typography role="status">Checking recovery link…</Typography>}
    <Button onClick={() => onDone()} disabled={busy}>Return to sign in</Button>
  </Stack>;
};
