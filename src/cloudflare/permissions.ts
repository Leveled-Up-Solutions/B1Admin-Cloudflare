import { ApiHelper, UserHelper } from "@churchapps/apphelper";
import type { IApiPermission } from "@churchapps/helpers";

/** The shared upstream helper ignores contentId. Global UI checks must not treat a
 * scoped grant as installation-wide authority; resource screens pass an explicit ID. */
export function hasCloudflarePermission({ api, contentType, action }: IApiPermission, contentId?: string): boolean {
  return (ApiHelper.getConfig(api)?.permissions || []).some(permission =>
    permission.contentType === contentType && permission.action === action &&
    (!permission.contentId || permission.contentId === contentId));
}
export function installCloudflarePermissionChecks() {
  UserHelper.checkAccess = permission => hasCloudflarePermission(permission);
}
