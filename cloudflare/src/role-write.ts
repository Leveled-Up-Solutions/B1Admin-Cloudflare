import type { Context } from './types';
import { builtinGrants, type Grant } from './permissions';
import { id } from './http';
import { permissionScopeSql } from './permission-scopes';

interface Mutation {
  roleIds: string[];
  table: 'roles' | 'role_permissions' | 'role_members';
  id: string;
  existing: Record<string, string | number | null> | null;
  grant?: Grant;
  assignUserId?: string;
  delegateRoleId?: string;
}

function heldGrantSql(): string {
  const viewer = Object.entries(builtinGrants)
    .flatMap(([api, entries]) =>
      entries
        .filter(([, action]) => action.startsWith('View'))
        .map(
          ([content, action]) =>
            `(candidate.apiName='${api}' AND candidate.contentType='${content}' AND candidate.action='${action}')`,
        ),
    )
    .join(' OR ');
  return `((uc.role='viewer' AND (${viewer})) OR EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName=candidate.apiName AND rp.contentType=candidate.contentType AND rp.action=candidate.action AND rp.contentId IN ('',candidate.contentId)))`;
}

/** Recheck delegation and live actor authority in the same transaction as every role mutation. */
export function roleWriteGuard(ctx: Context, mutation: Mutation): D1PreparedStatement[] {
  const values: (string | number | null)[] = [
    ctx.principal.churchId,
    ctx.principal.userId,
    ctx.principal.personId,
    ctx.principal.sessionId,
  ];
  const checks = [
    `(uc.role='admin' OR EXISTS(SELECT 1 FROM role_members rm JOIN role_permissions rp ON rp.churchId=rm.churchId AND rp.roleId=rm.roleId
    WHERE rm.churchId=uc.churchId AND rm.userId=uc.userId AND rp.apiName='MembershipApi' AND rp.contentType='Roles' AND rp.contentId='' AND rp.action='Edit'))`,
  ];
  for (const roleId of new Set(mutation.roleIds)) {
    checks.push(
      `EXISTS(SELECT 1 FROM roles r WHERE r.churchId=uc.churchId AND r.id=? AND (uc.role='admin' OR NOT EXISTS(SELECT 1 FROM role_members own WHERE own.churchId=r.churchId AND own.roleId=r.id AND own.userId=uc.userId)))`,
    );
    values.push(roleId);
  }
  if (mutation.grant) {
    const grant = mutation.grant;
    checks.push(`EXISTS(SELECT 1 FROM (SELECT ? churchId,? apiName,? contentType,? contentId,? action) candidate WHERE ${permissionScopeSql('candidate')}
      AND (uc.role='admin' OR (candidate.contentType<>'Roles' AND ${heldGrantSql()})))`);
    values.push(ctx.principal.churchId, grant.apiName, grant.contentType, grant.contentId, grant.action);
  }
  if (mutation.assignUserId) {
    checks.push(
      `EXISTS(SELECT 1 FROM user_churches target WHERE target.churchId=uc.churchId AND target.userId=? AND (uc.role='admin' OR target.userId<>uc.userId))`,
    );
    values.push(mutation.assignUserId);
  }
  if (mutation.delegateRoleId) {
    checks.push(`(uc.role='admin' OR NOT EXISTS(SELECT 1 FROM role_permissions candidate WHERE candidate.churchId=uc.churchId AND candidate.roleId=? AND
      (candidate.contentType='Roles' OR NOT ${permissionScopeSql('candidate')} OR NOT ${heldGrantSql()})))`);
    values.push(mutation.delegateRoleId);
  }
  if (mutation.table === 'role_members' && mutation.existing?.userId) {
    checks.push(`(uc.role='admin' OR uc.userId<>?)`);
    values.push(mutation.existing.userId);
  }
  const clauses = [
    `EXISTS(SELECT 1 FROM user_churches uc JOIN users u ON u.id=uc.userId JOIN people actorPerson ON actorPerson.churchId=uc.churchId AND actorPerson.id=uc.personId AND actorPerson.removed=0 JOIN sessions s ON s.userId=u.id WHERE uc.churchId=? AND uc.userId=? AND uc.personId=? AND s.id=?
    AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.passwordVersion=u.passwordVersion AND u.disabled=0 AND u.passwordState='active' AND ${checks.join(' AND ')})`,
  ];
  if (mutation.existing) {
    const columns =
      mutation.table === 'role_permissions'
        ? ['roleId', 'apiName', 'contentType', 'contentId', 'action']
        : mutation.table === 'role_members'
          ? ['roleId', 'userId']
          : [];
    clauses.push(
      `EXISTS(SELECT 1 FROM ${mutation.table} old WHERE old.churchId=? AND old.id=? ${columns.map((column) => `AND old.${column} IS ?`).join(' ')})`,
    );
    values.push(ctx.principal.churchId, mutation.id, ...columns.map((column) => mutation.existing![column] ?? null));
  } else {
    clauses.push(`NOT EXISTS(SELECT 1 FROM ${mutation.table} old WHERE old.id=?)`);
    values.push(mutation.id);
  }
  const guardId = id();
  return [
    ctx.env.DB.prepare(
      `INSERT INTO write_guards(id,valid) VALUES(?,CASE WHEN ${clauses.join(' AND ')} THEN 1 ELSE 0 END)`,
    ).bind(guardId, ...values),
    ctx.env.DB.prepare('DELETE FROM write_guards WHERE id=?').bind(guardId),
  ];
}
