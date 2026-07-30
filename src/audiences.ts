// Private-board audience lifecycle (phase 16.5).
//
// A private board (boardCache.is_encrypted = 1) owns one 4a audience:
// aud_id keypair (never rotates, signs everything) + one keypair per
// epoch. Epochs bump on member removal — honest crypto: the old key is
// dead for every event published after the rotation, no soft revocation.
//
// D1 is authoritative for evenflow's own clients: grants live in
// boardMemberKeyGrant (NIP-44 raw-scalar ciphertexts to per-session
// pubkeys) and key material in boardAudienceKey (sealed to the server
// audience key). The 4a substrate mirror (30520 declaration + 30521
// grants + gift-wrapped 30555-30559 events) is best-effort: outages log
// `audience-publish-deferred` and never fail a mutation.
//
// Roster note (v1): the substrate declaration's p-tags are the LIVE
// session pubkeys of members at publish time. Session keys churn on
// login, so the mirror's roster trails reality between republishes —
// evenflow's own read path never depends on it.

import { Clock, Effect } from "effect";
import { Audience, bestEffortAudience } from "./effects/Audience";
import { BoardEmitter, Db, emitBoardEvent, type DbError } from "./effects";
import { parseBoardRow, type BoardShape } from "./shapes";
import {
  generateAudienceIdentity,
  generateEpochKeypair,
} from "./lib/audience/audience-keys";
import { encrypt, encryptString } from "./lib/audience/nip44";
import { __signEvent, wrap, type NostrEvent } from "./lib/audience/nip17";
import {
  buildAudienceDeclaration,
  buildKeyGrant,
  type EventTemplate,
} from "./lib/audience/audience-events";
import { blake3ContentTag } from "./lib/audience/blake3-tag";
import { openScalarFromServer, type ServerAudienceKeys } from "./lib/audience-store";
import { realPubkeyOfMember } from "./nostr";
import type { BoardEvent } from "./durable-objects/BoardDO";

const bytesToHexLocal = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Encrypted event kinds (PLAN.md: plain 30550-30554, encrypted +5). */
const KIND_ENCRYPTED_BOARD = 30555;
const KIND_ENCRYPTED_ISSUE = 30556;
const KIND_ENCRYPTED_COMMENT = 30557;

const FA_CONTEXT_V0 = "https://4a4.ai/ns/v0";

/** Substrate name kept generic on purpose: no board-title leak on the 30520. */
const DECLARATION_NAME = "evenflow-private-board";

export class AudienceKeyError extends Error {
  readonly _tag = "AudienceKeyError";
  constructor(readonly reason: "not-configured" | "key-missing" | "key-unsealable") {
    super(`audience key error: ${reason}`);
    this.name = "AudienceKeyError";
  }
}

// ── membership + session-key enumeration ──────────────────────────────────

/** Every pubkey with access to the board: explicit grants ∪ org members. */
export const boardMemberPubkeys = (board: BoardShape) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const explicit = yield* db.queryAll<{ pubkey: string }>(
      "SELECT pubkey FROM boardMemberCache WHERE board_id = ?",
      [board.id],
    );
    const viaOrg =
      board.org_id === null
        ? []
        : yield* db.queryAll<{ pubkey: string }>(
            "SELECT pubkey FROM orgMemberCache WHERE org_id = ?",
            [board.org_id],
          );
    return [...new Set([...explicit.map((r) => r.pubkey), ...viaOrg.map((r) => r.pubkey)])];
  });

/** Unexpired registered session pubkeys for one member identity. */
export const liveSessionPubkeys = (memberPubkey: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* db.queryAll<{ session_pubkey: string }>(
      "SELECT session_pubkey FROM sessionKeyRegistrations WHERE member_pubkey = ? AND expires_at_ms > ?",
      [memberPubkey, now],
    );
    return [...new Set(rows.map((r) => r.session_pubkey))];
  });

// ── key material ──────────────────────────────────────────────────────────

export interface EpochKeys {
  readonly epoch: number;
  readonly audIdPub: string;
  readonly audIdPriv: Uint8Array;
  readonly epochPub: string;
  readonly epochPriv: Uint8Array;
}

