import type { Context } from './types';
import { id } from './http';
interface Mutation {
  kind: 'group' | 'member';
  id: string;
  existing: { parentId?: string | null; groupId?: string } | null;
  remove?: boolean;
  parentId?: string | null;
  groupId?: string;
  personId?: string;
}
/** Assertions execute inside the mutation batch, not as another asynchronous preflight. */
export function groupWriteGuard(ctx: Context, mutation: Mutation): D1PreparedStatement[] {
  const cid = ctx.principal.churchId;
  const permissions: string[] = [];
  const grantValues: (string | number | null)[] = [];
  function grant(members: boolean, groupId?: string): string {
    if (groupId) grantValues.push(groupId);
    return `(uc.role='admin' OR EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
      WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName='MembershipApi' AND rp.action='Edit'
      AND rp.contentType IN (${members ? "'Groups','Group Members'" : "'Groups'"}) AND ${groupId ? "rp.contentId IN ('',?)" : "rp.contentId=''"}))`;
  }
  if (mutation.kind === 'group') {
    const hierarchyChanged = (mutation.existing?.parentId || null) !== (mutation.parentId || null);
    permissions.push(
      grant(false, mutation.existing && (mutation.remove || !hierarchyChanged) ? mutation.id : undefined),
    );
    if (mutation.remove) {
      grantValues.push(cid, mutation.id);
      permissions.push(
        `(NOT EXISTS(SELECT 1 FROM groups child WHERE child.churchId=? AND child.parentId=?) OR ${grant(false)})`,
      );
    }
  } else {
    if (!mutation.remove) permissions.push(grant(true, mutation.groupId));
    if (mutation.existing) permissions.push(grant(true, mutation.existing.groupId));
  }
  const checks = [
    `EXISTS(SELECT 1 FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN sessions s ON s.userId=u.id
    WHERE uc.churchId=? AND uc.userId=? AND s.id=? AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.disabled=0 AND u.passwordState='active'
    AND s.passwordVersion=u.passwordVersion AND ${permissions.join(' AND ')})`,
  ];
  const values: (string | number | null)[] = [cid, ctx.principal.userId, ctx.principal.sessionId, ...grantValues];
  const table = mutation.kind === 'group' ? 'groups' : 'group_members';
  if (mutation.existing) {
    const column = mutation.kind === 'group' ? 'parentId' : 'groupId';
    checks.push(
      `EXISTS(SELECT 1 FROM ${table} existing WHERE existing.churchId=? AND existing.id=? AND existing.${column} IS ?)`,
    );
    values.push(cid, mutation.id, mutation.existing[column] || null);
  } else {
    checks.push(`NOT EXISTS(SELECT 1 FROM ${table} existing WHERE existing.id=?)`);
    values.push(mutation.id);
  }
  if (!mutation.remove && mutation.kind === 'member') {
    checks.push('EXISTS(SELECT 1 FROM groups g WHERE g.churchId=? AND g.id=?)');
    values.push(cid, mutation.groupId!);
    checks.push('EXISTS(SELECT 1 FROM people p WHERE p.churchId=? AND p.id=? AND p.removed=0)');
    values.push(cid, mutation.personId!);
  }
  if (!mutation.remove && mutation.kind === 'group' && mutation.parentId) {
    checks.push('EXISTS(SELECT 1 FROM groups parent WHERE parent.churchId=? AND parent.id=?)');
    values.push(cid, mutation.parentId);
  }
  const guardId = id();
  return [
    ctx.env.DB.prepare(
      `INSERT INTO write_guards(id,valid) VALUES(?,CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...values),
    ctx.env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ];
}
