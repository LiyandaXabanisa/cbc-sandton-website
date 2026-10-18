-- ===================================================================
-- CBC Sandton: set the backup token
--
-- 1. Make up a long random token (at least 24 characters). A password
--    manager's "generate password" button is ideal. Keep it private.
-- 2. Replace PASTE-YOUR-TOKEN below with it, and run this once.
-- 3. Save the SAME token as the GitHub secret BACKUP_TOKEN.
--
-- Only a fingerprint of the token is stored here, never the token itself.
-- Running this again with a new token replaces the old one.
-- ===================================================================

insert into backup_settings (id, token_hash)
values (1, encode(extensions.digest('PASTE-YOUR-TOKEN', 'sha256'), 'hex'))
on conflict (id) do update set token_hash = excluded.token_hash;
