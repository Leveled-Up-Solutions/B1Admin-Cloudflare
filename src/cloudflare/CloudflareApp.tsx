import React, { Suspense } from "react";
import { Alert, AppBar, Box, Button, Chip, Container, Paper, Stack, Toolbar, Typography } from "@mui/material";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { ApiHelper, Permissions, UserHelper } from "@churchapps/apphelper";
import UserContext from "../UserContext";
import { queryClient } from "../queryClient";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { CloudflarePerson, CloudflareGroup } from "./CloudflareRecords";
import { CloudflareCalendars } from "./CloudflareCalendars";

const PeoplePage = React.lazy(() => import("../people/PeoplePage").then(m => ({ default: m.PeoplePage })));
const GroupsPage = React.lazy(() => import("../groups/GroupsPage"));
const ServingPage = React.lazy(() => import("../serving/ServingPage").then(m => ({ default: m.ServingPage })));
const PlanTypePage = React.lazy(() => import("../serving/planTypes/PlanTypePage").then(m => ({ default: m.PlanTypePage })));
const PrintPlan = React.lazy(() => import("../serving/plans/PrintPlan").then(m => ({ default: m.PrintPlan })));
const PlanPage = React.lazy(() => import("../serving/plans/PlanPage").then(m => ({ default: m.PlanPage })));
const TasksPage = React.lazy(() => import("../serving/tasks/TasksPage").then(m => ({ default: m.TasksPage })));
const TaskPage = React.lazy(() => import("../serving/tasks/TaskPage").then(m => ({ default: m.TaskPage })));
const SermonsPage = React.lazy(() => import("../sermons/SermonsPage").then(m => ({ default: m.SermonsPage })));
const RolesPage = React.lazy(() => import("../settings/RolesPage").then(m => ({ default: m.RolesPage })));
const RolePage = React.lazy(() => import("../settings/RolePage").then(m => ({ default: m.RolePage })));
const AuditLogPage = React.lazy(() => import("../settings/AuditLogPage").then(m => ({ default: m.AuditLogPage })));



const modules = [
  { path: "/people", title: "People", text: "Create, find and update people and household records." },
  { path: "/groups", title: "Groups", text: "Manage groups, members and leaders." },
  { path: "/serving/plans", title: "Serving / Plans", text: "Plan services and assign ministry teams using the ChurchApps workflow." },
  { path: "/serving/tasks", title: "My Work", text: "Create and manage assigned tasks." },
  { path: "/sermons", title: "Sermons", text: "Manage the sermon archive for church members." },
  { path: "/calendars", title: "Calendars & scheduling", text: "Organize calendars, group events, times and locations." }
];

function Overview() {
  const [status, setStatus] = React.useState("Checking connection…");
  React.useEffect(() => {
    fetch("/api/health").then(async r => { if (!r.ok) throw new Error(); await r.json(); setStatus("Worker API connected"); }).catch(() => setStatus("Worker API unavailable"));
  }, []);
  return <Container maxWidth="lg" sx={{ py: 4 }}>
    <Stack spacing={3}>
      <Typography variant="h1">Church administration</Typography>
      <Typography color="text.secondary">{UserHelper.currentUserChurch?.church?.name}</Typography>
      <Chip label={status} sx={{ alignSelf: "flex-start" }} />
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 3 }}>
        {modules.map(m => <Paper key={m.path} sx={{ p: 3 }}><Stack spacing={2}>
          <Typography variant="h2">{m.title}</Typography><Typography color="text.secondary">{m.text}</Typography>
          <Button component={Link} to={m.path} variant="outlined" sx={{ alignSelf: "flex-start" }}>Open {m.title.toLowerCase()}</Button>
        </Stack></Paper>)}
      </Box>
      <Paper sx={{ p: 3 }}><Stack spacing={1}>
        <Typography variant="h2">Port status</Typography>
        <Typography>This is a development milestone, not a complete replacement for the ChurchApps suite. The initial release includes the people directory, groups, calendars, Serving / Plans, My Work and the sermon archive. Giving, payments, attendance, check-in, workflow automation, message delivery and website management are outside this release. Automatic fair rotation is future work.</Typography>
        <Typography>The separate public website is not part of this build. Future website API integration will be addressed separately.</Typography>
        <Button component="a" href="/api/capabilities" target="_blank" rel="noreferrer" sx={{ alignSelf: "flex-start" }}>View API capabilities</Button>
      </Stack></Paper>
    </Stack>
  </Container>;
}

