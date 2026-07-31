# Attachment privacy on private boards

**Status:** Option 1 shipped (EFB-57). Options 2-5 open.
**Date:** 2026-07
**Tickets:** EFB-49 (discovery), EFB-57 (this decision)

## The situation

A board's `visibility: "private"` gates reads of issues, comments, sprints and the board row itself on membership. **It does not gate attachment blobs.**

`attachment.blob_url` is a Blossom BUD-01/02 URL of the form `<host>/<sha256>`. It carries no token, no signature and no expiry, and the path *is* the hash of the bytes. Anyone holding the URL can fetch the file, so **sharing a link is sharing the file** — that is the primary exposure and the one the UI notice names.

Content-addressing adds a second, much narrower effect that is easy to overstate. It is tempting to say "anyone who hashes the same file can fetch it," but deriving the address requires the bytes, and someone holding the bytes already holds the file — the fetch teaches them nothing. What it actually yields is an **existence oracle**: anyone with a copy can probe whether those bytes are stored on the host. Two qualifiers keep it in proportion — a hit proves "these bytes are on this shared host," not "this was uploaded to Evenflow," and the oracle only becomes content-disclosing for low-entropy files whose contents can be enumerated and hashed until one hits. Real, worth documenting, not the headline.

This is not a bug. It is the defining property of content-addressed storage, and it buys real things: deduplication, host portability, and verifiability (you can check the bytes against the name). The cost is that it does not compose with membership-gated privacy, and users reasonably read "private board" as "private everything."

`tests/integration/attachments-cross-board.test.ts` case 4 pins this shape deliberately — that the URL is unscoped, that it serves to an unauthenticated caller, and that board visibility does not gate the blob. **That test is a ratchet.** If a future change quietly moves to presigned URLs, it fails and forces this conversation rather than letting the semantics drift.

## What we chose: Option 1 — document and warn

Ship honesty, not a mechanism. A notice on the attachment panel for non-public boards, a user-facing explainer at `/docs#attachment-privacy`, and this record.

**Why this and not a fix.** Every real fix (2-5 below) trades away something structural — BYO-host, content-addressing, or the feature itself. None of those trades should be made in a hurry to close a surprise that is, at bottom, a documentation gap. A user who knows the property can route around it in seconds by not uploading the sensitive file. A user who doesn't know cannot. Closing the knowledge gap is cheap, reversible, and strictly additive to whichever option we later pick.

**What Option 1 does not do.** It does not make anything private. A user who ignores the notice is exactly as exposed as before. This is informed consent, not protection, and it should not be described internally as if it were the latter.

## The options we did not take

Listed so the next design pass starts warm rather than re-deriving.

### Option 2 — server-side encrypt to the board's audience key

Encrypt the blob before upload; decrypt on read for members.

- **Preserves** `visibility: private` semantics end to end. The strongest guarantee of the five.
- **Breaks BYO-Blossom-host.** The stored bytes are ciphertext, so a generic host cannot serve them to a browser directly. Needs a decrypt proxy in front of every read, which puts Evenflow back in the media-serving path we deliberately left.
- **Breaks dedup and cover-image rendering** — `<img src={blob_url}>` stops working, since the browser can't decrypt.
- **Key rotation is the hard part.** Audience epochs rotate on membership change; blobs encrypted to epoch N need re-encryption or a key-history read path, and neither is small.
- **Lift:** large.

### Option 3 — content-addressed key derivation

Derive the storage key from content *plus* a board secret, so the same file on a public and a private board lands at different addresses.

- **Closes the existence oracle** specifically — without the board secret you can no longer probe whether a given file is stored, and the low-entropy enumeration case goes with it.
- **Does not close the URL-sharing vector**, which is the primary exposure. The derived URL is still public once known. So this option addresses the *narrower* half of the problem and leaves the common one untouched — worth weighing hard against its cost.
- **Breaks content-addressing's actual benefit** — no cross-board dedup, and the address no longer verifies the bytes.
- **Lift:** medium-large, and the payoff is partial. Weakest ratio of the four.

### Option 4 — signed-URL layer

A Worker sits between client and Blossom, mints short-lived per-request URLs, and authorizes against board membership.

- **Preserves Blossom-native storage.** Bytes stay plaintext and content-addressed; the auth boundary is added in front rather than baked in.
- **Keeps `<img>` working** with a signed URL, unlike Option 2.
- **Adds a request in the hot path** for every attachment view, and Evenflow becomes a dependency for media that currently loads without it.
- **Leaks on share, by design** — a signed URL is still a bearer token until it expires. Shortens the exposure window rather than eliminating it.
- **Note:** the raw Blossom URL remains fetchable unless the host is also locked down, so this is only as strong as the host's access control. Worth checking before costing it.
- **Lift:** medium. Best cost/benefit of the four if we want a real mechanism.

### Option 5 — attachments on public boards only

Refuse uploads when `visibility !== "public"`.

- **Simplest and fully honest** — no gap between promise and behavior.
- **Removes a feature people use** on exactly the boards most likely to want it.
- Worth naming as the floor: if we ever conclude the gap can't be closed acceptably, this is the fallback, not an absurdity.
- **Lift:** small.

## Revisit when

- Someone asks for private attachments in a way that implies a compliance obligation. Option 1 stops being adequate the moment the requirement is external rather than expectational.
- We build a media proxy for another reason. Options 2 and 4 both get materially cheaper once one exists.
- BYO-Blossom-host stops being a goal — that constraint is what rules Option 2 out today.
