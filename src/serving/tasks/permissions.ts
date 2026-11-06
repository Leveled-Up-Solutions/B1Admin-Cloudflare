import { ApiHelper } from "@churchapps/apphelper";
import { hasCloudflarePermission } from "../../cloudflare/permissions";

export function canEditTask(groupId?: string): boolean {
  return process.env.REACT_APP_STAGE !== "cloudflare"
    || hasCloudflarePermission({ api: "DoingApi", contentType: "Tasks", action: "Edit" }, groupId);
}

export function canCreateTask(): boolean {
  return process.env.REACT_APP_STAGE !== "cloudflare"
    || (ApiHelper.getConfig("DoingApi")?.permissions || []).some(permission => permission.contentType === "Tasks" && permission.action === "Edit");
}
