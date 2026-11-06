import React from "react";
import { memberRequest } from "./memberApi";
import { authorizeArchiveMedia, downloadArchiveMedia, type ArchiveMediaFile } from "./mediaAccess";

/** Native media elements stream byte ranges with a scoped HttpOnly cookie. */
export function MemberSermonArchive({ sermonId, token }: { sermonId: string; token: string }) {
  const [files, setFiles] = React.useState<ArchiveMediaFile[] | null>(null);
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [playing, setPlaying] = React.useState<{ file: ArchiveMediaFile; url: string; openedAt: string } | null>(null);
  const media = React.useRef<HTMLMediaElement | null>(null);
  const setMediaRef = React.useCallback((element: HTMLMediaElement | null) => {
    const previous = media.current;
    if (previous && previous !== element) { previous.pause(); previous.removeAttribute("src"); previous.load(); }
    media.current = element;
  }, []);
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current++; setPlaying(null); setFiles(null); setError(""); setPending(false);
    return () => {
      generation.current++;
      if (media.current) { media.current.pause(); media.current.removeAttribute("src"); media.current.load(); }
    };
  }, [sermonId, token]);
  async function loadFiles() {
    const current = generation.current;
    setPending(true); setError("");
    try {
      const result = await memberRequest<ArchiveMediaFile[]>(`/api/member/v1/sermons/${encodeURIComponent(sermonId)}/files`, token);
      if (current === generation.current) setFiles(result);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Could not load archive files."); } finally { if (current === generation.current) setPending(false); }
  }
  async function openFile(file: ArchiveMediaFile, play: boolean) {
    const current = generation.current;
    setPending(true); setError("");
    try {
      const access = await authorizeArchiveMedia(file.id, token, "member");
      if (current !== generation.current) return;
      if (play) setPlaying({ file, url: access.playUrl, openedAt: access.expiresAt });
      else downloadArchiveMedia(access.downloadUrl, file.fileName);
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Could not open this archive."); } finally { if (current === generation.current) setPending(false); }
  }
  function playbackError() { setError("Playback stopped or this format is unsupported. Choose Play again to refresh access, or download the archive. If your session ended, sign in again."); }
  return <div className="mp-sermon-archive">
    {playing && (playing.file.fileType.startsWith("audio/")
      ? <audio key={playing.openedAt} ref={setMediaRef} controls autoPlay preload="metadata" src={playing.url} aria-label={playing.file.fileName} onError={playbackError} />
      : <video key={playing.openedAt} ref={setMediaRef} controls autoPlay preload="metadata" playsInline src={playing.url} aria-label={playing.file.fileName} onError={playbackError} />)}
    {files === null
      ? <button className="mp-quiet" disabled={pending} onClick={loadFiles}>{pending ? "Loading archive files…" : "View archive files"}</button>
      : <div>{files.length ? files.map(file => <div key={file.id}>
        {/^(audio|video)\//.test(file.fileType) && <button className="mp-quiet" disabled={pending} onClick={() => openFile(file, true)}>Play {file.fileName}</button>}
        <button className="mp-quiet" disabled={pending} onClick={() => openFile(file, false)}>Download {file.fileName}</button>
        <small className="mp-muted">{(file.size / 1024 / 1024).toFixed(1)} MiB</small>
      </div>) : <p className="mp-muted">No archived files are attached to this sermon.</p>}</div>}
    {error && <p role="alert" className="mp-alert">{error}</p>}
  </div>;
}
