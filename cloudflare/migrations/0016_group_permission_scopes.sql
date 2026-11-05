-- Deleting a scoped resource must not leave a grant that can revive if its ID is reused.
CREATE TRIGGER revoke_deleted_group_permissions AFTER DELETE ON groups BEGIN DELETE FROM role_permissions WHERE churchId=OLD.churchId AND apiName='MembershipApi' AND contentType IN ('Groups','Group Members') AND contentId=OLD.id; END;
