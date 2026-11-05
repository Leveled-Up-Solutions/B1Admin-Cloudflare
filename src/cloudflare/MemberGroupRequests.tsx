import React from "react";
import { memberRequest as request } from "./memberApi";

type Row = Record<string, any>;
interface Props { token: string; groups: Row[]; refresh: number; disabled: boolean; onJoin: (group: Row) => void; onChanged: () => void; onExpired: () => void; }

export function MemberGroupRequests({ token, groups, refresh, disabled, onJoin, onChanged, onExpired }: Props) {
  const [mine, setMine] = React.useState<Row[]>([]), [review, setReview] = React.useState<Row[]>([]);
  const [target, setTarget] = React.useState<Row | null>(null), [decline, setDecline] = React.useState<Row | null>(null);
  const [message, setMessage] = React.useState(""), [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false), [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(""), [notice, setNotice] = React.useState("");
  React.useEffect(() => {
    let active = true; setLoading(true); setError("");
    Promise.all([request<Row[]>("/api/membership/groupjoinrequests/my", token), request<Row[]>("/api/member/v1/group-requests/review", token)])
      .then(([own, pending]) => { if (active) { setMine(own); setReview(pending); } })
      .catch(problem => { if (active) { if (problem.status === 401) onExpired(); setError(problem.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, refresh, onExpired]);
  async function act(path: string, method: string, data: unknown, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(`/api/membership/groupjoinrequests${path}`, token, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      setTarget(null); setDecline(null); setMessage(""); setReason(""); setNotice(success); onChanged();
    } catch (problem: any) { if (problem.status === 401) onExpired(); setError(problem.message); } finally { setBusy(false); }
  }
  const locked = disabled || busy || loading;
  return <>
    <div className="mp-section-title" style={{ marginTop: 36 }}><h2>Find a group</h2><button className="mp-quiet" disabled={busy || loading} onClick={onChanged}>Refresh requests</button></div>
    <p className="mp-muted">Join an open group or ask its leaders to approve your request.</p>
    {error && <p className="mp-alert" role="alert">{error}</p>}{notice && <p className="mp-notice" role="status">{notice}</p>}
    <div className="mp-grid">{groups.length ? groups.map(group => {
      const pending = mine.find(item => item.groupId === group.id && item.status === "pending");
      return <article className="mp-card" key={group.id}><span className="mp-eyebrow">{group.categoryName || "Community"}</span><h3>{group.name}</h3>{group.about && <p>{group.about}</p>}
        {group.joinPolicy === "request" ? pending ? <p className="mp-muted">Your request is pending approval.</p> : <button className="mp-primary" disabled={locked} onClick={() => { setTarget(group); setMessage(""); }}>Request to join</button> : <button className="mp-primary" disabled={locked} onClick={() => onJoin(group)}>Join group</button>}
      </article>;
    }) : <p className="mp-empty">No additional groups are available right now.</p>}</div>
    {target && <form className="mp-card mp-profile" style={{ marginTop: 20 }} onSubmit={event => { event.preventDefault(); act("", "POST", { groupId: target.id, message }, `Your request to join ${target.name} has been submitted.`); }}>
      <h3>Request to join {target.name}</h3><label>Message to group leaders (optional)<textarea maxLength={1000} rows={3} value={message} onChange={event => setMessage(event.target.value)} /></label>
      <div className="mp-button-row"><button className="mp-primary" disabled={locked}>Send request</button><button type="button" className="mp-quiet" disabled={busy} onClick={() => setTarget(null)}>Cancel</button></div>
    </form>}
    <div className="mp-section-title" style={{ marginTop: 36 }}><h2>My join requests</h2></div>
    <div className="mp-grid">{mine.length ? mine.map(item => <article className="mp-card" key={item.id} data-testid={`member-request-${item.id}`}>
      <h3>{item.group?.name || "Group request"}</h3><p><strong>Status:</strong> {item.status}</p>{item.message && <p>{item.message}</p>}{item.declineReason && <p><strong>Reason:</strong> {item.declineReason}</p>}
      {item.status === "pending" && <button className="mp-quiet" disabled={locked} onClick={() => act(`/${encodeURIComponent(item.id)}`, "DELETE", undefined, "Your join request has been cancelled.")}>Cancel request</button>}
    </article>) : <p className="mp-empty">{loading ? "Loading requests…" : "You have no join requests."}</p>}</div>
    {review.length > 0 && <><div className="mp-section-title" style={{ marginTop: 36 }}><h2>Requests to review</h2></div><p className="mp-muted">Pending requests for groups you lead or manage.</p><div className="mp-grid">{review.map(item => <article className="mp-card" key={item.id} data-testid={`review-request-${item.id}`}>
      <h3>{item.person?.name?.display || "Member"}</h3><p>{item.group?.name}</p>{item.message && <p>{item.message}</p>}
      <div className="mp-button-row"><button className="mp-primary" disabled={locked} onClick={() => act(`/${encodeURIComponent(item.id)}/approve`, "POST", {}, "Join request approved.")}>Approve request</button><button className="mp-quiet" disabled={locked} onClick={() => { setDecline(item); setReason(""); }}>Decline request</button></div>
    </article>)}</div></>}
    {decline && <form className="mp-card mp-profile" style={{ marginTop: 20 }} onSubmit={event => { event.preventDefault(); act(`/${encodeURIComponent(decline.id)}/decline`, "POST", { declineReason: reason }, "Join request declined."); }}>
      <h3>Decline {decline.person?.name?.display}'s request</h3><label>Reason shown to requester (optional)<textarea maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mp-button-row"><button className="mp-primary" disabled={locked}>Confirm decline</button><button type="button" className="mp-quiet" disabled={busy} onClick={() => setDecline(null)}>Cancel</button></div>
    </form>}
  </>;
}
