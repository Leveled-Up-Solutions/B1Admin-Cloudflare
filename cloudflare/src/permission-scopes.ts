import type { Context } from './types';
import type { Grant } from './permissions';
import { first, HttpError } from './http';

/** Resource IDs are exact: neither group ancestry nor membership grants staff authority. */
export async function validatePermissionScope(ctx: Context, grant: Grant): Promise<void> {
  if (!grant.contentId) return;
  const groupScope = grant.apiName === 'MembershipApi' && ['Groups', 'Group Members'].includes(grant.contentType);
  const doingScope = grant.apiName === 'DoingApi' && ['Plans', 'Tasks'].includes(grant.contentType);
  const contentTables: Record<string, string> = {
    Calendars: 'calendars',
    Sermons: 'content_sermons',
    Playlists: 'content_playlists',
  };
  if (grant.apiName === 'ContentApi' && contentTables[grant.contentType]) {
    if (!['View', 'Edit'].includes(grant.action))
      throw new HttpError(400, 'Only View and Edit support a resource scope');
    if (
      !(await first(
        ctx,
        `SELECT id FROM ${contentTables[grant.contentType]} WHERE churchId=? AND id=?`,
        ctx.principal.churchId,
        grant.contentId,
      ))
    )
      throw new HttpError(400, 'Permission scope must be an existing resource in this church');
    return;
  }
  if (!groupScope && !doingScope) throw new HttpError(501, 'This resource does not support scoped permissions');
  const ministry = grant.apiName === 'DoingApi' && grant.contentType === 'Plans';
  if (
    !(await first(
      ctx,
      `SELECT id FROM groups WHERE churchId=? AND id=? ${ministry ? "AND instr(','||tags||',',',ministry,')>0" : ''}`,
      ctx.principal.churchId,
      grant.contentId,
    ))
  )
    throw new HttpError(
      400,
      ministry
        ? 'Plans scope must be an existing ministry in this church'
        : 'Permission scope must be an existing group in this church',
    );
}

/** Only application-owned SQL aliases are passed here; values remain bound by the caller. */
export function permissionScopeSql(alias: 'rp' | 'candidate'): string {
  return `(${alias}.contentId='' OR EXISTS(SELECT 1 FROM groups scope WHERE scope.churchId=${alias}.churchId AND scope.id=${alias}.contentId AND (
    (${alias}.apiName='MembershipApi' AND ${alias}.contentType IN ('Groups','Group Members')) OR
    (${alias}.apiName='DoingApi' AND (${alias}.contentType='Tasks' OR (${alias}.contentType='Plans' AND instr(','||scope.tags||',',',ministry,')>0)))
  )) OR (${alias}.apiName='ContentApi' AND ${alias}.action IN ('View','Edit') AND (
    (${alias}.contentType='Calendars' AND EXISTS(SELECT 1 FROM calendars scope WHERE scope.churchId=${alias}.churchId AND scope.id=${alias}.contentId)) OR
    (${alias}.contentType='Sermons' AND EXISTS(SELECT 1 FROM content_sermons scope WHERE scope.churchId=${alias}.churchId AND scope.id=${alias}.contentId)) OR
    (${alias}.contentType='Playlists' AND EXISTS(SELECT 1 FROM content_playlists scope WHERE scope.churchId=${alias}.churchId AND scope.id=${alias}.contentId))
  )))`;
}
