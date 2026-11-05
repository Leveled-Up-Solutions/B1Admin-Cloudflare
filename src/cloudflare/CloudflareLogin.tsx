import React from "react";
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { ApiHelper, UserHelper } from "@churchapps/apphelper";
import type { LoginResponseInterface, LoginUserChurchInterface } from "@churchapps/helpers";
import { Link, useLocation, useNavigate } from "react-router-dom";
import UserContext from "../UserContext";
import { queryClient } from "../queryClient";
import { saveMemberToken } from "./memberApi";

type InvitationPreview = { mode: "setPassword" | "link"; expiresAt: string };
type InvitationState = { kind: "none" | "loading" | "error" } | { kind: "ready"; preview: InvitationPreview };
type CloudflareLoginResponse = Omit<LoginResponseInterface, "userChurches"> & {
  userChurches: Array<LoginUserChurchInterface & { role?: "admin" | "viewer" | "member" }>;
};

/** Local sign-in keeps the suite's response contract without mounting hosted OAuth/support widgets. */
export const CloudflareLogin = () => {
  const context = React.useContext(UserContext)!;
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [success, setSuccess] = React.useState(location.state?.passwordChanged === true ? "Your password has changed. Sign in with your new password." : "");
  const [authGuid, setAuthGuid] = React.useState<string | null>(() => new URLSearchParams(location.search).get("auth"));
  const [invitation, setInvitation] = React.useState<InvitationState>(() => ({ kind: authGuid === null ? "none" : "loading" }));
  const [previewAttempt, setPreviewAttempt] = React.useState(0);
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");

  // Capture the invitation only in component memory, then remove it before rendering the form.
  React.useLayoutEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("auth")) return;
    params.delete("auth");
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? "?" + search : "", hash: location.hash }, { replace: true, state: location.state });
  }, [location.pathname, location.search, location.hash, location.state, navigate]);

  React.useEffect(() => {
    if (authGuid === null) return;
    if (!authGuid) { setInvitation({ kind: "error" }); setError("This invitation link is invalid."); return; }
    let active = true;
    setInvitation({ kind: "loading" });
    setError("");
    ApiHelper.postAnonymous("/users/invitations/preview", { authGuid }, "MembershipApi").then((result: InvitationPreview) => {
      if (result?.mode !== "setPassword" && result?.mode !== "link") throw new Error("This invitation could not be verified.");
      if (active) setInvitation({ kind: "ready", preview: result });
    }).catch((err: unknown) => {
      if (active) { setInvitation({ kind: "error" }); setError(err instanceof Error ? err.message : "This invitation could not be verified."); }
    });
    return () => { active = false; };
  }, [authGuid, previewAttempt]);

  function returnToSignIn() {
    setAuthGuid(null); setInvitation({ kind: "none" }); setError("");
    setPassword(""); setNewPassword(""); setConfirmPassword("");
  }

  async function acceptInvitation(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !authGuid || invitation.kind !== "ready") return;
    setError(""); setSuccess("");
    if (invitation.preview.mode === "setPassword") {
      if ([...newPassword].length < 12 || [...newPassword].length > 128) { setError("Use a password or passphrase with 12–128 characters."); return; }
      if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    } else if (!password) { setError("Enter your current password to accept this invitation."); return; }
    setBusy(true);
    try {
      const setup = invitation.preview.mode === "setPassword";
      const result: { success: boolean; email: string } = await ApiHelper.postAnonymous(
        setup ? "/users/setPasswordGuid" : "/users/acceptInvitation",
        setup ? { authGuid, newPassword } : { authGuid, currentPassword: password },
        "MembershipApi"
      );
      if (result?.success !== true || !result.email) throw new Error("Invitation acceptance could not be confirmed.");
      returnToSignIn();
      setEmail(result.email);
      setSuccess("Invitation accepted. Sign in with your email and password.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not accept this invitation."); }
    finally { setBusy(false); }
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result: CloudflareLoginResponse = await ApiHelper.postAnonymous("/users/login", { email, password }, "MembershipApi");
      if (!result.user || !result.userChurches?.length) throw new Error("This account has no church access.");
      const selected = result.userChurches[0];
      if (selected.role === "member" && selected.apis.every(api => api.permissions.length === 0)) {
        saveMemberToken(selected.jwt);
        ApiHelper.clearPermissions();
        queryClient.clear();
        context.setUser(null!); context.setPerson(null!); context.setUserChurch(null!); context.setUserChurches([]);
        navigate("/portal", { replace: true });
        return;
      }
      UserHelper.user = result.user;
      UserHelper.userChurches = result.userChurches;
      UserHelper.person = result.userChurches[0].person;
      await UserHelper.selectChurch(context, result.userChurches[0].church.id, undefined);
      context.setUser(result.user);
      context.setUserChurches(result.userChurches);
      context.setPerson(result.userChurches[0].person);
      // Memory-only session for this development milestone. A reload requires sign-in.
      const from = location.state?.from?.pathname;
      navigate(typeof from === "string" && /^\/(?!\/)/.test(from) ? from : "/", { replace: true });
    } catch (err) { setError(err instanceof Error ? err.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  return <Box sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: 3, bgcolor: "background.default" }}>
    <Paper sx={{ p: { xs: 3, sm: 5 }, width: "100%", maxWidth: 500 }}>
      <Stack spacing={3}>
        <Box component="img" src="/images/logo-login.png" alt="B1Admin" sx={{ width: 180, maxWidth: "100%" }} />
        <Typography variant="h1">Cloudflare development</Typography>
        <Typography color="text.secondary">{invitation.kind === "none" ? "Sign in to the local church administration workspace." : "Accept your church invitation."}</Typography>
        {success && <Alert severity="success" role="status">{success}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        {invitation.kind === "none" ? <>
          <Alert severity="info">Synthetic data only. Use <strong>admin@example.test</strong> or <strong>viewer@example.test</strong> with password <strong>LocalDemo2026!</strong>. The viewer can read records but cannot change them.</Alert>
          <Stack component="form" onSubmit={login} spacing={3} aria-label="Sign in">
            <TextField label="Email" name="email" type="email" required autoComplete="username" value={email} disabled={busy} onChange={e => setEmail(e.target.value)} />
            <TextField label="Password" name="password" type="password" required autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} />
            <Button type="submit" variant="contained" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
          </Stack>
          <Button component={Link} to="/portal">Open member portal</Button>
        </> : <>
          {invitation.kind === "loading" && <Typography role="status">Checking invitation…</Typography>}
          {invitation.kind === "ready" && <Stack component="form" onSubmit={acceptInvitation} spacing={3} aria-label="Accept invitation">
            {invitation.preview.mode === "setPassword" ? <>
              <Typography>Choose a password to set up your account. Passphrases are welcome; use 12–128 characters.</Typography>
              <TextField label="New password" name="newPassword" type="password" required autoComplete="new-password" value={newPassword} disabled={busy} onChange={e => setNewPassword(e.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
              <TextField label="Confirm new password" name="confirmPassword" type="password" required autoComplete="new-password" value={confirmPassword} disabled={busy} onChange={e => setConfirmPassword(e.target.value)} slotProps={{ htmlInput: { maxLength: 256 } }} />
            </> : <>
              <Typography>Enter the password for your existing account to accept this invitation.</Typography>
              <TextField label="Current password" name="currentPassword" type="password" required autoComplete="current-password" value={password} disabled={busy} onChange={e => setPassword(e.target.value)} />
            </>}
            {Number.isFinite(Date.parse(invitation.preview.expiresAt)) && <Typography variant="body2" color="text.secondary">Invitation expires {new Date(invitation.preview.expiresAt).toLocaleString()}.</Typography>}
            <Button type="submit" variant="contained" disabled={busy}>{busy ? "Accepting invitation…" : invitation.preview.mode === "setPassword" ? "Set password and accept" : "Accept invitation"}</Button>
          </Stack>}
          {invitation.kind === "error" && authGuid && <Button onClick={() => setPreviewAttempt(attempt => attempt + 1)}>Check invitation again</Button>}
          <Button onClick={returnToSignIn} disabled={busy}>Return to sign in</Button>
        </>}
        <Typography variant="body2" color="text.secondary">The people directory, groups, calendars, Serving / Plans, My Work and the sermon archive are available. Sign-up and password recovery are not enabled in this development milestone.</Typography>
      </Stack>
    </Paper>
  </Box>;
};
