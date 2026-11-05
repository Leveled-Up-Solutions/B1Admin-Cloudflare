import React from "react";
import { Alert, Box, Button, Dialog, DialogContent, DialogTitle, Paper, Stack, TextField, Typography } from "@mui/material";
import { ApiHelper } from "@churchapps/apphelper";
import { QRCodeSVG } from "qrcode.react";
interface Props {
  token?: string;
  onRevokedPending: () => void;
  onSessionsRevoked: (reason?: "password" | "mfa") => void;
}
type Setup = { secret: string; otpauthUrl: string; setupToken: string; expiresAt: string };
export const CloudflareMfaSettings = ({ token, onRevokedPending, onSessionsRevoked }: Props) => {
  const [status, setStatus] = React.useState<{ enabled: boolean; backupCodesLeft: number } | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const request = React.useCallback(async (path: string, input?: object) => {
    if (token === undefined) return input === undefined ? ApiHelper.get(path, "MembershipApi") : ApiHelper.post(path, input, "MembershipApi");
    if (!token) throw new Error("Sign in again to manage your authenticator.");
    const response = await fetch("/api/membership" + path, { method: input === undefined ? "GET" : "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) }, body: input === undefined ? undefined : JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.errors?.[0] || "Could not update authenticator settings.");
    return result;
  }, [token]);
  React.useEffect(() => { let active = true; request("/users/mfa/status").then(value => { if (active) setStatus(value); }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not load authenticator settings."); }); return () => { active = false; }; }, [request]);
  async function action(kind: "setup" | "enable" | "disable" | "backupCodes") {
    if (busy || codes.length) return;
    setBusy(true); setError("");
    try {
      const input = kind === "setup" ? { currentPassword: password } : kind === "enable" ? { setupToken: setup?.setupToken, code } : { currentPassword: password, code };
      const result = await request("/users/mfa/" + kind, input);
      if (kind === "setup") {
        if (!result?.secret || !result?.setupToken || !result?.otpauthUrl?.startsWith("otpauth://totp/")) throw new Error("Authenticator setup could not be confirmed.");
        setSetup(result); setPassword("");
      } else {
        if (result?.sessionsRevoked !== true) throw new Error("Security change could not be confirmed.");
        setSetup(null); setCode(""); setPassword(""); onRevokedPending();
        if (kind === "disable") onSessionsRevoked("mfa");
        else if (Array.isArray(result.backupCodes) && result.backupCodes.length) setCodes(result.backupCodes);
        else throw new Error("Backup codes could not be loaded. Sign in again and use local recovery if needed.");
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update authenticator settings."); }
    finally { setBusy(false); }
  }
  return <Paper sx={{ p: { xs: 3, sm: 4 }, mt: 3 }}><Stack spacing={2} aria-label="Authenticator settings">
    <Typography variant="h2">Two-factor authentication</Typography>
    {error && <Alert severity="error">{error}</Alert>}
    {codes.length ? <Dialog open disableEscapeKeyDown fullWidth maxWidth="sm" aria-labelledby="backup-codes-title"><DialogTitle id="backup-codes-title">Save your backup codes</DialogTitle><DialogContent><Stack spacing={2}>
      <Alert severity="success">Authenticator security updated. Every session is signed out. Save these one-use backup codes before continuing; they will not be shown again.</Alert>
      <Box component="pre" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} aria-label="Backup codes">{codes.join("\n")}</Box>
      <Button onClick={async () => { try { await navigator.clipboard.writeText(codes.join("\n")); setCopied(true); } catch { setError("Copy was unavailable. Select and save the codes manually."); } }}>{copied ? "Backup codes copied" : "Copy backup codes"}</Button>
      <Button variant="contained" onClick={() => { setCodes([]); onSessionsRevoked("mfa"); }}>I saved my backup codes. Sign in again</Button>
    </Stack></DialogContent></Dialog> : <>
      <Typography>{status ? status.enabled ? `Authenticator enabled. ${status.backupCodesLeft} unused backup codes remain.` : "Authenticator is not enabled. Add a six-digit code from your authenticator app to each password sign-in." : "Loading authenticator settings…"}</Typography>
      {!expanded && status && <Button onClick={() => setExpanded(true)}>{status.enabled ? "Manage authenticator" : "Set up authenticator"}</Button>}
      {expanded && !setup && <>
        <TextField label="Password for authenticator settings" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
        {status?.enabled ? <>
          <TextField label="Authenticator or backup code" autoComplete="one-time-code" value={code} disabled={busy} onChange={event => setCode(event.target.value)} />
          <Typography variant="body2">Disabling accepts an unused authenticator or backup code. Replacing backup codes requires a fresh six-digit authenticator code. Either action signs out every session.</Typography>
          <Button onClick={() => action("backupCodes")} disabled={busy || !password || !code}>Replace backup codes</Button>
          <Button color="warning" onClick={() => action("disable")} disabled={busy || !password || !code}>Disable authenticator</Button>
        </> : <Button variant="contained" onClick={() => action("setup")} disabled={busy || !password}>Create authenticator setup</Button>}
      </>}
      {setup && <>
        <Typography>Scan this QR code using your authenticator app, or enter the setup key manually. Keep this key private.</Typography>
        <Box sx={{ bgcolor: "white", p: 2, width: "fit-content" }}><QRCodeSVG value={setup.otpauthUrl} size={180} title="Authenticator setup QR code" /></Box>
        <Box component="code" aria-label="Authenticator setup key" sx={{ overflowWrap: "anywhere" }}>{setup.secret}</Box>
        <TextField label="Six-digit authenticator code" autoComplete="one-time-code" value={code} disabled={busy} onChange={event => setCode(event.target.value)} slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }} />
        <Typography variant="body2">Setup expires {new Date(setup.expiresAt).toLocaleString()}. Enabling signs out every session and shows your backup codes once.</Typography>
        <Button variant="contained" onClick={() => action("enable")} disabled={busy || !/^\d{6}$/.test(code)}>Enable authenticator</Button>
      </>}
      {expanded && <Button disabled={busy} onClick={() => { setExpanded(false); setSetup(null); setPassword(""); setCode(""); setError(""); }}>Cancel authenticator setup</Button>}
    </>}
  </Stack></Paper>;
};
