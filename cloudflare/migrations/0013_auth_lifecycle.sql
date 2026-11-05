-- New users remain pending until a single-use setup invitation is accepted.
ALTER TABLE users ADD COLUMN passwordState TEXT NOT NULL DEFAULT 'active' CHECK(passwordState IN ('pending','active'));
ALTER TABLE users ADD COLUMN passwordVersion INTEGER NOT NULL DEFAULT 0 CHECK(passwordVersion>=0);
ALTER TABLE users ADD COLUMN passwordMutationId TEXT;
ALTER TABLE sessions ADD COLUMN passwordVersion INTEGER NOT NULL DEFAULT 0 CHECK(passwordVersion>=0);
CREATE TABLE auth_invitations (
 id TEXT PRIMARY KEY,
 tokenHash TEXT NOT NULL UNIQUE,
 churchId TEXT NOT NULL REFERENCES churches(id),
 personId TEXT NOT NULL,
 userId TEXT NOT NULL REFERENCES users(id),
 email TEXT NOT NULL COLLATE NOCASE,
 mode TEXT NOT NULL CHECK(mode IN ('setPassword','link','bootstrap')),
 roleId TEXT,
 passwordVersion INTEGER NOT NULL,
 createdBy TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 expiresAt TEXT NOT NULL,
 consumedAt TEXT,
 revokedAt TEXT,
 claimId TEXT UNIQUE,
 FOREIGN KEY(churchId,personId) REFERENCES people(churchId,id),
 CHECK(expiresAt>createdAt)
);
CREATE INDEX auth_invitations_person ON auth_invitations(churchId,personId,createdAt);
CREATE INDEX auth_invitations_expiry ON auth_invitations(expiresAt);
-- One atomic local bootstrap statement; there is deliberately no HTTP bootstrap route.
CREATE TABLE auth_bootstrap (
 id INTEGER PRIMARY KEY CHECK(id=1),
 churchId TEXT NOT NULL,
 personId TEXT NOT NULL,
 userId TEXT NOT NULL,
 invitationId TEXT NOT NULL,
 churchName TEXT NOT NULL,
 subDomain TEXT NOT NULL,
 email TEXT NOT NULL,
 firstName TEXT NOT NULL,
 lastName TEXT NOT NULL,
 tokenHash TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 expiresAt TEXT NOT NULL
);
CREATE TRIGGER auth_bootstrap_empty BEFORE INSERT ON auth_bootstrap WHEN EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM churches) BEGIN SELECT RAISE(ABORT,'Bootstrap requires an empty installation'); END;
CREATE TRIGGER auth_bootstrap_create AFTER INSERT ON auth_bootstrap BEGIN INSERT INTO churches(id,name,subDomain) VALUES(NEW.churchId,NEW.churchName,NEW.subDomain); INSERT INTO people(id,churchId,firstName,lastName,email,contactInfo,membershipStatus,dateAdded) VALUES(NEW.personId,NEW.churchId,NEW.firstName,NEW.lastName,NEW.email,json_object('email',NEW.email),'Member',NEW.createdAt); INSERT INTO users(id,email,firstName,lastName,passwordHash,passwordState) VALUES(NEW.userId,NEW.email,NEW.firstName,NEW.lastName,'!pending','pending'); INSERT INTO user_churches(userId,churchId,personId,role) VALUES(NEW.userId,NEW.churchId,NEW.personId,'admin'); INSERT INTO auth_invitations(id,tokenHash,churchId,personId,userId,email,mode,passwordVersion,createdBy,createdAt,expiresAt) VALUES(NEW.invitationId,NEW.tokenHash,NEW.churchId,NEW.personId,NEW.userId,NEW.email,'bootstrap',0,'local-bootstrap',NEW.createdAt,NEW.expiresAt); INSERT INTO audit_log(id,churchId,userId,action,entityId,createdAt) VALUES(NEW.invitationId,NEW.churchId,NEW.userId,'security.bootstrap.pending',NEW.userId,NEW.createdAt); END;
