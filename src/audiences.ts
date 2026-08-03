// Private-board audience lifecycle (phase 16.5).
//
// A private board (visibility = 'private' with a minted audience) owns one 4a
// audience:
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
import { enqueueOutboundWebhooks } from "./lib/webhook-dispatch";
import { __signEvent, wrap, type NostrEvent } from "./lib/audience/nip17";
import {
  buildAudienceDeclaration,
  buildKeyGrant,
  FA_CONTEXT_V0,
  type EventTemplate,
} from "./lib/audience/audience-events";
import { blake3ContentTag } from "./lib/audience/blake3-tag";
import { openScalarFromServer, type ServerAudienceKeys } from "./lib/audience-store";
import { realPubkeyOfMember } from "./nostr";
import type { BoardEvent } from "./durable-objects/BoardDO";
import { publishPlaintextEvent, publishesPlaintext } from "./lib/kanban/publish";

/**
 * Ceiling on what a board mutation will wait for the substrate mirror.
 * Generous enough for a healthy gateway round-trip including relay fan-out,
 * short enough that an unhealthy one is a blip rather than a hang.
 */
const PUBLISH_TIMEOUT_MS = 3_000;

const bytesToHexLocal = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Encrypted event kinds (PLAN.md: plain 30550-30554, encrypted +5). */
const KIND_ENCRYPTED_BOARD = 30555;
const KIND_ENCRYPTED_ISSUE = 30556;
const KIND_ENCRYPTED_COMMENT = 30557;
/** Encrypted variant of KIND_SPRINT_TIDE (30560), same +5 convention (EFB-22). */
export const KIND_ENCRYPTED_TIDE = 30565;

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
    // audience_pubkey going non-null is what makes encryption live (with
    // visibility = 'private'). is_encrypted is a dead column since 0015 —
    // still written so hand-run SQL against boardCache tells the truth,
    // never read.
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

    // EFB-36: republish the 30520 with the CURRENT roster. Without this the
    // gateway's member set stays frozen at whatever it was when the board was
    // flipped private — flipBoardPrivate and rotateBoardAudience both refresh
    // the declaration, this path did not — so every member added afterwards
    // (and every new ephemeral session key) held a D1 grant the wrap
    // validator had never heard of.
    //
    // The consequence was total, not partial: runPublishWraps pre-flights
    // every wrap against the declaration and fail-fasts 400 on the first
    // non-member recipient, deliberately, so one unknown recipient rejected
    // the whole fan-out. The dogfood board had 6 grant recipients against a
    // 2-member declaration and had never landed a single encrypted tide.
    //
    // Publishes the FULL recipient set, not the `issued` delta: passing only
    // the new grants would drop everyone already in the declaration and break
    // wraps for them instead — the same bug pointed the other way. Reading
    // grantRecipients here means the declaration is built from the very table
    // the wrap fan-out enumerates, so the two agree by construction.
    //
    // Unconditional rather than gated on `issued.length > 0`: a join that
    // grants nothing new (the member already held a grant) is exactly the
    // case where an already-stale declaration would otherwise never heal.
    // Member-add is rare and the post is best-effort, so the extra call is
    // cheap insurance.
    yield* publishDeclaration(board, keys, yield* grantRecipients(board.id, keys.epoch));

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

/**
 * Prefix switch with a silent default: anything unrecognized publishes as a
 * board event. Add a branch here for every new event family, or its wraps go
 * out under 30555 — a valid wrap of the wrong kind, which no consumer will
 * flag.
 */
const encryptedKindOf = (event: BoardEvent): number => {
  if (event.kind.startsWith("issue.")) return KIND_ENCRYPTED_ISSUE;
  if (event.kind.startsWith("comment.")) return KIND_ENCRYPTED_COMMENT;
  if (event.kind.startsWith("sprint.tide.")) return KIND_ENCRYPTED_TIDE;
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
    const entityId = event.entity_id ?? event.issue_id ?? event.comment_id ?? board.id;
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
    // Each recipient's wrap has its own id; the rumor's is the one that
    // identifies the event itself, so that's what a cache row points at.
    return {
      sseEvent,
      wraps,
      audienceAddress: `30520:${keys.audIdPub}:${board.id}`,
      signerPriv: keys.audIdPriv,
      rumorId: rumor.id,
    };
  });

/**
 * The private-board emit path: encrypt the payload, fan wraps to the
 * substrate (best-effort), and hand back the SSE-safe event. Falls back to
 * a payload-stripped event when key material is unavailable — a private
 * board must never fan out plaintext.
 */
export interface SecuredBoardEvent {
  /** SSE-safe event: payload replaced with the encrypted envelope. */
  readonly event: BoardEvent;
  /**
   * Rumor id when the wraps actually reached the substrate, else null. A
   * cache row stamps this on success and leaves NULL on an outage — see
   * migration 0021's sprintTideSnapshot.substrate_event_id.
   */
  readonly substrate_event_id: string | null;
}

