import type { Env } from './types';
import { HttpError } from './http';
import { accountThrottle, dbNow, type Condition } from './auth-security';
import { decryptSecret, matchedStep, recoveryHash } from './mfa-crypto';
export interface FactorProof {
  condition: Condition;
  statements: D1PreparedStatement[];
}
/** A factor is consumed only inside the caller's atomic transaction after its guard succeeds. */
export async function factorProof(
  request: Request,
  env: Env,
  userId: string,
  code: unknown,
  requireEnabled = false,
  totpOnly = false,
): Promise<FactorProof> {
  const factor = await env.DB.prepare('SELECT * FROM auth_mfa WHERE userId=?').bind(userId).first<any>();
  if (!factor) {
    if (requireEnabled) throw new HttpError(400, 'Two-factor authentication is not enabled');
    return {
      condition: { sql: 'NOT EXISTS(SELECT 1 FROM auth_mfa WHERE userId=?)', values: [userId] },
      statements: [],
    };
  }
  await accountThrottle(request, env, 'mfa-factor', userId, 20);
  if (typeof code === 'string' && /^\d{6}$/.test(code)) {
    const secret = await decryptSecret(env, userId, factor.factorId, factor.encryptedSecret);
    const step = await matchedStep(secret, code);
    if (step === null || step <= factor.lastStep)
      throw new HttpError(400, 'Invalid or already-used authenticator code');
    return {
      condition: {
        sql: "EXISTS(SELECT 1 FROM auth_mfa WHERE userId=? AND factorId=? AND lastStep<? AND abs(CAST(strftime('%s','now') AS INTEGER)/30-?)<=1)",
        values: [userId, factor.factorId, step, step],
      },
      statements: [
        env.DB.prepare('UPDATE auth_mfa SET lastStep=? WHERE userId=? AND factorId=?').bind(
          step,
          userId,
          factor.factorId,
        ),
      ],
    };
  }
  const hash = totpOnly ? null : await recoveryHash(userId, code);
  if (
    !hash ||
    !(await env.DB.prepare('SELECT codeHash FROM auth_mfa_codes WHERE userId=? AND codeHash=? AND usedAt IS NULL')
      .bind(userId, hash)
      .first())
  )
    throw new HttpError(400, 'An unused authenticator or backup code is required');
  return {
    condition: {
      sql: 'EXISTS(SELECT 1 FROM auth_mfa m JOIN auth_mfa_codes c ON c.userId=m.userId WHERE m.userId=? AND m.factorId=? AND c.codeHash=? AND c.usedAt IS NULL)',
      values: [userId, factor.factorId, hash],
    },
    statements: [
      env.DB.prepare(`UPDATE auth_mfa_codes SET usedAt=${dbNow} WHERE userId=? AND codeHash=?`).bind(userId, hash),
    ],
  };
}
