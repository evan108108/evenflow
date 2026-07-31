-- Evenflow D1 schema — migration 0023: normalize identity references (EFB-38).
--
-- A pubkey FIELD that means "which person" is a reference with exactly one
-- written form, `<provider>:<id>`. Before EFB-38 the write paths accepted any
-- string, so bare 64-char hex could land in these columns as a second
-- identity for a key already present in its `nostr:`-prefixed form.
--
-- Defensive, not remedial. At the time of writing every value in every column
-- below is already canonical:
--
--   issueCache.assignee_pubkey   nostr:049b628c… × 30
--   boardMemberCache.pubkey      google:1045090… × 1, nostr:049b628c… × 2
--   orgMemberCache.pubkey        google:1045090… × 1, nostr:049b628c… × 1
--
-- so this changes 0 rows on the current database. It ships anyway to close
-- the window between deploying the write-path fix and any row written by an
-- older worker still in rotation, and to state the invariant in the schema
-- history where the next person will find it.
--
-- ON THE PREDICATE. The obvious form is wrong:
--
--     WHERE assignee_pubkey GLOB '[0-9a-f]*' AND length(assignee_pubkey) = 64
--
-- In GLOB, `[0-9a-f]*` means "one hex character, then anything" — it
-- constrains only the FIRST character. A 64-character string beginning with a
-- hex digit and containing any garbage after it matches, and would be given a
-- `nostr:` prefix it has no right to. Verified against prod D1: the string
-- 'a' followed by 63 'z' matches that predicate.
--
-- `NOT GLOB '*[^0-9a-f]*'` is the correct spelling — "contains no non-hex
-- character" — which, with the length check, is exactly a 64-char lowercase
-- hex key. Uppercase hex is deliberately NOT matched: no such row exists, and
-- folding case in SQL would silently merge two rows if one ever did. The
-- write path handles case; this only rescues the lowercase legacy spelling.
--
-- NOT touched, on purpose:
--   * inviteCache.bind_to_pubkey — a raw curve point BY DESIGN. The accept
--     path compares it against realPubkeyOfMember(callerPubkey), which strips
--     the `nostr:` prefix back off (src/nostr.ts). Prefixing it here would
--     break every pubkey-bound invite.
--   * sessionKeyRegistrations.session_pubkey — a session encryption key, not
--     a person.
--   * boardCache.audience_pubkey, boardMemberKeyGrant.recipient_pubkey — key
--     material, not identity references.

UPDATE issueCache
   SET assignee_pubkey = 'nostr:' || assignee_pubkey
 WHERE assignee_pubkey IS NOT NULL
   AND length(assignee_pubkey) = 64
   AND assignee_pubkey NOT GLOB '*[^0-9a-f]*';

UPDATE boardMemberCache
   SET pubkey = 'nostr:' || pubkey
 WHERE length(pubkey) = 64
   AND pubkey NOT GLOB '*[^0-9a-f]*';

UPDATE orgMemberCache
   SET pubkey = 'nostr:' || pubkey
 WHERE length(pubkey) = 64
   AND pubkey NOT GLOB '*[^0-9a-f]*';
