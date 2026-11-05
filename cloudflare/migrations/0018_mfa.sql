-- Active factors and pending enrollment are separate; all stored secrets are authenticated ciphertext.
CREATE TABLE auth_mfa (userId TEXT PRIMARY KEY REFERENCES users(id), factorId TEXT NOT NULL UNIQUE, encryptedSecret TEXT NOT NULL, lastStep INTEGER NOT NULL DEFAULT -1, enabledAt TEXT NOT NULL);
CREATE TABLE auth_mfa_enrollments (userId TEXT PRIMARY KEY REFERENCES users(id), tokenHash TEXT NOT NULL UNIQUE, factorId TEXT NOT NULL UNIQUE, encryptedSecret TEXT NOT NULL, sessionId TEXT NOT NULL, passwordVersion INTEGER NOT NULL, expiresAt TEXT NOT NULL);
CREATE TABLE auth_mfa_codes (userId TEXT NOT NULL REFERENCES auth_mfa(userId) ON DELETE CASCADE, codeHash TEXT NOT NULL, usedAt TEXT, PRIMARY KEY(userId,codeHash));
CREATE TABLE auth_mfa_challenges (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), factorId TEXT NOT NULL, passwordVersion INTEGER NOT NULL, expiresAt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), consumedAt TEXT);
CREATE INDEX auth_mfa_challenges_user ON auth_mfa_challenges(userId,expiresAt);
CREATE TRIGGER revoke_mfa_password_version AFTER UPDATE OF passwordVersion ON users WHEN NEW.passwordVersion<>OLD.passwordVersion BEGIN DELETE FROM auth_mfa_challenges WHERE userId=NEW.id; DELETE FROM auth_mfa_enrollments WHERE userId=NEW.id; END;
CREATE TRIGGER revoke_mfa_disabled AFTER UPDATE OF disabled ON users WHEN NEW.disabled=1 BEGIN DELETE FROM auth_mfa_challenges WHERE userId=NEW.id; DELETE FROM auth_mfa_enrollments WHERE userId=NEW.id; END;