export const CloudflareApp = () => {
  const context = React.useContext(UserContext)!;
  const navigate = useNavigate();
  const [logoutError, setLogoutError] = React.useState("");
  UserHelper.user = context.user;
  UserHelper.person = context.person;
  UserHelper.currentUserChurch = context.userChurch;
  UserHelper.userChurches = context.userChurches;
  async function logout() {
    try {
      await ApiHelper.post("/users/logout", {}, "MembershipApi");
      ApiHelper.clearPermissions();
      queryClient.clear();
      context.setUser(null!); context.setPerson(null!); context.setUserChurch(null!); context.setUserChurches([]);
      navigate("/login", { replace: true });
    } catch { setLogoutError("Could not revoke the session. Please try again."); }
  }
  return <Box sx={{ minHeight: "100dvh" }}>
    <AppBar position="static" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Toolbar sx={{ flexWrap: "wrap", gap: 1, py: 1 }}>
        <Typography component={Link} to="/" sx={{ color: "text.primary", fontWeight: 700, textDecoration: "none", mr: 2 }}>B1Admin · Cloudflare</Typography>
        {modules.map(m => <Button key={m.path} component={Link} to={m.path}>{m.title}</Button>)}
        {UserHelper.checkAccess(Permissions.membershipApi.roles.view) && <Button component={Link} to="/settings/roles">Roles</Button>}
        {UserHelper.checkAccess(Permissions.membershipApi.roles.view) && <Button component={Link} to="/settings/auditlog">Audit log</Button>}
        <Box sx={{ flexGrow: 1 }} /><Button component={Link} to="/portal">Member portal</Button><Button onClick={logout}>Sign out</Button>
      </Toolbar>
    </AppBar>
    <Alert severity="info" sx={{ borderRadius: 0 }}>Development workspace · synthetic records · directory, groups, calendars & serving · sign in again after reloading.</Alert>
    {logoutError && <Alert severity="error">{logoutError}</Alert>}
    <ErrorBoundary><Suspense fallback={<Container sx={{ py: 4 }}>Loading…</Container>}><Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/people" element={<PeoplePage />} />
      <Route path="/people/:id" element={<CloudflarePerson />} />
      <Route path="/groups" element={<GroupsPage />} />
      <Route path="/groups/:id" element={<CloudflareGroup />} />
      <Route path="/calendars" element={<CloudflareCalendars />} />
      <Route path="/serving" element={<ServingPage />} />
      <Route path="/serving/plans" element={<ServingPage />} />
      <Route path="/serving/planTypes/:id" element={<PlanTypePage />} />
      <Route path="/serving/plans/print/:id" element={<PrintPlan />} />
      <Route path="/serving/plans/:id" element={<PlanPage />} />
      <Route path="/serving/tasks" element={<TasksPage />} />
      <Route path="/serving/tasks/:id" element={<TaskPage />} />
      <Route path="/sermons" element={<SermonsPage />} />
      <Route path="/settings/roles" element={<RolesPage />} />
      <Route path="/settings/role/:roleId" element={<RolePage />} />
      <Route path="/settings/auditlog" element={<AuditLogPage />} />
      <Route path="*" element={<Container sx={{ py: 4 }}><Alert severity="warning">This feature is not available in the Cloudflare milestone.</Alert><Button component={Link} to="/">Return to administration</Button></Container>} />
    </Routes></Suspense></ErrorBoundary>
  </Box>;
};
