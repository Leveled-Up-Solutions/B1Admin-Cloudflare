import React from "react";
import { MemberPagination } from "./MemberPagination";
import { MemberSermon } from "./MemberSermon";
import { MemberGroupRequests } from "./MemberGroupRequests";
import { useMemberPage } from "./useMemberPage";

interface Props { token: string; refresh: number; onExpired: () => void }
interface DirectoryPerson { id: string; name: { display: string }; contactInfo: { email?: string } }
interface Sermon { id: string; title: string; description: string; speaker: string; publishDate: string; audioUrl?: string; videoUrl?: string }
export interface MemberGroup { id: string; name: string; categoryName?: string; about?: string; meetingTime?: string; meetingLocation?: string; leader?: boolean; joinPolicy?: string }

export const MemberDirectory = ({ token, refresh, onExpired }: Props) => {
  const [search, setSearch] = React.useState("");
  const page = useMemberPage<DirectoryPerson>("/api/member/v1/directory", token, { q: search }, refresh, onExpired);
  return <><h1>Member directory</h1><p className="mp-muted">Members who have chosen to appear in your church directory.</p>
    <label className="mp-search">Find a member<input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by name" /></label>
    <div className="mp-grid">{page.items.map(member => <article className="mp-card mp-person" key={member.id}><div className="mp-avatar" aria-hidden="true">{member.name.display.split(" ").filter(Boolean).map(part => part[0]).slice(0, 2).join("")}</div><div><h2>{member.name.display}</h2>{member.contactInfo.email && <p><a href={`mailto:${member.contactInfo.email}`}>{member.contactInfo.email}</a></p>}</div></article>)}</div>
    {!page.loading && !page.error && !page.items.length && <p className="mp-empty">{search ? "No matching members." : "No members have opted into the directory yet."}</p>}
    <MemberPagination page={page} label="Directory" />
  </>;
};

export const MemberSermons = ({ token, refresh, onExpired }: Props) => {
  const [search, setSearch] = React.useState("");
  const page = useMemberPage<Sermon>("/api/member/v1/sermons", token, { q: search }, refresh, onExpired);
  return <><div className="mp-section-title"><div><span className="mp-eyebrow">Listen & reflect</span><h1>Sermon archive</h1><p className="mp-muted">Published messages from your church.</p></div></div>
    <label className="mp-search">Search sermons<input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} placeholder="Title, description or speaker" /></label>
    <div className="mp-grid">{page.items.map(sermon => <MemberSermon key={sermon.id} sermon={sermon} token={token} />)}</div>
    {!page.loading && !page.error && !page.items.length && <p className="mp-empty">{search ? "No matching sermons." : "No sermons have been published yet."}</p>}
    <MemberPagination page={page} label="Sermons" />
  </>;
};

interface GroupProps extends Props { disabled: boolean; onJoin: (group: MemberGroup, join: boolean) => void; onChanged: () => void }
export const MemberGroups = ({ token, refresh, onExpired, disabled, onJoin, onChanged }: GroupProps) => {
  const [search, setSearch] = React.useState(""), [discover, setDiscover] = React.useState("");
  const own = useMemberPage<MemberGroup>("/api/member/v1/groups", token, { q: search }, refresh, onExpired);
  const available = useMemberPage<MemberGroup>("/api/member/v1/groups/available", token, { q: discover }, refresh, onExpired);
  return <><h1>My groups</h1><p className="mp-muted">The communities you are part of.</p>
    <label className="mp-search">Search my groups<input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="mp-grid">{own.items.map(group => <article className="mp-card" key={group.id}><span className="mp-eyebrow">{group.categoryName || "Community"}</span><h2>{group.name}</h2>{group.about && <p className="mp-description">{group.about}</p>}{group.meetingTime && <p><strong>When:</strong> {group.meetingTime}</p>}{group.meetingLocation && <p><strong>Where:</strong> {group.meetingLocation}</p>}{group.leader ? <p className="mp-muted">You lead this group. Contact an administrator to transfer leadership before leaving.</p> : <button className="mp-quiet" disabled={disabled || own.loading} onClick={() => onJoin(group, false)}>Leave group</button>}</article>)}</div>
    {!own.loading && !own.error && !own.items.length && <p className="mp-empty">{search ? "No matching groups." : "You are not currently assigned to a group."}</p>}
    <MemberPagination page={own} label="My groups" />
    <MemberGroupRequests token={token} groups={available.items} refresh={refresh} disabled={disabled || available.loading} onJoin={group => onJoin(group as MemberGroup, true)} onChanged={onChanged} onExpired={onExpired}
      discoveryHeader={<label className="mp-search">Search available groups<input type="search" maxLength={100} value={discover} onChange={event => setDiscover(event.target.value)} /></label>}
      discoveryFooter={<MemberPagination page={available} label="Available groups" />}
      emptyDiscovery={available.loading || available.error ? <></> : <p className="mp-empty">{discover ? "No matching groups are available." : "No additional groups are available right now."}</p>} />
  </>;
};
