import type { Env } from './types';
import { cleanupFiles } from './content';
import { cleanupMediaAccess } from './media-session';

/** Safe local maintenance only. Deliberately does not send or execute workflows. */
export async function scheduledCleanup(env: Env, scheduledTime = Date.now()): Promise<void> {
  const completedAt = new Date(scheduledTime).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expiresAt <= ?').bind(completedAt),
    env.DB.prepare('DELETE FROM auth_attempts WHERE expiresAt <= ?').bind(completedAt),
    env.DB.prepare('DELETE FROM auth_mfa_challenges WHERE expiresAt <= ?').bind(completedAt),
    env.DB.prepare('DELETE FROM auth_mfa_enrollments WHERE expiresAt <= ?').bind(completedAt),
  ]);
  await cleanupMediaAccess(env, completedAt);
  await cleanupFiles(env);
  // Retry-safe marker: runs can repeat after interruption; each maintenance action is idempotent.
  const runId = `cleanup:${completedAt.slice(0, 13)}`;
  await env.DB.prepare(
    'INSERT INTO job_runs (id, jobName, completedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET completedAt = excluded.completedAt',
  )
    .bind(runId, 'expired-sessions-and-files', completedAt)
    .run();
}