/** Load + unseal one epoch's key material. */
export const loadEpochKeys = (boardId: string, epoch: number) =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const db = yield* Db;
    const serverKeys = audience.serverKeys();
    if (serverKeys === null) return yield* Effect.fail(new AudienceKeyError("not-configured"));
    const row = yield* db.queryFirst<{
      aud_id_pubkey: string;
      epoch_pubkey: string;
      aud_id_priv_ciphertext: string;
      epoch_priv_ciphertext: string;
      sender_pubkey: string;
    }>("SELECT * FROM boardAudienceKey WHERE board_id = ? AND epoch = ?", [boardId, epoch]);
    if (row === null) return yield* Effect.fail(new AudienceKeyError("key-missing"));
    const audIdPriv = openScalarFromServer(serverKeys, row.aud_id_priv_ciphertext, row.sender_pubkey);
    const epochPriv = openScalarFromServer(serverKeys, row.epoch_priv_ciphertext, row.sender_pubkey);
    if (audIdPriv === null || epochPriv === null) {
      return yield* Effect.fail(new AudienceKeyError("key-unsealable"));
    }
    return {
      epoch,
      audIdPub: row.aud_id_pubkey,
      audIdPriv,
      epochPub: row.epoch_pubkey,
      epochPriv,
    } satisfies EpochKeys;
  });

/** Mint + seal + insert a boardAudienceKey row for (board, epoch). */
const storeEpochKeys = (
  boardId: string,
  epoch: number,
  audId: { pub: string; priv: Uint8Array },
  serverKeys: ServerAudienceKeys,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const epochKp = generateEpochKeypair();
    // One throwaway sender per row seals BOTH scalars — the row stores a
    // single sender_pubkey, so both ciphertexts must share it.
    const sender = generateEpochKeypair();
    const audIdCiphertext = encrypt(audId.priv, sender.priv, serverKeys.pubkeyHex);
    const epochCiphertext = encrypt(epochKp.priv, sender.priv, serverKeys.pubkeyHex);
    sender.priv.fill(0);
    yield* db.execute(
      "INSERT INTO boardAudienceKey (board_id, epoch, aud_id_pubkey, epoch_pubkey, aud_id_priv_ciphertext, epoch_priv_ciphertext, sender_pubkey, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [boardId, epoch, audId.pub, epochKp.pub, audIdCiphertext, epochCiphertext, sender.pub, now],
    );
    return epochKp;
  });

// ── grants ────────────────────────────────────────────────────────────────

/**
 * Issue current-epoch grants to every live session key of `memberPubkey`
 * that doesn't already hold one. Grant ciphertext = bare epoch scalar,
 * NIP-44 from aud_id → session pub (client decrypts with sessionPriv +
 * board.audience_pubkey).
 */
export const issueGrantsForMember = (board: BoardShape, memberPubkey: string, keys: EpochKeys) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const sessions = yield* liveSessionPubkeys(memberPubkey);
    // 16.7: a Nostr member's REAL pubkey is always a recipient — level-4
    // from the moment of invite, before (and regardless of) any sign-in.
    const realPubkey = realPubkeyOfMember(memberPubkey);
    const recipients = [...new Set([...sessions, ...(realPubkey === null ? [] : [realPubkey])])];
    const issued: string[] = [];
    for (const sessionPub of recipients) {
      const existing = yield* db.queryFirst(
        "SELECT id FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, sessionPub, keys.epoch],
      );
      if (existing !== null) continue;
      // Wire nuance: real-pubkey recipients get the scalar sealed as a HEX
      // STRING (NIP-44 plaintext must be valid UTF-8 for standard NIP-07
      // `nip44.decrypt` to round-trip it); ephemeral session keys keep
      // 16.5's raw-scalar sealing, decrypted by our own vendored code.
      const ciphertext =
        sessionPub === realPubkey
          ? encryptString(bytesToHexLocal(keys.epochPriv), keys.audIdPriv, sessionPub)
          : encrypt(keys.epochPriv, keys.audIdPriv, sessionPub);
      yield* db.execute(
        "INSERT INTO boardMemberKeyGrant (id, board_id, member_pubkey, recipient_pubkey, epoch, grant_ciphertext, grant_sender_pubkey, issued_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), board.id, memberPubkey, sessionPub, keys.epoch, ciphertext, keys.audIdPub, now, null],
      );
      issued.push(sessionPub);
    }
    return issued;
  });

