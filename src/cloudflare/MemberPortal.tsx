import React from "react";
import "./MemberPortal.css";
import { memberRequest as request, storedMemberToken as storedToken, saveMemberToken as saveToken } from "./memberApi";
import { MemberGroupRequests } from "./MemberGroupRequests";
import { CloudflareAccount } from "./CloudflareAccount";

type Row = Record<string, any>;
type Section = "home" | "sermons" | "groups" | "calendar" | "directory" | "profile" | "serving";
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
const tabs: { id: Section; label: string }[] = [
  { id: "home", label: "Home" }, { id: "sermons", label: "Sermons" }, { id: "groups", label: "My groups" },
  { id: "calendar", label: "Calendar" }, { id: "serving", label: "Serving" }, { id: "directory", label: "Directory" }, { id: "profile", label: "My profile" }
];

function displayName(person: Row = {}): string { return person.name?.display || [person.name?.first || person.firstName, person.name?.last || person.lastName].filter(Boolean).join(" ") || person.displayName || "Member"; }
function dateLabel(value: string | undefined, withTime = false): string {
  if (!value) return "Date to be announced";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Date to be announced" : date.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}
function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try { const url = new URL(value, window.location.origin); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

function Sermon({ sermon, token }: { sermon: Row; token: string }) {
  const [files, setFiles] = React.useState<Row[] | null>(null);
  const [fileError, setFileError] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [playing, setPlaying] = React.useState<{ url: string; type: string; name: string } | null>(null);
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  React.useEffect(() => () => { if (playing) URL.revokeObjectURL(playing.url); }, [playing]);
  async function loadFiles() {
    setPending(true); setFileError("");
    try { const data = await request(`/api/member/v1/sermons/${encodeURIComponent(sermon.id)}/files`, token); if (active.current) setFiles(data); }
    catch (error: any) { if (active.current) setFileError(error.message); }
    finally { if (active.current) setPending(false); }
  }
  async function openFile(file: Row) {
    setPending(true); setFileError("");
    try {
      const response = await fetch(`/api/member/v1/files/${encodeURIComponent(file.id)}/download`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again to open this file." : "This archive file is no longer available.");
      const blob = await response.blob();
      if (!active.current) return;
      if (blob.size > 26214400) throw new Error("This file is too large to open in the member app.");
      const url = URL.createObjectURL(blob);
      if (/^(audio|video)\//.test(file.fileType)) setPlaying({ url, type: file.fileType, name: file.fileName });
      else { const link = document.createElement("a"); link.href = url; link.download = file.fileName; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error: any) { if (active.current) setFileError(error.message); }
    finally { if (active.current) setPending(false); }
  }
  const audio = mediaUrl(sermon.audioUrl || sermon.audio);
  const video = mediaUrl(sermon.videoUrl || (sermon.videoType === "url" || sermon.videoType === "custom" ? sermon.videoData : undefined));
  return <article className="mp-card mp-sermon">
    <span className="mp-eyebrow">{dateLabel((sermon.publishDate || sermon.sermonDate)?.slice(0, 10))}</span>
    <h3>{sermon.title || sermon.name}</h3>
    {sermon.speaker && <p className="mp-muted">{sermon.speaker}</p>}
    {sermon.description && <p className="mp-description">{sermon.description}</p>}
    {audio && <audio aria-label={`Listen to ${sermon.title}`} controls preload="none" src={audio}>Your browser does not support audio playback.</audio>}
    {video && <video aria-label={`Watch ${sermon.title}`} controls preload="none" playsInline src={video}>Your browser does not support video playback.</video>}
    {!audio && !video && <p className="mp-muted">Media will be available here when it is published.</p>}
    {playing && (playing.type.startsWith("audio/") ? <audio controls autoPlay src={playing.url} aria-label={playing.name} /> : <video controls autoPlay playsInline src={playing.url} aria-label={playing.name} />)}
    {files === null ? <button className="mp-quiet" disabled={pending} onClick={loadFiles}>{pending ? "Loading archive files…" : "View archive files"}</button> : <div>{files.length ? files.map(file => <div key={file.id}><button className="mp-quiet" disabled={pending} onClick={() => openFile(file)}>{/^(audio|video)\//.test(file.fileType) ? "Play" : "Download"} {file.fileName}</button><small className="mp-muted">{Math.ceil(file.size / 1024)} KB</small></div>) : <p className="mp-muted">No archived files are attached to this sermon.</p>}</div>}
    {fileError && <p role="alert" className="mp-alert">{fileError}</p>}
  </article>;
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
  const [me, setMe] = React.useState<Row | null>(null);
  const [lists, setLists] = React.useState<Record<string, Row[]>>({ directory: [], groups: [], calendar: [], sermons: [], "groups/available": [], assignments: [], signup: [], blockouts: [] });
  const [listErrors, setListErrors] = React.useState<Record<string, string>>({});
  const [search, setSearch] = React.useState("");
  const [refresh, setRefresh] = React.useState(0);
  const [installEvent, setInstallEvent] = React.useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = React.useState(false);
  const [phone, setPhone] = React.useState("");
  const [directoryVisible, setDirectoryVisible] = React.useState(false);
  const [shareEmail, setShareEmail] = React.useState(false);
  const [blockoutStart, setBlockoutStart] = React.useState("");
  const [blockoutEnd, setBlockoutEnd] = React.useState("");

  const clearSession = React.useCallback(() => {
    saveToken(""); setToken(""); setMe(null); setLists({ directory: [], groups: [], calendar: [], sermons: [], "groups/available": [], assignments: [], signup: [], blockouts: [] }); setListErrors({}); setPassword("");
  }, []);

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
    setLoading(true); setError("");
    const names = ["directory", "groups", "calendar", "sermons", "groups/available", "assignments", "signup", "blockouts"];
    (async () => {
      try {
        const profile = await request("/api/member/v1/me", token);
        if (!active) return;
        setMe(profile); setPhone(profile.person?.contactInfo?.mobilePhone || "");
        setDirectoryVisible(!!(profile.directoryVisible ?? profile.person?.directoryVisible));
        setShareEmail(!!(profile.shareEmail ?? profile.person?.shareEmail));
        const servingPaths: Record<string, string> = { assignments: "/api/doing/assignments/my/upcoming", signup: `/api/doing/plans/public/signup/${encodeURIComponent(profile.church.id)}`, blockouts: "/api/doing/blockoutDates/my" };
        const responses = await Promise.allSettled(names.map(name => request(servingPaths[name] || `/api/member/v1/${name}`, token)));
        if (!active) return;
        const nextLists: Record<string, Row[]> = {}; const errors: Record<string, string> = {};
        responses.forEach((result, index) => {
          if (result.status === "fulfilled") nextLists[names[index]] = Array.isArray(result.value) ? result.value : result.value.items || [];
          else { nextLists[names[index]] = []; errors[names[index]] = result.reason.message; }
        });
        setLists(nextLists); setListErrors(errors);
      } catch (problem: any) { if (active) { if (problem.status === 401) clearSession(); setError(problem.message); } }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [token, refresh, clearSession]);

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const login = await request("/api/membership/users/login", "", { method: "POST", body: JSON.stringify({ email: email.trim(), password }) });
      const church = login.userChurches?.[0];
      if (!church?.jwt) throw new Error("This account does not have access to a church.");
      saveToken(church.jwt); setToken(church.jwt); setPassword("");
    } catch (problem: any) { setError(problem.message); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError("");
    try { await request("/api/membership/users/logout", token, { method: "POST", body: "{}" }); clearSession(); setNotice("You have signed out."); }
    catch (problem: any) { if (problem.status === 401) clearSession(); else setError("Could not revoke the session. Please try signing out again."); }
    finally { setBusy(false); }
  }

  async function install() {
    if (!installEvent) { setInstallHelp(!installHelp); return; }
    await installEvent.prompt(); await installEvent.userChoice; setInstallEvent(null);
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await request("/api/member/v1/me", token, { method: "POST", body: JSON.stringify({ mobilePhone: phone, directoryVisible, shareEmail }) });
      setNotice("Your contact details and directory preferences have been saved."); setRefresh(value => value + 1);
    } catch (problem: any) { if (problem.status === 401) clearSession(); setError(problem.message); }
    finally { setBusy(false); }
  }

  async function changeGroup(group: Row, join: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/member/v1/groups/${encodeURIComponent(group.id)}/${join ? "join" : "leave"}`, token, { method: join ? "POST" : "DELETE", ...(join ? { body: "{}" } : {}) });
      setNotice(join ? `You have joined ${group.name}.` : `You have left ${group.name}.`); setRefresh(value => value + 1);
    } catch (problem: any) { if (problem.status === 401) clearSession(); setError(problem.message); }
    finally { setBusy(false); }
  }

  async function servingAction(path: string, method: string, data: unknown, message: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/doing/${path}`, token, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      setNotice(message); setRefresh(value => value + 1);
      if (path === "blockoutDates") { setBlockoutStart(""); setBlockoutEnd(""); }
    } catch (problem: any) { if (problem.status === 401) clearSession(); setError(problem.message); }
    finally { setBusy(false); }
  }

  const person = me?.person || {};
  const directory = lists.directory.filter(item => displayName(item).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const events = [...lists.calendar].sort((a, b) => String(a.start || a.startTime || a.startDate).localeCompare(String(b.start || b.startTime || b.startDate)));
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function empty(name: string, text: string) { return listErrors[name] ? <div role="alert" className="mp-alert">{listErrors[name]} <button onClick={() => setRefresh(value => value + 1)}>Try again</button></div> : <p className="mp-empty">{loading ? "Loading…" : text}</p>; }
  function eventCard(item: Row) { return <article className="mp-card" key={item.occurrenceId || item.id}><span className="mp-eyebrow">{dateLabel(item.start || item.startTime || item.startDate, !item.allDay)}{item.allDay ? " · All day" : ""}</span><h3>{item.title || item.name}</h3>{item.end && !item.allDay && <p className="mp-muted">Ends {dateLabel(item.end, true)}</p>}{item.location && <p><strong>Where:</strong> {item.location}</p>}{item.description && <p className="mp-description">{item.description}</p>}</article>; }

  return <div className="member-portal">
    <header className="mp-header"><a href="/portal" className="mp-brand"><img src="/portal-icon.svg" alt="" width="38" height="38" /><span>Church community<small>{me?.church?.name || "Member portal"}</small></span></a><div className="mp-header-actions"><button className="mp-quiet" onClick={install}>{installEvent ? "Install app" : "Add to home screen"}</button>{token && <button className="mp-quiet" onClick={signOut} disabled={busy}>Sign out</button>}</div></header>
    <div className="mp-dev-note">Local development · synthetic church and member records</div>
    <main className="mp-main">
      {installHelp && <aside className="mp-install"><strong>Keep your community close.</strong><p>{ios ? "In Safari, tap Share, then Add to Home Screen. The portal will open as a web app." : "Open your browser menu and choose Install app or Add to Home Screen if available. You can also bookmark this page."} An internet connection is required to view member information.</p></aside>}
      {error && <div className="mp-alert" role="alert">{error}</div>}{notice && <div className="mp-notice" role="status">{notice}</div>}
      {!token ? <section className="mp-login-layout"><div className="mp-welcome"><span className="mp-eyebrow">Connected in community</span><h1>A place for your church family.</h1><p>Listen to recent sermons, find your groups, see what’s coming up and stay connected.</p><div className="mp-welcome-rule" /><p className="mp-muted">Your directory details are shared according to your preferences.</p></div><form className="mp-card mp-login" onSubmit={signIn}><h2>Welcome back</h2><p className="mp-muted">Sign in to your member portal.</p><label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label><button className="mp-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button><details><summary>Try the synthetic demo</summary><p>Email: <code>member@example.test</code><br />Password: <code>LocalDemo2026!</code></p><button type="button" className="mp-quiet" onClick={() => { setEmail("member@example.test"); setPassword("LocalDemo2026!"); }}>Fill demo credentials</button></details></form></section> : <>
        <nav className="mp-tabs" aria-label="Member sections">{tabs.map(tab => <button key={tab.id} aria-current={section === tab.id ? "page" : undefined} onClick={() => { setSection(tab.id); setSearch(""); setNotice(""); }}>{tab.label}</button>)}</nav>
        {loading && <p className="mp-muted" role="status">Refreshing your community…</p>}
        {section === "home" && <><section className="mp-home-hero"><span className="mp-eyebrow">Your church, together</span><h1>Hello, {person.name?.first || person.firstName || "friend"}.</h1><p>Make room for community this week.</p></section><div className="mp-shortcuts">{[{ id: "sermons", title: "Listen & reflect", text: "Browse the sermon archive" }, { id: "groups", title: "Find your people", text: `${lists.groups.length} group${lists.groups.length === 1 ? "" : "s"} you belong to` }, { id: "calendar", title: "Gather together", text: "See upcoming church events" }].map(item => <button key={item.id} className="mp-card mp-shortcut" onClick={() => setSection(item.id as Section)}><strong>{item.title}</strong><span>{item.text}</span><span aria-hidden="true">↗</span></button>)}</div><div className="mp-section-title"><h2>Coming up</h2><button className="mp-quiet" onClick={() => setSection("calendar")}>View calendar →</button></div><div className="mp-grid">{events.length ? events.slice(0, 2).map(eventCard) : empty("calendar", "No upcoming events have been published.")}</div></>}
        {section === "sermons" && <><div className="mp-section-title"><div><span className="mp-eyebrow">Listen & reflect</span><h1>Sermon archive</h1><p className="mp-muted">Published messages from your church.</p></div></div><div className="mp-grid">{lists.sermons.length ? lists.sermons.map(item => <Sermon key={item.id} sermon={item} token={token} />) : empty("sermons", "No sermons have been published yet.")}</div></>}
        {section === "groups" && <><h1>My groups</h1><p className="mp-muted">The communities you are part of.</p><div className="mp-grid">{lists.groups.length ? lists.groups.map(group => <article className="mp-card" key={group.id}><span className="mp-eyebrow">{group.categoryName || "Community"}</span><h2>{group.name}</h2>{(group.about || group.description) && <p className="mp-description">{group.about || group.description}</p>}{group.meetingTime && <p><strong>When:</strong> {group.meetingTime}</p>}{group.meetingLocation && <p><strong>Where:</strong> {group.meetingLocation}</p>}{group.leader ? <p className="mp-muted">You lead this group. Contact an administrator to transfer leadership before leaving.</p> : <button className="mp-quiet" disabled={busy || loading} onClick={() => changeGroup(group, false)}>Leave group</button>}</article>) : empty("groups", "You are not currently assigned to a group.")}</div><MemberGroupRequests token={token} groups={lists["groups/available"] || []} refresh={refresh} disabled={busy || loading} onJoin={group => changeGroup(group, true)} onChanged={() => setRefresh(value => value + 1)} onExpired={clearSession} /></>}
        {section === "calendar" && <><h1>Church calendar</h1><p className="mp-muted">Church events and gatherings for your groups. Times use your device’s timezone.</p><div className="mp-grid">{events.length ? events.map(eventCard) : empty("calendar", "No upcoming events have been published.")}</div></>}
        {section === "serving" && <><h1>My serving</h1><p className="mp-muted">Respond to your assignments and manage your availability.</p><div className="mp-grid">{lists.assignments.length ? lists.assignments.map(assignment => <article key={assignment.assignmentId || assignment.id} className="mp-card"><span className="mp-eyebrow">{dateLabel(assignment.serviceDate)}</span><h2>{assignment.planName}</h2><p>{assignment.positionName} · {assignment.status}</p><div className="mp-button-row"><button className="mp-primary" disabled={busy || loading || assignment.status === "Accepted"} onClick={() => servingAction(`assignments/accept/${encodeURIComponent(assignment.assignmentId || assignment.id)}`, "POST", {}, "Assignment accepted.")}>Accept</button><button className="mp-quiet" disabled={busy || loading || assignment.status === "Declined"} onClick={() => servingAction(`assignments/decline/${encodeURIComponent(assignment.assignmentId || assignment.id)}`, "POST", {}, "Assignment declined.")}>Decline</button></div></article>) : empty("assignments", "You have no upcoming serving assignments.")}</div><div className="mp-section-title" style={{ marginTop: 36 }}><h2>Open serving positions</h2></div><div className="mp-grid">{lists.signup.length ? lists.signup.map(entry => <article key={entry.plan.id} className="mp-card"><span className="mp-eyebrow">{dateLabel(entry.plan.serviceDate)}</span><h3>{entry.plan.name}</h3>{entry.positions?.filter((position: Row) => position.allowSelfSignup).map((position: Row) => <div key={position.id} className="mp-serving-position"><span>{position.name}<small className="mp-muted">{Math.max(0, position.count - position.filledCount)} places available</small></span><button className="mp-quiet" disabled={busy || loading || position.filledCount >= position.count} onClick={() => servingAction("assignments/signup", "POST", { positionId: position.id }, `You have signed up for ${position.name}.`)}>Sign up</button></div>)}</article>) : empty("signup", "No open serving positions are available.")}</div><div className="mp-section-title" style={{ marginTop: 36 }}><h2>Unavailable dates</h2></div><form className="mp-card mp-profile" onSubmit={event => { event.preventDefault(); servingAction("blockoutDates", "POST", [{ startDate: blockoutStart, endDate: blockoutEnd }], "Your unavailable dates have been saved."); }}><p className="mp-muted">Let your ministry team know when you cannot serve.</p><div className="mp-grid"><label>From<input type="date" required value={blockoutStart} onChange={event => setBlockoutStart(event.target.value)} /></label><label>Through<input type="date" required min={blockoutStart} value={blockoutEnd} onChange={event => setBlockoutEnd(event.target.value)} /></label></div><button className="mp-primary" disabled={busy || loading}>Save unavailable dates</button></form><div className="mp-grid" style={{ marginTop: 20 }}>{lists.blockouts.length ? lists.blockouts.map(blockout => <article className="mp-card" key={blockout.id}><p>{dateLabel(blockout.startDate?.slice(0, 10))} – {dateLabel(blockout.endDate?.slice(0, 10))}</p><button className="mp-quiet" disabled={busy || loading} onClick={() => servingAction(`blockoutDates/${encodeURIComponent(blockout.id)}`, "DELETE", undefined, "Unavailable dates removed.")}>Remove unavailable dates</button></article>) : empty("blockouts", "You have no unavailable dates saved.")}</div></>}
        {section === "directory" && <><h1>Member directory</h1><p className="mp-muted">Members who have chosen to appear in your church directory.</p><label className="mp-search">Find a member<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name" /></label><div className="mp-grid">{directory.length ? directory.map(member => <article className="mp-card mp-person" key={member.id}><div className="mp-avatar" aria-hidden="true">{displayName(member).split(" ").filter(Boolean).map((part: string) => part[0]).slice(0, 2).join("")}</div><div><h2>{displayName(member)}</h2>{(member.email || member.contactInfo?.email) && <p><a href={`mailto:${member.email || member.contactInfo?.email}`}>{member.email || member.contactInfo?.email}</a></p>}</div></article>) : empty("directory", search ? "No matching members." : "No members have opted into the directory yet.")}</div></>}
        {section === "profile" && <><h1>My profile</h1><form className="mp-card mp-profile" onSubmit={saveProfile}><h2>{displayName(person)}</h2><p className="mp-muted">{person.contactInfo?.email || person.email}</p><label>Mobile phone<input type="tel" maxLength={40} value={phone} onChange={event => setPhone(event.target.value)} autoComplete="tel" /></label><fieldset><legend>Directory preferences</legend><label className="mp-checkbox"><input type="checkbox" checked={directoryVisible} onChange={event => setDirectoryVisible(event.target.checked)} />Show my name in the member directory</label><label className="mp-checkbox"><input type="checkbox" checked={shareEmail} onChange={event => setShareEmail(event.target.checked)} />Share my email with signed-in members</label><p className="mp-muted">Your email is shown only when both preferences are enabled. Your phone number is not included in the member directory.</p></fieldset><button className="mp-primary" disabled={busy || loading}>{busy ? "Saving…" : "Save preferences"}</button></form><CloudflareAccount token={token} onSessionsRevoked={() => { clearSession(); setNotice("Your password has changed. Sign in again with your new password."); }} /></>}
      </>}
      <footer className="mp-footer">A private space for your community.<span>Member web app · online access required</span></footer>
    </main>
  </div>;
}

export default MemberPortal;