export const secureBoardEvent = (
  board: BoardShape,
  event: BoardEvent,
): Effect.Effect<SecuredBoardEvent, never, Db | Audience> =>
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
      return {
        event: { ...event, payload: { enc: true as const, epoch: board.audience_epoch, ciphertext: null } },
        substrate_event_id: null,
      };
    }
    let published = false;
    if (result.wraps.length > 0) {
      const posted = yield* bestEffortAudience(
        `wraps:${board.id}:${event.kind}`,
        audience.rawPost(
          "/v0/audience/raw/publish-wraps",
          { audience_address: result.audienceAddress, gift_wraps: result.wraps },
          result.signerPriv,
        ),
      );
      published = posted !== null;
    }
    return {
      event: result.sseEvent,
      substrate_event_id: published ? result.rumorId : null,
    };
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
 *
 * Returns the substrate event id when a private board's wraps landed, else
 * null — callers caching a substrate row (tide snapshots) stamp it; every
 * other call site ignores it, exactly as before.
 *
 * `snapshot` overrides the freshness re-read below, and exists for exactly one
 * caller: the board delete handler (EFB-32). Every other call site emits about
 * a row that outlives the emit, so re-reading is free correctness — it picks up
 * whatever the mutation just committed. `board.deleted` is the one kind whose
 * subject IS the row being deleted, so the re-read returns null, publishesPlaintext
 * fails closed on the null, and the tombstone is silently swallowed 100% of the
 * time. That is why EFB-24 deferred this kind. Passing the pre-delete snapshot
 * keeps the gate's fail-closed posture intact — it still decides from a real
 * board row, just one held in memory rather than re-read from a table the
 * caller has already emptied.
 *
 * The general rule, for whoever needs this next: pass a snapshot exactly when
 * the gate's re-read target and the mutation's delete target are the same row.
 * Anywhere else, don't — a stale snapshot would defeat the freshness read and
 * publish a board state the mutation has already superseded.
 */
export const emitSecureBoardEvent = (
  board_id: string,
  event: BoardEvent,
  snapshot?: BoardShape,
): Effect.Effect<string | null, never, Db | Audience | BoardEmitter> =>
  Effect.gen(function* () {
    const board =
      snapshot ??
      (yield* loadBoardById(board_id).pipe(Effect.catchAll(() => Effect.succeed(null))));
    const secured =
      board !== null && board.encryption_active
        ? yield* secureBoardEvent(board, event)
        : { event, substrate_event_id: null };
    yield* emitBoardEvent(board_id, secured.event);

    // EFB-24: the public counterpart of the wrap above. Gated on
    // `publishesPlaintext`, NOT on `!encryption_active` — see that function
    // for why the difference matters (a board can be private with no
    // audience, and that state's negation is not "public").
    //
    // AWAITED, not forked. The first cut used Effect.forkDaemon to keep
    // gateway latency off the request path, and it did not publish a single
    // event in production: Cloudflare cancels outstanding work as soon as the
    // response is returned, so the fiber never got scheduled. Verified by
    // `wrangler tail` — the request logged outcome "ok" with the audit line
    // and NONE of this module's warn logs, not even the no-key one, which
    // only happens if the code never ran at all.
    //
    // ctx.waitUntil is the runtime's answer to that, but reaching it means
    // threading Hono's ExecutionContext through 52 `layerFor(c.env)`
    // boundaries and reshaping the LayerFor testability seam. Not worth it
    // for a best-effort mirror, so the publish is awaited and bounded
    // instead: a mutation pays at most PUBLISH_TIMEOUT_MS, and a gateway that
    // is slow or down costs a substrate event rather than a board write.
    //
    // A publish that adds latency beats a publish that silently never
    // happens — which is precisely what this ticket exists to fix.
    if (board !== null && publishesPlaintext(board)) {
      yield* publishPlaintextEvent(board, event).pipe(
        Effect.timeoutTo({
          duration: PUBLISH_TIMEOUT_MS,
          onTimeout: () => {
            console.log(
              JSON.stringify({ warn: "kanban-publish-timeout", board_id, kind: event.kind }),
            );
            return null;
          },
          onSuccess: (id: string | null) => id,
        }),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.log(
              JSON.stringify({
                warn: "kanban-publish-failed",
                board_id,
                kind: event.kind,
                error: String(e),
              }),
            );
            return null;
          }),
        ),
      );
    }
    // EFB-13: queue outbound webhook deliveries. ROWS ONLY — deliberately no
    // network I/O here. The comment above explains why anything else is not
    // available at this site: there is no ExecutionContext to reach
    // ctx.waitUntil with, and forkDaemon demonstrably runs nothing. So the
    // emit path writes pending rows and a once-a-minute cron sweep performs
    // every POST (src/lib/webhook-dispatch.ts).
    //
    // `enqueueOutboundWebhooks` cannot fail by construction — a webhook
    // bookkeeping problem must never turn a committed board mutation into an
    // error — so this needs no catch of its own. Uses `event.at_ms` as the
    // enqueue clock so the delivery row carries the same instant the event
    // does, and so this line adds no new dependency to the emit path.
    //
    // EFB-62 — TWO events, and the order of the arguments is load-bearing.
    // `event` is the plaintext one and is used ONLY to evaluate subscription
    // predicates, which cannot read an encrypted payload. `secured.event` is
    // what is persisted and POSTed: on a private board that is the same
    // NIP-44 wrap a member receives over SSE, so a subscriber never gets bytes
    // their membership could not already decrypt. On a public board the two
    // are the same object and this is a no-op.
    //
    // Passing `event` for both — which is what this line did before EFB-62 —
    // is precisely the bug: combined with a gate that read private boards as
    // public, it POSTed a private board's cleartext titles and bodies to any
    // registered URL.
    if (board !== null) {
      yield* enqueueOutboundWebhooks(board, event, secured.event, event.at_ms);
    }
    return secured.substrate_event_id;
  });