/** Recipient session pubs holding an unrevoked grant at the given epoch. */
const grantRecipients = (boardId: string, epoch: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll<{ recipient_pubkey: string }>(
      "SELECT recipient_pubkey FROM boardMemberKeyGrant WHERE board_id = ? AND epoch = ? AND revoked_at_ms IS NULL",
      [boardId, epoch],
    );
    return [...new Set(rows.map((r) => r.recipient_pubkey))];
  });

// ── substrate mirror (best-effort) ────────────────────────────────────────

const signTemplate = (tpl: EventTemplate, pub: string, priv: Uint8Array): NostrEvent =>
  __signEvent(
    { kind: tpl.kind, pubkey: pub, created_at: tpl.created_at, tags: tpl.tags, content: tpl.content },
    priv,
  );

/** Republish the board's 30520 declaration with the current roster. */
const publishDeclaration = (board: BoardShape, keys: EpochKeys, members: string[]) =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const now = yield* Clock.currentTimeMillis;
    const tpl = buildAudienceDeclaration({
      audIdPub: keys.audIdPub,
      slug: board.id,
      name: DECLARATION_NAME,
      epoch: keys.epoch,
      epochPub: keys.epochPub,
      members,
      createdAt: Math.floor(now / 1000),
    });
    const declaration = signTemplate(tpl, keys.audIdPub, keys.audIdPriv);
    yield* bestEffortAudience(
      `declaration:${board.id}:${keys.epoch}`,
      audience.rawPost(
        "/v0/audience/raw/publish-declaration",
        { audience_address: `30520:${keys.audIdPub}:${board.id}`, declaration },
        keys.audIdPriv,
      ),
    );
  });

/** Mirror one D1 grant as a kind-30521 to the substrate. */
const publishGrantEvent = (board: BoardShape, keys: EpochKeys, recipientPub: string, ciphertext: string) =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const now = yield* Clock.currentTimeMillis;
    const tpl = buildKeyGrant({
      audIdPub: keys.audIdPub,
      slug: board.id,
      epoch: keys.epoch,
      recipientPub,
      ciphertext,
      createdAt: Math.floor(now / 1000),
    });
    const grant = signTemplate(tpl, keys.audIdPub, keys.audIdPriv);
    yield* bestEffortAudience(
      `grant:${board.id}:${keys.epoch}:${recipientPub.slice(0, 8)}`,
      audience.rawPost(
        "/v0/audience/raw/grant",
        { audience_address: `30520:${keys.audIdPub}:${board.id}`, grant },
        keys.audIdPriv,
      ),
    );
  });

// ── lifecycle: flip, member add, member remove ────────────────────────────

/**
 * Flip a board private: mint aud_id + epoch-1 keys, grant every current
 * member's live sessions, mirror the declaration. Caller updates
 * boardCache flags with the returned identity.
 */
export const initializeBoardAudience = (board: BoardShape) =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const db = yield* Db;
    const serverKeys = audience.serverKeys();
    if (serverKeys === null) return yield* Effect.fail(new AudienceKeyError("not-configured"));

    const audId = generateAudienceIdentity();
    const epochKp = yield* storeEpochKeys(board.id, 1, audId, serverKeys);
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "UPDATE boardCache SET is_encrypted = 1, audience_epoch = 1, audience_pubkey = ?, updated_at_ms = ? WHERE id = ?",
      [audId.pub, now, board.id],
    );

    const keys: EpochKeys = {
      epoch: 1,
      audIdPub: audId.pub,
      audIdPriv: audId.priv,
      epochPub: epochKp.pub,
      epochPriv: epochKp.priv,
    };
    const members = yield* boardMemberPubkeys(board);
    const allRecipients: string[] = [];
    for (const member of members) {
      allRecipients.push(...(yield* issueGrantsForMember(board, member, keys)));
    }
    yield* publishDeclaration(board, keys, allRecipients);
    for (const recipient of allRecipients) {
      const row = yield* db.queryFirst<{ grant_ciphertext: string }>(
        "SELECT grant_ciphertext FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, recipient, 1],
      );
      if (row !== null) yield* publishGrantEvent(board, keys, recipient, row.grant_ciphertext);
    }
    return { audience_pubkey: audId.pub, audience_epoch: 1 };
  });

