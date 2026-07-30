-- Evenflow D1 schema — migration 0020: bind an invite to a specific pubkey.
--
-- Existing bindings: unbound (URL bearer, first-key wins) or bind_to_email
-- (requires email proof). AI-agent invites want a third: pre-issue a code
-- knowing exactly which Nostr identity should accept it, so no human racing
-- the URL can steal the seat. 64-hex lowercase (validated at write time).

ALTER TABLE inviteCache ADD COLUMN bind_to_pubkey TEXT;
