import React from "react";
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { ApiHelper, UserHelper } from "@churchapps/apphelper";
import type { LoginResponseInterface } from "@churchapps/helpers";
import { Link, useLocation, useNavigate } from "react-router-dom";
import UserContext from "../UserContext";

/** Local sign-in keeps the suite's response contract without mounting hosted OAuth/support widgets. */
export const CloudflareLogin = () => {
  const context = React.useContext(UserContext)!;
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result: LoginResponseInterface = await ApiHelper.postAnonymous("/users/login", { email, password }, "MembershipApi");
      if (!result.user || !result.userChurches?.length) throw new Error("This account has no church access.");
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
      <Stack component="form" onSubmit={login} spacing={3}>
        <Box component="img" src="/images/logo-login.png" alt="B1Admin" sx={{ width: 180, maxWidth: "100%" }} />
        <Typography variant="h1">Cloudflare development</Typography>
        <Typography color="text.secondary">Sign in to the local church administration workspace.</Typography>
        <Alert severity="info">Synthetic data only. Use <strong>admin@example.test</strong> or <strong>viewer@example.test</strong> with password <strong>LocalDemo2026!</strong>. The viewer can read records but cannot change them.</Alert>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField label="Email" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <TextField label="Password" type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        <Button type="submit" variant="contained" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        <Button component={Link} to="/portal">Open member portal</Button>
        <Typography variant="body2" color="text.secondary">The people directory, groups, calendars, Serving / Plans, My Work and the sermon archive are available. Sign-up and password recovery are not enabled in this development milestone.</Typography>
      </Stack>
    </Paper>
  </Box>;
};
