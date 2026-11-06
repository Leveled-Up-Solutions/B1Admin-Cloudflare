import { MemberSermonArchive } from "./MemberSermonArchive";

type Row = Record<string, any>;
function dateLabel(value: string | undefined, withTime = false): string {
  if (!value) return "Date to be announced";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Date to be announced" : date.toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}
function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try { const url = new URL(value, window.location.origin); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function MemberSermon({ sermon, token }: { sermon: Row; token: string }) {
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
    <MemberSermonArchive sermonId={sermon.id} token={token} />
  </article>;
}

