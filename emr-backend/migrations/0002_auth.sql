-- 0002_auth.sql
-- ავტორიზაცია: ლოკალური (argon2) და LDAP/AD ანგარიშები, refresh-სესიები, lockout.
-- ყველა ცვლილება უკუთავსებადია (ახალი სვეტები DEFAULT/NULL-ით).

CREATE TYPE auth_provider AS ENUM ('local', 'ldap');

-- LDAP მომხმარებელს ლოკალური პაროლი არ აქვს
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
    ADD COLUMN auth_provider         auth_provider NOT NULL DEFAULT 'local',
    ADD COLUMN ldap_username         CITEXT UNIQUE,            -- sAMAccountName (მაგ. giojik)
    ADD COLUMN must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN password_changed_at   TIMESTAMPTZ,
    ADD COLUMN failed_login_count    INT NOT NULL DEFAULT 0,
    ADD COLUMN locked_until          TIMESTAMPTZ,
    ADD COLUMN last_login_at         TIMESTAMPTZ;

ALTER TABLE users ADD CONSTRAINT chk_users_auth_provider CHECK (
    (auth_provider = 'local' AND password_hash IS NOT NULL)
 OR (auth_provider = 'ldap'  AND ldap_username IS NOT NULL)
);

-- როლების დახურული სია (API სპეციფიკაციაში გამოყენებული 'diagnostic'-ის ჩათვლით)
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (
    role IN ('admin', 'doctor', 'nurse', 'receptionist', 'billing', 'pharmacist', 'diagnostic')
);

-- Refresh-სესიები: ტოკენი ინახება მხოლოდ SHA-256 ჰეშად; rotation + reuse detection
CREATE TABLE auth_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id       UUID NOT NULL,                 -- ერთი login-ის ყველა rotation-ის ჯაჭვი
    token_hash      CHAR(64) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    revoke_reason   VARCHAR(50),                   -- 'rotated','logout','reuse_detected','password_changed'
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_auth_sessions_user   ON auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_family ON auth_sessions(family_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);
