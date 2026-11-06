import React from "react";
import "./MemberPortal.css";
import { memberRequest as request, storedMemberToken as storedToken, saveMemberToken as saveToken, memberErrorMessage, memberSessionExpired } from "./memberApi";
import { MemberDirectory, MemberGroups, MemberSermons } from "./MemberPagedLists";
import { MemberCalendar, MemberUpcomingEvents } from "./MemberCalendar";
import { CloudflareAccount } from "./CloudflareAccount";
import { MemberChurchSelector } from "./MemberChurchSelector";
import { MemberProfileEditor } from "./MemberProfileEditor";
import { MemberHousehold } from "./MemberHousehold";
import { MemberProfileRequests } from "./MemberProfileRequests";
import type { MemberChurchLink, MemberProfile } from "./memberProfileTypes";

type Row = Record<string, any>;
type Section = "home" | "sermons" | "groups" | "calendar" | "directory" | "profile" | "serving";
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type LoginChurch = { church: { id: string; name: string }; jwt: string };
type MfaChallenge = { mfaRequired: true; mfaToken: string; expiresAt: string };
type MemberLoginResult = MfaChallenge | { userChurches: LoginChurch[] };
const tabs: { id: Section; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "sermons", label: "Sermons" },
  { id: "groups", label: "My groups" },
  { id: "calendar", label: "Calendar" },
  { id: "serving", label: "Serving" },
  { id: "directory", label: "Directory" },
  { id: "profile", label: "My profile" }
];