/** Member added to a private board: grant their live sessions at the current epoch. */
export const grantMemberOnJoin = (board: BoardShape, memberPubkey: string) =>
  Effect.gen(function* () {
    const keys = yield* loadEpochKeys(board.id, board.audience_epoch);
    const issued = yield* issueGrantsForMember(board, memberPubkey, keys);
    for (const recipient of issued) {
      const db = yield* Db;
      const row = yield* db.queryFirst<{ grant_ciphertext: string }>(
        "SELECT grant_ciphertext FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, recipient, keys.epoch],
      );
      if (row !== null) yield* publishGrantEvent(board, keys, recipient, row.grant_ciphertext);
    }
    return issued;
  });

/**
 * Member removed: bump the epoch, revoke every old grant, re-grant the
 * remaining members, mirror a rotate. Honest crypto — events published
 * after this are unreadable with any pre-rotation key.
 */
export const rotateBoardAudience = (board: BoardShape, removedPubkey: string | null) =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const db = yield* Db;
    const serverKeys = audience.serverKeys();
    if (serverKeys === null) return yield* Effect.fail(new AudienceKeyError("not-configured"));

    const current = yield* loadEpochKeys(board.id, board.audience_epoch);
    const newEpoch = board.audience_epoch + 1;
    const audId = { pub: current.audIdPub, priv: current.audIdPriv };
    const epochKp = yield* storeEpochKeys(board.id, newEpoch, audId, serverKeys);
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "UPDATE boardCache SET audience_epoch = ?, updated_at_ms = ? WHERE id = ?",
      [newEpoch, now, board.id],
    );
    yield* db.execute(
      "UPDATE boardMemberKeyGrant SET revoked_at_ms = ? WHERE board_id = ? AND revoked_at_ms IS NULL",
      [now, board.id],
    );

    const keys: EpochKeys = {
      epoch: newEpoch,
      audIdPub: audId.pub,
      audIdPriv: audId.priv,
      epochPub: epochKp.pub,
      epochPriv: epochKp.priv,
    };
    const boardAfterRemoval = { ...board, audience_epoch: newEpoch };
    const members = (yield* boardMemberPubkeys(boardAfterRemoval)).filter(
      (m) => m !== removedPubkey,
    );
    const allRecipients: string[] = [];
    for (const member of members) {
      allRecipients.push(...(yield* issueGrantsForMember(boardAfterRemoval, member, keys)));
    }

    // Mirror as one raw/rotate: fresh declaration + the new-epoch grants.
    const nowSec = Math.floor(now / 1000);
    const declaration = signTemplate(
      buildAudienceDeclaration({
        audIdPub: keys.audIdPub,
        slug: board.id,
        name: DECLARATION_NAME,
        epoch: newEpoch,
        epochPub: keys.epochPub,
        members: allRecipients,
        createdAt: nowSec,
      }),
      keys.audIdPub,
      keys.audIdPriv,
    );
    const grantEvents: NostrEvent[] = [];
    for (const recipient of allRecipients) {
      const row = yield* db.queryFirst<{ grant_ciphertext: string }>(
        "SELECT grant_ciphertext FROM boardMemberKeyGrant WHERE board_id = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, recipient, newEpoch],
      );
      if (row === null) continue;
      grantEvents.push(
        signTemplate(
          buildKeyGrant({
            audIdPub: keys.audIdPub,
            slug: board.id,
            epoch: newEpoch,
            recipientPub: recipient,
            ciphertext: row.grant_ciphertext,
            createdAt: nowSec,
          }),
          keys.audIdPub,
          keys.audIdPriv,
        ),
      );
    }
    yield* bestEffortAudience(
      `rotate:${board.id}:${newEpoch}`,
      audience.rawPost(
        "/v0/audience/raw/rotate",
        { audience_address: `30520:${keys.audIdPub}:${board.id}`, declaration, grants: grantEvents },
        keys.audIdPriv,
      ),
    );
    return { audience_epoch: newEpoch };
  });

// ── encrypted event fan-out ───────────────────────────────────────────────

const encryptedKindOf = (event: BoardEvent): number => {
  if (event.kind.startsWith("issue.")) return KIND_ENCRYPTED_ISSUE;
  if (event.kind.startsWith("comment.")) return KIND_ENCRYPTED_COMMENT;
  return KIND_ENCRYPTED_BOARD;
};

