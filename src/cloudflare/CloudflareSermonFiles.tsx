import React from "react";
import { Alert, Box, Button, Checkbox, FormControlLabel, LinearProgress, Stack, Typography } from "@mui/material";
import { ApiHelper } from "@churchapps/apphelper";
import { authorizeArchiveMedia, downloadArchiveMedia } from "./mediaAccess";

type ArchiveFile = { id: string; fileName: string; fileType: string; size: number; contentPath: string };
type UploadPart = { partNumber: number; size: number; sha256: string };
type UploadSession = {
  id: string; fileId: string; contentId: string; fileName: string; fileType: string; size: number;
  partSize: number; totalParts: number; state: string; expiresAt: string; parts: UploadPart[]; file?: ArchiveFile;
};
const MAX_RAW_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const formatSize = (size: number) => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MiB` : `${(size / 1024).toFixed(1)} KiB`;

async function fileRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const config = ApiHelper.getConfig("ContentApi")!;
  const headers = new Headers(options.headers);
  headers.set("Authorization", "Bearer " + config.jwt);
  const response = await fetch(config.url + "/files" + path, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.errors?.[0] || "The file operation failed.");
  }
  return response;
}
async function fingerprint(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

/** R2 archives stay authenticated; never put a session token in a media URL. */
export function CloudflareSermonFiles({ sermonId, canEdit = true }: { sermonId: string; canEdit?: boolean }) {
  const [files, setFiles] = React.useState<ArchiveFile[]>([]);
  const [playing, setPlaying] = React.useState<{ file: ArchiveFile; url: string; openedAt: string } | null>(null);
  const [sessions, setSessions] = React.useState<UploadSession[]>([]);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<File | null>(null);
  const [resumable, setResumable] = React.useState(false);
  const [progress, setProgress] = React.useState<{ bytes: number; total: number; message: string } | null>(null);
  const media = React.useRef<HTMLMediaElement | null>(null);
  const setMediaRef = React.useCallback((element: HTMLMediaElement | null) => {
    const previous = media.current;
    if (previous && previous !== element) { previous.pause(); previous.removeAttribute("src"); previous.load(); }
    media.current = element;
  }, []);
  const input = React.useRef<HTMLInputElement>(null);
  const controller = React.useRef<AbortController | null>(null);
  const creation = React.useRef<{ file: File; key: string } | null>(null);
  const loadSessions = React.useCallback(async () => {
    if (!canEdit) { setSessions([]); return; }
    const response = await fileRequest("/uploads?" + new URLSearchParams({ contentId: sermonId }));
    setSessions(await response.json());
  }, [sermonId, canEdit]);
  const load = React.useCallback(async () => {
    const [result] = await Promise.all([ApiHelper.get("/files/sermon/" + encodeURIComponent(sermonId), "ContentApi"), loadSessions()]);
    setFiles(result);
  }, [sermonId, loadSessions]);
  React.useEffect(() => {
    setPlaying(null); setSelected(null); setProgress(null); setNotice(""); setError(""); creation.current = null;
    load().catch(err => setError(err instanceof Error ? err.message : "Could not load archive files."));
    return () => controller.current?.abort();
  }, [load]);

  async function withErrors(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") setNotice("Upload paused. Select the same file and resume when ready.");
      else setError(err instanceof Error ? err.message : "The file operation failed.");
      // An interrupted request may already have persisted its session or part.
      await loadSessions().catch(() => undefined);
    } finally { controller.current = null; setBusy(false); }
  }
  function clearSelection() {
    setSelected(null); creation.current = null;
    if (input.current) input.current.value = "";
  }
  async function uploadParts(existing?: UploadSession) {
    const source = selected;
    if ((!source && existing?.state !== "completing") || (source && (!source.size || source.size > MAX_FILE_BYTES))) {
      setError("Choose a file between 1 byte and 1 GiB."); return;
    }
    if (existing && existing.state !== "completing" && (source!.name !== existing.fileName || source!.size !== existing.size)) {
      setError("Select the original file with the same name and size to resume this upload."); return;
    }
    await withErrors(async () => {
      const abort = new AbortController(); controller.current = abort;
      const signal = abort.signal;
      let session: UploadSession;
      if (existing) session = await (await fileRequest("/uploads/" + encodeURIComponent(existing.id), { signal })).json();
      else {
        if (creation.current?.file !== source) creation.current = { file: source!, key: crypto.randomUUID() };
        session = await (await fileRequest("/uploads", {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentId: sermonId, fileName: source!.name, fileType: source!.type || "application/octet-stream", size: source!.size, idempotencyKey: creation.current.key })
        })).json();
      }
      setSessions(current => [...current.filter(item => item.id !== session.id), session]);
      if (session.state === "aborted") {
        creation.current = null;
        throw new Error("This upload was aborted. Start a new upload.");
      }
      if (session.state !== "complete" && session.state !== "completing") {
        if (session.state !== "uploading") throw new Error("This upload is not ready. Refresh its status or start a new upload.");
        if (!source || source.name !== session.fileName || source.size !== session.size) throw new Error("Select the original file with the same name and size to resume this upload.");
        let uploadedBytes = session.parts.reduce((sum, part) => sum + part.size, 0);
        // Verify every stored chunk before sending new bytes: name and size alone cannot identify a file.
        for (const part of session.parts) {
          signal.throwIfAborted();
          setProgress({ bytes: uploadedBytes, total: session.size, message: `Checking saved part ${part.partNumber} of ${session.totalParts}` });
          const bytes = await source.slice((part.partNumber - 1) * session.partSize, part.partNumber * session.partSize).arrayBuffer();
          if (bytes.byteLength !== part.size || await fingerprint(bytes) !== part.sha256) throw new Error("This file does not match the uploaded parts. Select the original file, or abort this upload and start again.");
        }
        const uploaded = new Set(session.parts.map(part => part.partNumber));
        for (let partNumber = 1; partNumber <= session.totalParts; partNumber++) {
          if (uploaded.has(partNumber)) continue;
          signal.throwIfAborted();
          const chunk = source.slice((partNumber - 1) * session.partSize, partNumber * session.partSize);
          setProgress({ bytes: uploadedBytes, total: session.size, message: `Uploading part ${partNumber} of ${session.totalParts}` });
          const part: UploadPart = await (await fileRequest(`/uploads/${encodeURIComponent(session.id)}/parts/${partNumber}`, { method: "PUT", signal, headers: { "Content-Type": "application/octet-stream" }, body: chunk })).json();
          uploadedBytes += part.size;
          session = { ...session, parts: [...session.parts, part] };
          setSessions(current => current.map(item => item.id === session.id ? session : item));
        }
      }
      signal.throwIfAborted();
      setProgress({ bytes: session.size, total: session.size, message: "Finalizing archive file" });
      if (session.state !== "complete") { session = await (await fileRequest(`/uploads/${encodeURIComponent(session.id)}/complete`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: "{}" })).json(); }
      if (session.state !== "complete") throw new Error("Finalization is still pending. Refresh and finish the upload again.");
      await load(); clearSelection(); setProgress(null); setNotice("Archive upload complete.");
    });
  }
  async function upload() {
    if (!selected) return;
    if (resumable || selected.size > MAX_RAW_BYTES) return uploadParts();
    if (!selected.size) { setError("Choose a file between 1 byte and 1 GiB."); return; }
    await withErrors(async () => {
      const query = new URLSearchParams({ fileName: selected.name, contentType: "sermon", contentId: sermonId });
      await fileRequest("/upload?" + query.toString(), { method: "POST", headers: { "Content-Type": selected.type || "application/octet-stream" }, body: selected });
      await load(); clearSelection(); setNotice("Archive upload complete.");
    });
  }
  async function abortUpload(session: UploadSession) {
    if (!window.confirm(`Abort upload of “${session.fileName}” and discard its uploaded parts?`)) return;
    await withErrors(async () => {
      await fileRequest("/uploads/" + encodeURIComponent(session.id), { method: "DELETE" });
      creation.current = null;
      await loadSessions(); setProgress(null); setNotice("Upload aborted.");
    });
  }
  async function openFile(file: ArchiveFile, play = false) {
    await withErrors(async () => {
      const access = await authorizeArchiveMedia(file.id, ApiHelper.getConfig("ContentApi")!.jwt, "staff");
      if (play) setPlaying({ file, url: access.playUrl, openedAt: access.expiresAt });
      else downloadArchiveMedia(access.downloadUrl, file.fileName);
    });
  }
  async function remove(file: ArchiveFile) {
    if (!window.confirm(`Delete archived file “${file.fileName}”?`)) return;
    await withErrors(async () => { await ApiHelper.delete("/files/" + encodeURIComponent(file.id), "ContentApi"); await load(); });
  }

  return <Box sx={{ borderTop: 1, borderColor: "divider", pt: 2 }} data-testid="sermon-archive-files">
    <Stack spacing={2}>
      <Typography variant="h3">Archive files</Typography>
      <Typography variant="body2" color="text.secondary">Attach sermon audio, video or documents in R2. Members can download these files after this sermon is published. Maximum 1 GiB per file. Files over 25 MiB upload in resumable parts.</Typography>
      <Typography variant="body2" color="text.secondary">Play or download archived media privately in your browser. Access expires with your session or after two hours; choose Play again to refresh it.</Typography>
      {playing && (playing.file.fileType.startsWith("audio/") ? <audio key={playing.openedAt} ref={setMediaRef} controls autoPlay preload="metadata" src={playing.url} aria-label={playing.file.fileName} onError={() => setError("Playback stopped or this format is unsupported. Choose Play again to refresh access, or download the archive.")} /> : <video key={playing.openedAt} ref={setMediaRef} controls autoPlay preload="metadata" playsInline src={playing.url} aria-label={playing.file.fileName} onError={() => setError("Playback stopped or this format is unsupported. Choose Play again to refresh access, or download the archive.")} />)}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}
      {files.map(file => <Stack key={file.id} direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography sx={{ flex: 1 }}>{file.fileName} · {formatSize(file.size)}</Typography>
        {/^(audio|video)\//.test(file.fileType) && <Button onClick={() => openFile(file, true)} disabled={busy} aria-label={"Play " + file.fileName}>Play</Button>}
        <Button onClick={() => openFile(file)} disabled={busy} aria-label={"Download " + file.fileName}>Download</Button>
        {canEdit && <Button color="error" onClick={() => remove(file)} disabled={busy} aria-label={"Delete " + file.fileName}>Delete</Button>}
      </Stack>)}
      {!files.length && <Typography variant="body2" color="text.secondary">No files attached.</Typography>}
      {canEdit && <>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
          <input ref={input} type="file" aria-label="Sermon archive file" accept="audio/mpeg,audio/mp4,audio/wav,video/mp4,image/png,image/jpeg,image/webp,application/pdf,text/plain,application/zip" disabled={busy} onChange={event => { setSelected(event.target.files?.[0] || null); setError(""); creation.current = null; }} />
          <Button variant="outlined" disabled={busy || !selected} onClick={upload}>Upload archive file</Button>
        </Stack>
        <FormControlLabel control={<Checkbox checked={resumable} disabled={busy} onChange={event => setResumable(event.target.checked)} />} label="Use resumable upload for this file" />
        {progress && <Box aria-live="polite">
          <Typography variant="body2">{progress.message} · {formatSize(progress.bytes)} of {formatSize(progress.total)}</Typography>
          <LinearProgress variant="determinate" value={Math.min(100, progress.bytes / progress.total * 100)} aria-label="Archive upload progress" />
          {busy && controller.current && <Button onClick={() => controller.current?.abort()}>Pause upload</Button>}
        </Box>}
        {sessions.length > 0 && <Box>
          <Typography variant="body2">Unfinished uploads expire after 24 hours. Select the original file to resume; saved parts are checked before uploading continues.</Typography>
          <Button disabled={busy} onClick={() => withErrors(load)}>Refresh uploads</Button>
        </Box>}
        {sessions.map(session => <Stack key={session.id} spacing={1} data-testid={"archive-upload-" + session.id}>
          <Typography>{session.fileName} · {session.parts.length} of {session.totalParts} parts saved · {session.state}</Typography>
          <Typography variant="caption">Expires {new Date(session.expiresAt).toLocaleString()}</Typography>
          <Stack direction="row" spacing={1}>
            <Button disabled={busy || (!selected && session.state !== "completing")} onClick={() => uploadParts(session)} aria-label={"Resume " + session.fileName}>{session.state === "completing" ? "Finish upload" : "Resume upload"}</Button>
            <Button color="error" disabled={busy} onClick={() => abortUpload(session)} aria-label={"Abort " + session.fileName}>Abort upload</Button>
          </Stack>
        </Stack>)}
      </>}
    </Stack>
  </Box>;
}
