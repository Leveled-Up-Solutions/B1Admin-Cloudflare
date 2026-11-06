import { Permissions, UserHelper } from "@churchapps/apphelper";
import { hasCloudflarePermission } from "../cloudflare/permissions";

// Plans/Edit moved from the MembershipApi bucket to DoingApi server-side; check both
// until the legacy MembershipApi grant is retired.
export const hasPlansEditAccess = (ministryId?: string): boolean => process.env.REACT_APP_STAGE === "cloudflare"
  ? hasCloudflarePermission({ api: "DoingApi", contentType: "Plans", action: "Edit" }, ministryId)
  : UserHelper.checkAccess(Permissions.membershipApi.plans.edit) || UserHelper.checkAccess({ api: "DoingApi", contentType: "Plans", action: "Edit" });