export interface EncryptedPayload {
  readonly enc: true;
  readonly epoch: number;
  readonly ciphertext: string;
}

/**
 * Encrypt a board event's payload for SSE + build the substrate wraps.
 * Ciphertext sender is aud_id → epoch pub, so any grant holder decrypts
 * with (epochPriv, board.audience_pubkey).
 */
export const encryptBoardEvent = (board: BoardShape, event: BoardEvent) =>
  Effect.gen(function* () {
    const keys = yield* loadEpochKeys(board.id, board.audience_epoch);
    const ciphertext = encryptString(JSON.stringify(event.payload), keys.audIdPriv, keys.epochPub);
    const payload: EncryptedPayload = { enc: true, epoch: keys.epoch, ciphertext };
    const sseEvent: BoardEvent = { ...event, payload };

    const recipients = yield* grantRecipients(board.id, keys.epoch);
    const now = yield* Clock.currentTimeMillis;
    const entityId = event.issue_id ?? event.comment_id ?? board.id;
    const rumor = __signEvent(
      {
        kind: encryptedKindOf(event),
        pubkey: keys.audIdPub,
        created_at: Math.floor(now / 1000),
        tags: [
          ["d", `${board.id}:${entityId}`],
          ["a", `30520:${keys.audIdPub}:${board.id}`],
          ["fa:context", FA_CONTEXT_V0],
          ["fa:epoch", String(keys.epoch)],
          ["alt", `Evenflow encrypted board event`],
          ["blake3", blake3ContentTag(ciphertext)],
          ...recipients.map((r) => ["p", r]),
        ],
        content: ciphertext,
      },
      keys.audIdPriv,
    );
    const wraps = recipients.map((r) => wrap(rumor, keys.audIdPriv, r));
    return { sseEvent, wraps, audienceAddress: `30520:${keys.audIdPub}:${board.id}`, signerPriv: keys.audIdPriv };
  });

/**
 * The private-board emit path: encrypt the payload, fan wraps to the
 * substrate (best-effort), and hand back the SSE-safe event. Falls back to
 * a payload-stripped event when key material is unavailable — a private
 * board must never fan out plaintext.
 */
export const secureBoardEvent = (
  board: BoardShape,
  event: BoardEvent,
): Effect.Effect<BoardEvent, never, Db | Audience> =>
  Effect.gen(function* () {
    const audience = yield* Audience;
    const result = yield* encryptBoardEvent(board, event).pipe(
      Effect.catchAll((e: AudienceKeyError | DbError) =>
        Effect.sync(() => {
          console.log(
            JSON.stringify({ warn: "private-board-event-degraded", board_id: board.id, kind: event.kind, reason: e._tag === "AudienceKeyError" ? e.reason : "db" }),
          );
          return null;
        }),
      ),
    );
    if (result === null) {
      // No key material → emit the envelope only; members refetch via REST.
      return { ...event, payload: { enc: true as const, epoch: board.audience_epoch, ciphertext: null } };
    }
    if (result.wraps.length > 0) {
      yield* bestEffortAudience(
        `wraps:${board.id}:${event.kind}`,
        audience.rawPost(
          "/v0/audience/raw/publish-wraps",
          { audience_address: result.audienceAddress, gift_wraps: result.wraps },
          result.signerPriv,
        ),
      );
    }
    return result.sseEvent;
  });

/** Re-parse a board row by id — the emit path's freshness read. Null on
 *  any failure: emit is best-effort and must never 500 a committed write. */
export const loadBoardById = (boardId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [boardId]);
    if (row === null) return null;
    try {
      return parseBoardRow(row);
    } catch {
      return null;
    }
  });

/**
 * Drop-in replacement for emitBoardEvent at every post-commit fan-out
 * site: public boards emit exactly as before; private boards encrypt the
 * payload and mirror gift-wraps to the substrate first. Never fails.
 */
export const emitSecureBoardEvent = (
  board_id: string,
  event: BoardEvent,
): Effect.Effect<void, never, Db | Audience | BoardEmitter> =>
  Effect.gen(function* () {
    const board = yield* loadBoardById(board_id).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    const safe =
      board !== null && board.is_encrypted ? yield* secureBoardEvent(board, event) : event;
    yield* emitBoardEvent(board_id, safe);
  });