function dateLabel(value: string | undefined, withTime = false): string {
  if (!value) return "Date to be announced";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Date to be announced" : date.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}
export function MemberPortal() {
  const [token, setToken] = React.useState(storedToken);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [section, setSection] = React.useState<Section>("home");
  const [me, setMe] = React.useState<MemberProfile | null>(null);
  const [churches, setChurches] = React.useState<MemberChurchLink[]>([]);
  const [loginChurches, setLoginChurches] = React.useState<LoginChurch[] | null>(null);
  const [choosingChurch, setChoosingChurch] = React.useState(false);
  const [challenge, setChallenge] = React.useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = React.useState("");
  const [lists, setLists] = React.useState<Record<string, Row[]>>({ assignments: [], signup: [], blockouts: [] });
  const [listErrors, setListErrors] = React.useState<Record<string, string>>({});
  const [refresh, setRefresh] = React.useState(0);
  const [installEvent, setInstallEvent] = React.useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = React.useState(false);
  const [blockoutStart, setBlockoutStart] = React.useState("");
  const [blockoutEnd, setBlockoutEnd] = React.useState("");

  const clearCommunity = React.useCallback(() => {
    setMe(null); setChurches([]); setLists({ assignments: [], signup: [], blockouts: [] }); setListErrors({}); setSection("home"); setBlockoutStart(""); setBlockoutEnd("");
  }, []);
  const clearSession = React.useCallback(() => {
    saveToken(""); setToken(""); clearCommunity(); setPassword(""); setChallenge(null); setMfaCode(""); setLoginChurches(null); setChoosingChurch(false); setLoading(false);
  }, [clearCommunity]);

  function activateChurch(church: LoginChurch) {
    clearCommunity(); setLoginChurches(null); setChoosingChurch(false); setChallenge(null); setMfaCode(""); setPassword(""); setError(""); setNotice("");
    saveToken(church.jwt); setToken(church.jwt);
  }

  React.useEffect(() => {
    document.title = "Member portal · Church community";
    const manifest = document.createElement("link"); manifest.rel = "manifest"; manifest.href = "/portal-manifest.webmanifest"; document.head.appendChild(manifest);
    const capture = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent); };
    const installed = () => { setInstallEvent(null); setInstallHelp(false); setNotice("The member app has been installed."); };
    window.addEventListener("beforeinstallprompt", capture); window.addEventListener("appinstalled", installed);
    if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("/portal-sw.js", { scope: "/portal" }).catch(() => { /* The online portal remains available. */ });
    return () => { manifest.remove(); window.removeEventListener("beforeinstallprompt", capture); window.removeEventListener("appinstalled", installed); };
  }, []);

  React.useEffect(() => {
    if (!token) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError("");
    const names = ["assignments", "signup", "blockouts"];
    (async () => {
      try {
        const [profile, links] = await Promise.all([request<MemberProfile>("/api/member/v1/me", token, { signal: controller.signal }), request<MemberChurchLink[]>("/api/member/v1/churches", token, { signal: controller.signal })]);
        if (!active) return;
        setMe(profile); setChurches(links);
        const servingPaths: Record<string, string> = { assignments: "/api/doing/assignments/my/upcoming", signup: `/api/doing/plans/public/signup/${encodeURIComponent(profile.church.id)}`, blockouts: "/api/doing/blockoutDates/my" };
        const responses = await Promise.allSettled(names.map(name => request<Row[] | { items?: Row[] }>(servingPaths[name], token, { signal: controller.signal })));
        if (!active) return;
        const nextLists: Record<string, Row[]> = {}; const errors: Record<string, string> = {};
        responses.forEach((result, index) => {
          if (result.status === "fulfilled") nextLists[names[index]] = Array.isArray(result.value) ? result.value : result.value.items || [];
          else { nextLists[names[index]] = []; errors[names[index]] = result.reason.message; }
        });
        setLists(nextLists); setListErrors(errors);
      } catch (problem: any) { if (active) { if (problem.status === 401) clearSession(); setError(problem.message); } } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [token, refresh, clearSession]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const login = await request<MemberLoginResult>("/api/membership/users/login", "", { method: "POST", body: JSON.stringify(challenge ? { mfaToken: challenge.mfaToken, mfaCode } : { email: email.trim(), password }) });
      setPassword(""); setMfaCode("");
      if ("mfaRequired" in login) { setChallenge(login); return; }
      setChallenge(null);
      const links = login.userChurches.filter(church => church.jwt && church.church?.id);
      if (!links.length) throw new Error("This account does not have access to a church.");
      if (links.length > 1) setLoginChurches(links);
      else activateChurch(links[0]);
    } catch (problem) { setMfaCode(""); setError(memberErrorMessage(problem)); } finally { setBusy(false); }
  }

  async function chooseChurch(churchId: string) {
    if (busy) return;
    if (loginChurches) {
      const selected = loginChurches.find(church => church.church.id === churchId);
      if (selected) activateChurch(selected);
      return;
    }
    if (churchId === me?.church.id) { setChoosingChurch(false); return; }
    setBusy(true); setError("");
    try {
      const selected = await request<LoginChurch>("/api/membership/churches/select", token, { method: "POST", body: JSON.stringify({ churchId }) });
      if (!selected.jwt || selected.church?.id !== churchId) throw new Error("The selected church could not be opened.");
      activateChurch(selected);
    } catch (problem) { if (memberSessionExpired(problem)) clearSession(); setError(memberErrorMessage(problem)); } finally { setBusy(false); }
  }

  async function cancelChurchSelection() {
    if (!loginChurches) { setChoosingChurch(false); return; }
    setBusy(true); setError("");
    try {
      await request("/api/membership/users/logout", loginChurches[0].jwt, { method: "POST", body: "{}" });
      clearSession();
    } catch (problem) { if (memberSessionExpired(problem)) clearSession(); else setError("Could not revoke this sign-in. Please try cancelling again."); } finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError("");
    try { await request("/api/membership/users/logout", token, { method: "POST", body: "{}" }); clearSession(); setNotice("You have signed out."); } catch (problem: any) { if (problem.status === 401) clearSession(); else setError("Could not revoke the session. Please try signing out again."); } finally { setBusy(false); }
  }

  async function install() {
    if (!installEvent) { setInstallHelp(!installHelp); return; }
    await installEvent.prompt(); await installEvent.userChoice; setInstallEvent(null);
  }

  async function changeGroup(group: Row, join: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/member/v1/groups/${encodeURIComponent(group.id)}/${join ? "join" : "leave"}`, token, { method: join ? "POST" : "DELETE", ...(join ? { body: "{}" } : {}) });
      setNotice(join ? `You have joined ${group.name}.` : `You have left ${group.name}.`); setRefresh(value => value + 1);
    } catch (problem: any) { if (problem.status === 401) clearSession(); setError(problem.message); } finally { setBusy(false); }
  }

  async function servingAction(path: string, method: string, data: unknown, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/doing/${path}`, token, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      setNotice(message); setRefresh(value => value + 1);
      if (path === "blockoutDates") { setBlockoutStart(""); setBlockoutEnd(""); }
    } catch (problem: any) { if (problem.status === 401) clearSession(); setError(problem.message); } finally { setBusy(false); }
  }

  const person = me?.person;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function empty(name: string, text: string) { return listErrors[name] ? <div role="alert" className="mp-alert">{listErrors[name]} <button onClick={() => setRefresh(value => value + 1)}>Try again</button></div> : <p className="mp-empty">{loading ? "Loading…" : text}</p>; }

  return <div className="member-portal">
    <header className="mp-header"><a href="/portal" className="mp-brand"><img src="/portal-icon.svg" alt="" width="38" height="38" /><span>Church community<small>{me?.church?.name || "Member portal"}</small></span></a><div className="mp-header-actions"><button className="mp-quiet" onClick={install}>{installEvent ? "Install app" : "Add to home screen"}</button>{token && churches.length > 1 && <button className="mp-quiet" onClick={() => { setChoosingChurch(true); setError(""); setNotice(""); }} disabled={busy || loading}>Change church</button>}{token && <button className="mp-quiet" onClick={signOut} disabled={busy}>Sign out</button>}</div></header>
    <div className="mp-dev-note">Local development · synthetic church and member records</div>
    <main className="mp-main">
      {installHelp && <aside className="mp-install"><strong>Keep your community close.</strong><p>{ios ? "In Safari, tap Share, then Add to Home Screen. The portal will open as a web app." : "Open your browser menu and choose Install app or Add to Home Screen if available. You can also bookmark this page."} An internet connection is required to view member information.</p></aside>}
      {error && <div className="mp-alert" role="alert">{error}</div>}{notice && <div className="mp-notice" role="status">{notice}</div>}
      {loginChurches || choosingChurch ? <MemberChurchSelector key={loginChurches ? "login" : me?.church.id} churches={(loginChurches || churches).map(link => link.church)} currentChurchId={choosingChurch ? me?.church.id : undefined} busy={busy} onChoose={chooseChurch} onCancel={cancelChurchSelection} /> : !token ? <section className="mp-login-layout"><div className="mp-welcome"><span className="mp-eyebrow">Connected in community</span><h1>A place for your church family.</h1><p>Listen to recent sermons, find your groups, see what’s coming up and stay connected.</p><div className="mp-welcome-rule" /><p className="mp-muted">Your directory details are shared according to your preferences.</p></div><form className="mp-card mp-login" onSubmit={signIn}>
        {challenge ? <><h2>Verify your sign-in</h2><p className="mp-muted">Enter a code from your authenticator app or use a recovery code.</p><label>Authenticator or recovery code<input required autoComplete="one-time-code" maxLength={64} value={mfaCode} onChange={event => setMfaCode(event.target.value)} disabled={busy} /></label><div className="mp-button-row"><button className="mp-primary" disabled={busy}>{busy ? "Verifying…" : "Verify sign-in"}</button><button type="button" className="mp-quiet" disabled={busy} onClick={() => { setChallenge(null); setMfaCode(""); setPassword(""); setError(""); }}>Cancel verification</button></div></> : <><h2>Welcome back</h2><p className="mp-muted">Sign in to your member portal.</p><label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label><button className="mp-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button><details><summary>Try the synthetic demo</summary><p>Email: <code>member@example.test</code><br />Password: <code>LocalDemo2026!</code></p><button type="button" className="mp-quiet" disabled={busy} onClick={() => { setEmail("member@example.test"); setPassword("LocalDemo2026!"); }}>Fill demo credentials</button></details></>}
      </form></section> : <>
        <nav className="mp-tabs" aria-label="Member sections">{tabs.map(tab => <button key={tab.id} disabled={busy} aria-current={section === tab.id ? "page" : undefined} onClick={() => { setSection(tab.id); setNotice(""); }}>{tab.label}</button>)}</nav>
        {loading && <p className="mp-muted" role="status">Refreshing your community…</p>}
        {section === "home" && <><section className="mp-home-hero"><span className="mp-eyebrow">Your church, together</span><h1>Hello, {person?.name.first || "friend"}.</h1><p>Make room for community this week.</p></section><div className="mp-shortcuts">{[{ id: "sermons", title: "Listen & reflect", text: "Browse the sermon archive" }, { id: "groups", title: "Find your people", text: "Explore your groups" }, { id: "calendar", title: "Gather together", text: "See upcoming church events" }].map(item => <button key={item.id} className="mp-card mp-shortcut" onClick={() => setSection(item.id as Section)}><strong>{item.title}</strong><span>{item.text}</span><span aria-hidden="true">↗</span></button>)}</div><div className="mp-section-title"><h2>Coming up</h2><button className="mp-quiet" onClick={() => setSection("calendar")}>View calendar →</button></div><MemberUpcomingEvents key={me?.church.id} token={token} refresh={refresh} onExpired={clearSession} /></>}
        {section === "sermons" && <MemberSermons key={me?.church.id} token={token} refresh={refresh} onExpired={clearSession} />}
        {section === "groups" && <MemberGroups key={me?.church.id} token={token} refresh={refresh} onExpired={clearSession} disabled={busy || loading} onJoin={changeGroup} onChanged={() => setRefresh(value => value + 1)} />}
        {section === "calendar" && <MemberCalendar key={me?.church.id} token={token} refresh={refresh} onExpired={clearSession} />}
        {section === "serving" && <><h1>My serving</h1><p className="mp-muted">Respond to your assignments and manage your availability.</p><div className="mp-grid">{lists.assignments.length ? lists.assignments.map(assignment => <article key={assignment.assignmentId || assignment.id} className="mp-card"><span className="mp-eyebrow">{dateLabel(assignment.serviceDate)}</span><h2>{assignment.planName}</h2><p>{assignment.positionName} · {assignment.status}</p><div className="mp-button-row"><button className="mp-primary" disabled={busy || loading || assignment.status === "Accepted"} onClick={() => servingAction(`assignments/accept/${encodeURIComponent(assignment.assignmentId || assignment.id)}`, "POST", {}, "Assignment accepted.")}>Accept</button><button className="mp-quiet" disabled={busy || loading || assignment.status === "Declined"} onClick={() => servingAction(`assignments/decline/${encodeURIComponent(assignment.assignmentId || assignment.id)}`, "POST", {}, "Assignment declined.")}>Decline</button></div></article>) : empty("assignments", "You have no upcoming serving assignments.")}</div><div className="mp-section-title" style={{ marginTop: 36 }}><h2>Open serving positions</h2></div><div className="mp-grid">{lists.signup.length ? lists.signup.map(entry => <article key={entry.plan.id} className="mp-card"><span className="mp-eyebrow">{dateLabel(entry.plan.serviceDate)}</span><h3>{entry.plan.name}</h3>{entry.positions?.filter((position: Row) => position.allowSelfSignup).map((position: Row) => <div key={position.id} className="mp-serving-position"><span>{position.name}<small className="mp-muted">{Math.max(0, position.count - position.filledCount)} places available</small></span><button className="mp-quiet" disabled={busy || loading || position.filledCount >= position.count} onClick={() => servingAction("assignments/signup", "POST", { positionId: position.id }, `You have signed up for ${position.name}.`)}>Sign up</button></div>)}</article>) : empty("signup", "No open serving positions are available.")}</div><div className="mp-section-title" style={{ marginTop: 36 }}><h2>Unavailable dates</h2></div><form className="mp-card mp-profile" onSubmit={event => { event.preventDefault(); servingAction("blockoutDates", "POST", [{ startDate: blockoutStart, endDate: blockoutEnd }], "Your unavailable dates have been saved."); }}><p className="mp-muted">Let your ministry team know when you cannot serve.</p><div className="mp-grid"><label>From<input type="date" required value={blockoutStart} onChange={event => setBlockoutStart(event.target.value)} /></label><label>Through<input type="date" required min={blockoutStart} value={blockoutEnd} onChange={event => setBlockoutEnd(event.target.value)} /></label></div><button className="mp-primary" disabled={busy || loading}>Save unavailable dates</button></form><div className="mp-grid" style={{ marginTop: 20 }}>{lists.blockouts.length ? lists.blockouts.map(blockout => <article className="mp-card" key={blockout.id}><p>{dateLabel(blockout.startDate?.slice(0, 10))} – {dateLabel(blockout.endDate?.slice(0, 10))}</p><button className="mp-quiet" disabled={busy || loading} onClick={() => servingAction(`blockoutDates/${encodeURIComponent(blockout.id)}`, "DELETE", undefined, "Unavailable dates removed.")}>Remove unavailable dates</button></article>) : empty("blockouts", "You have no unavailable dates saved.")}</div></>}
        {section === "directory" && <MemberDirectory key={me?.church.id} token={token} refresh={refresh} onExpired={clearSession} />}
        {section === "profile" && me && <><h1>My profile</h1><MemberProfileEditor key={me.church.id} profile={me} token={token} disabled={busy || loading} onBusy={setBusy} onSaved={profile => { setMe(profile); setRefresh(value => value + 1); }} onExpired={clearSession} /><MemberHousehold key={`household-${me.church.id}`} token={token} disabled={busy || loading} familyAddEnabled={me.settings.familyAddEnabled} profileEditMode={me.settings.profileEditMode} familyEditMode={me.settings.familyEditMode} version={refresh} onChanged={() => setRefresh(value => value + 1)} lastName={me.person.name.last} onBusy={setBusy} onExpired={clearSession} /><MemberProfileRequests token={token} refresh={refresh} onChanged={() => setRefresh(value => value + 1)} onExpired={clearSession} /><CloudflareAccount token={token} onSessionsRevoked={(reason?: "password" | "mfa") => { clearSession(); setNotice(reason === "mfa" ? "Your security settings have changed. Sign in again." : "Your password has changed. Sign in again with your new password."); }} /></>}
      </>}
      <footer className="mp-footer">A private space for your community.<span>Member web app · online access required</span></footer>
    </main>
  </div>;
}

export default MemberPortal;
