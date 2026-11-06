import { memo } from "react";
import { Permissions } from "@churchapps/apphelper";
import { Sermons } from "./components/Sermons";
import { useRequirePermission } from "../hooks";
import { Alert } from "@mui/material";
import { canOpenSermonArchive } from "../cloudflare/sermonPermissions";

export const SermonsPage = memo(() => {
  const denied = useRequirePermission(Permissions.contentApi.streamingServices.edit);
  if (process.env.REACT_APP_STAGE === "cloudflare") {
    if (!canOpenSermonArchive()) return <Alert severity="warning">Sermon archive access is required.</Alert>;
  } else if (denied) return denied;

  return (
    <Sermons />
  );
});
