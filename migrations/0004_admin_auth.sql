-- Account/password and discoverable Passkeys replace the bootstrap-only secret.
-- No historical registry, evidence, or prior audit rows are rewritten.
CREATE TABLE admin_accounts (
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  webauthn_user_id TEXT NOT NULL UNIQUE,
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Earlier bearer-bootstrap sessions must not gain account authority by upgrade.
DELETE FROM admin_sessions;
ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'bootstrap' CHECK (role IN ('bootstrap','admin'));
ALTER TABLE admin_sessions ADD COLUMN account_id TEXT REFERENCES admin_accounts(id);
ALTER TABLE admin_sessions ADD COLUMN auth_version INTEGER;
ALTER TABLE admin_sessions ADD COLUMN reauthenticated_at_ms INTEGER;

CREATE TABLE admin_passkeys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES admin_accounts(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports_json TEXT NOT NULL CHECK (json_valid(transports_json)),
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0,1)),
  name TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX admin_passkeys_account ON admin_passkeys(account_id);

CREATE TABLE admin_auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('registration','login','reauth')),
  account_id TEXT NOT NULL REFERENCES admin_accounts(id),
  auth_version INTEGER NOT NULL,
  session_sha256 TEXT,
  binding_sha256 TEXT,
  name TEXT,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  claim_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_auth_challenges_expiry ON admin_auth_challenges(expires_at_ms);

CREATE TABLE admin_auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX admin_auth_rate_expiry ON admin_auth_rate_limits(expires_at_ms);
CREATE TRIGGER admin_auth_rate_capacity BEFORE INSERT ON admin_auth_rate_limits
WHEN NOT EXISTS (SELECT 1 FROM admin_auth_rate_limits WHERE bucket=NEW.bucket)
  AND (SELECT COUNT(*) FROM admin_auth_rate_limits) >= 4096
BEGIN SELECT RAISE(ABORT, 'auth_rate_capacity'); END;
CREATE TRIGGER admin_auth_challenge_capacity BEFORE INSERT ON admin_auth_challenges
WHEN (SELECT COUNT(*) FROM admin_auth_challenges) >= 2048
BEGIN SELECT RAISE(ABORT, 'auth_challenge_capacity'); END;
CREATE TRIGGER admin_passkey_capacity BEFORE INSERT ON admin_passkeys
WHEN (SELECT COUNT(*) FROM admin_passkeys WHERE account_id=NEW.account_id) >= 20
BEGIN SELECT RAISE(ABORT, 'auth_passkey_capacity'); END;
