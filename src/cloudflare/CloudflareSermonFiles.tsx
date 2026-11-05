import React from "react";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { ApiHelper } from "@churchapps/apphelper";

type ArchiveFile = { id: string; fileName: string; fileType: string; size: number; contentPath: string };
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** R2 archives stay authenticated; never put a session token in a media URL. */
export function CloudflareSermonFiles({ sermonId }: { sermonId: string }) {
  const [files, setFiles] = React.useState<ArchiveFile[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<File | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const load = React.useCallback(async () => {
    const result: ArchiveFile[] = await ApiHelper.get("/files/sermon/" + encodeURIComponent(sermonId), "ContentApi");
    setFiles(result);
  }, [sermonId]);
  React.useEffect(() => { load().catch(err => setError(err instanceof Error ? err.message : "Could not load archive files.")); }, [load]);

  async function withErrors(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); }
    catch (err) { setError(err instanceof Error ? err.message : "The file operation failed."); }
    finally { setBusy(false); }
  }
  async function responseError(response: Response) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.errors?.[0] || "The file operation failed.");
  }
  async function upload() {
    if (!selected) return;
    if (selected.size > MAX_FILE_BYTES) { setError("Choose a file no larger than 25 MiB."); return; }
    await withErrors(async () => {
      const config = ApiHelper.getConfig("ContentApi")!;
      const query = new URLSearchParams({ fileName: selected.name, contentType: "sermon", contentId: sermonId });
      const response = await fetch(config.url + "/files/upload?" + query.toString(), {
        method: "POST", headers: { Authorization: "Bearer " + config.jwt, "Content-Type": selected.type || "application/octet-stream" }, body: selected
      });
      if (!response.ok) await responseError(response);
      await load(); setSelected(null); if (input.current) input.current.value = "";
    });
  }
  async function download(file: ArchiveFile) {
    await withErrors(async () => {
      const config = ApiHelper.getConfig("ContentApi")!;
      const response = await fetch(config.url + "/files/download/" + encodeURIComponent(file.id), { headers: { Authorization: "Bearer " + config.jwt } });
      if (!response.ok) await responseError(response);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = file.fileName; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function remove(file: ArchiveFile) {
    if (!window.confirm(`Delete archived file “${file.fileName}”?`)) return;
    await withErrors(async () => { await ApiHelper.delete("/files/" + encodeURIComponent(file.id), "ContentApi"); await load(); });
  }

  return <Box sx={{ borderTop: 1, borderColor: "divider", pt: 2 }} data-testid="sermon-archive-files">
    <Stack spacing={2}>
      <Typography variant="h3">Archive files</Typography>
      <Typography variant="body2" color="text.secondary">Attach sermon audio, video or documents in R2. Members can download these files after this sermon is published. Maximum 25 MiB per file.</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {files.map(file => <Stack key={file.id} direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography sx={{ flex: 1 }}>{file.fileName} · {(file.size / 1024).toFixed(1)} KiB</Typography>
        <Button onClick={() => download(file)} disabled={busy} aria-label={"Download " + file.fileName}>Download</Button>
        <Button color="error" onClick={() => remove(file)} disabled={busy} aria-label={"Delete " + file.fileName}>Delete</Button>
      </Stack>)}
      {!files.length && <Typography variant="body2" color="text.secondary">No files attached.</Typography>}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
        <input ref={input} type="file" aria-label="Sermon archive file" accept="audio/mpeg,audio/mp4,audio/wav,video/mp4,image/png,image/jpeg,image/webp,application/pdf,text/plain,application/zip" disabled={busy} onChange={event => setSelected(event.target.files?.[0] || null)} />
        <Button variant="outlined" disabled={busy || !selected} onClick={upload}>Upload archive file</Button>
      </Stack>
    </Stack>
  </Box>;
}
