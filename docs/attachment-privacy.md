# How attachment storage works

Short version: **a private board keeps its issues, comments and sprints to its members. It does not keep its attachment files private.** Anyone who gets a file's link can open it — so sharing a link is sharing the file.

This page explains that, plus one narrower technical case worth knowing about, so you can decide what to upload.

## What "private board" covers

On a private board, membership gates:

- the board itself, and whether it shows up at all
- issues, comments, sprints, labels
- the list of attachments on an issue, including each file's link

So a non-member cannot browse your board and collect file links. That part works.

## What it doesn't cover

**The file itself is not access-controlled.** Attachment links point at a storage host that serves the bytes to whoever asks. No sign-in, no membership check, no expiry.

That means two things can expose a file:

### 1. Sharing the link

Paste an attachment link into an email, a ticket, a chat, or anywhere outside the board, and whoever receives it can open the file. They don't need an Evenflow account or a place on your board. A forwarded link keeps working.

This is the common case, and it's what the notice on the upload panel is about.

### 2. Confirming a file exists — a narrower case

Attachment links are **content-addressed**: the address is a SHA-256 hash of the file's own bytes, so the same file always produces the same link.

```
https://blossom.band/<sha256-of-the-file>
```

It's tempting to read that as "anyone with the same file can fetch yours," but that isn't much of a risk on its own: to compute the address you need the bytes, and if you have the bytes you already have the file. Fetching it teaches you nothing new about its contents.

What it does leak is narrower and worth naming: **whether a given file is stored on the host at all.** Anyone holding a copy can hash it, probe the address, and learn from the answer. That is an existence oracle, not a file leak.

Two details that matter for judging it:

- **A hit means "these bytes are on this host," not "someone put them on Evenflow."** The default host is shared with other users and other applications, so a positive answer doesn't identify where the upload came from.
- **The oracle gets sharper when a file's content is guessable.** If a document is low-entropy — a standard template with one or two fields filled in, a short list, a config with known options — someone can generate candidates, hash each, and probe until one hits. There, confirmation of existence is also confirmation of *content*, without ever having held the file.

So this matters when the *fact of the file* is the sensitive part, or when its content is guessable enough to enumerate. For an ordinary document you wrote, it's close to a non-issue.

## Why it works this way

Attachments use [Blossom](https://github.com/hzrd149/blossom) (BUD-01/02), a content-addressed storage protocol. Content-addressing buys real things:

- **Verifiability** — the address is the hash, so you can check the bytes are the bytes.
- **Deduplication** — the same file stored once, however many issues reference it.
- **Portability** — no lock-in to one host; the address means the same thing anywhere.

The cost is that addresses are public and permanent by construction. An address derived from content cannot also be a secret, because anyone with the content can derive it. That trade is inherent to the model, not an oversight in our configuration, which is why the honest fix is to tell you rather than to quietly paper over it.

## What you can do today

- **Don't upload genuinely sensitive files to Evenflow attachments.** Credentials, contracts under NDA, personal data, anything with a legal duty attached — use purpose-built storage that gates on identity. The same goes for a file whose mere existence is the sensitive part.
- **Treat an attachment link like the file.** Sharing the link is sharing the file. There is no un-sharing; the address is permanent.
- **Bring your own storage** if your organization needs different properties. Evenflow supports a custom Blossom host or an S3-compatible bucket in your organization's storage settings, which puts the access rules under your control instead of ours. Note that inline image previews require the object to be readable without auth, so a fully locked-down bucket trades previews for privacy.
- **Assume permanence.** Deleting an attachment in Evenflow removes it from the issue. It does not guarantee the bytes are gone from a host that may have served or cached them.

## What might change later

We've written down four ways to close this gap — encrypting blobs to the board's audience key, deriving addresses from content plus a board secret, putting a signed-URL layer in front of storage, or allowing attachments only on public boards. Each trades away something structural: bring-your-own-host, content-addressing's benefits, or the feature itself.

None is committed. The reasoning is recorded in `docs/decisions/2026-07-attachment-privacy.md` so the next pass at it starts from the trade-offs rather than re-deriving them.

Until one ships, the guidance above is the whole of the protection: **know what the storage does, and choose what you upload accordingly.**
