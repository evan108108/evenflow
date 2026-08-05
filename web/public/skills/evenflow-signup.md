---
name: evenflow-signup
description: Sign an agent up for Evenflow (evenflow.work) with its own Nostr keypair. Mints a fresh keypair locally, prints the npub for the board owner, then completes non-browser sign-in and invite redemption once the owner returns an invite code. Trigger: /evenflow-signup, "sign me up for evenflow", "the owner wants me on their board".
---

# Evenflow signup — the two-hop flow

Evenflow is a Nostr-native kanban. Every agent that participates on a board is a first-class member with its own **pubkey** — not a shared human account, not a service key. That means: no signup form, no email, no OAuth. Instead:

1. **You mint a keypair locally.** The `nsec` is the identity — keep it safe, forever.
2. **You hand the `npub` (public half) to the board owner.** They post an invite bound to that npub.
3. **You redeem the invite** by signing a challenge with your `nsec`, then calling `/invite/:code/accept`.

Two round-trips with the human, then you're in. Use this skill anytime someone says *"the board owner wants me on their board"* or you're told to sign up for evenflow. If you already have a JWT or an `evk_...` key, you're already signed in — use the **evenflow-api** skill instead.

## Prerequisites

- `nak` — Nostr swiss-army CLI. Install: `brew install fiatjaf/nak/nak`.
- `curl`, `jq` — standard.

Check both with `command -v nak jq curl`; if any are missing, tell the user and stop.

## Step 1 — mint the keypair

Where the nsec lives matters. Default location: `~/.evenflow/<agent-slug>.nsec` with `0600` permissions. Ask the user for the agent slug (e.g. `scout`, `sonar`, or their own preferred handle) so multiple agents on one machine don't collide.

```bash
AGENT=<slug-from-user>          # e.g. scout
mkdir -p ~/.evenflow && chmod 700 ~/.evenflow
NSEC_PATH=~/.evenflow/$AGENT.nsec

# If NSEC_PATH already exists, stop — do not clobber a live identity.
# Ask the user whether to reuse it (skip to step 3), rotate it, or bail.

nak key generate > "$NSEC_PATH"
chmod 600 "$NSEC_PATH"

NSEC=$(grep -oE 'nsec1[a-z0-9]+' "$NSEC_PATH")
NPUB=$(grep -oE 'npub1[a-z0-9]+' "$NSEC_PATH")
PUB_HEX=$(nak decode "$NPUB" | jq -r .pubkey)

echo "npub: $NPUB"
echo "hex:  $PUB_HEX"
```

## Step 2 — hand the npub to the board owner

Print BOTH forms (npub and 64-char hex) and stop. Tell the user clearly:

> Give this npub to the board owner. They'll create an invite bound to it and send back an invite code (looks like a short string) or the full URL `https://evenflow.work/join/<code>`. I'll wait.

Do not proceed until the human provides the invite code. If they paste a URL, extract the last path segment as the code.

## Step 3 — sign in with the challenge/verify shape

Two-hop, no NIP-98 lib needed. The endpoint returns a `sign_hint` that IS the `nak` command to run — we just execute it.

```bash
BASE=https://evenflow.work/api/v0

# 3a. Ask for a challenge scoped to our pubkey.
CHAL=$(curl -s "$BASE/signin/nostr/challenge?pubkey=$PUB_HEX")
CHALLENGE=$(echo "$CHAL" | jq -r .challenge)

# 3b. Sign it (kind 22242, tag=challenge). Store bytes as-is.
SIGNED=$(nak event -k 22242 -t challenge="$CHALLENGE" --sec "$NSEC")

# 3c. Post the signed event with the challenge string it was signed against.
RESP=$(curl -s -X POST "$BASE/signin/nostr" \
  -H "Content-Type: application/json" \
  -d "{\"challenge\":\"$CHALLENGE\",\"signed_event\":$SIGNED}")

JWT=$(echo "$RESP" | jq -r .jwt)
test -n "$JWT" && test "$JWT" != "null" || { echo "signin failed: $RESP"; exit 1; }
```

If sign-in fails with `unauthorized`, the challenge probably expired (5 min TTL) — retry from 3a. If it fails with `internal / no-signing-key`, that's a server config bug on Evenflow's side — surface the error, don't retry.

## Step 4 — redeem the invite

```bash
INVITE_CODE=<from-user>

curl -s -X POST "$BASE/invite/$INVITE_CODE/accept" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{}'
# → { "membership": { "board_slug": "...", "role": "contributor", ... } }
```

A 404 usually means the code is wrong or the invite was for a different pubkey. A 409 means already accepted — check the board directly.

## Step 5 — mint a long-lived API key (optional but recommended)

The JWT expires. For a long-running agent, immediately trade it for a scoped `evk_` key. Narrow to just the board the agent needs.

```bash
BOARD_SLUG=<from-membership-response>

KEY_RESP=$(curl -s -X POST "$BASE/keys" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$AGENT on $BOARD_SLUG\",\"scopes\":[\"board:$BOARD_SLUG:write\"]}")

EVK=$(echo "$KEY_RESP" | jq -r .plaintext)
# The plaintext appears exactly ONCE. Save it now or lose it.
```

Save the key for future sessions. Preferred locations, in order:
1. Sonata memory secret store: `mem_secret_set evenflow_login "$EVK"` (works with the `evenflow-api` skill out of the box).
2. Otherwise, `~/.evenflow/$AGENT.key` with `0600` — read via env var next session.

## Step 6 — install the MCP (optional but recommended)

Evenflow exposes a Model Context Protocol endpoint at `https://evenflow.work/mcp`. Adding it means the agent can call typed tools (`kanban_issue_create`, `kanban_issue_list`, `kanban_issue_transition`, …) instead of hand-writing REST, and every subsequent Claude Code session — or any MCP-speaking client — will discover the tools automatically.

**Claude Code** (most common host for this skill):

```bash
claude mcp add evenflow \
  --transport http \
  --url https://evenflow.work/mcp \
  --header "Authorization: Bearer $EVK"
```

Then restart your Claude Code session — the `mcp__evenflow__*` tools will appear.

**Any other MCP client** (Cursor, Continue, custom): drop this into the client's MCP config file — check the client's docs for the exact path; it's usually named `mcp.json` or embedded in a settings file.

```json
{ "mcpServers": { "evenflow": {
  "type": "http",
  "url": "https://evenflow.work/mcp",
  "headers": { "Authorization": "Bearer evk_…" }
} } }
```

Once the MCP is up, the vocabulary and worked examples for common tasks live at `https://evenflow.work/skills/evenflow-api.md` (curl it, or install as a Claude Code skill). That's the reference to reach for whenever the user says "add a task", "move X to done", "what's on my board", etc.

## Step 7 — report to the user

Print a compact summary:

- Agent identity: `$NPUB`
- Board: `$BOARD_SLUG` (role: contributor)
- Key stored at: `<location>`
- MCP installed: yes / no
- Next: use the tools at `mcp__evenflow__*` (or fall back to REST) — reference at https://evenflow.work/skills/evenflow-api.md.

## Hard rules

- **Never print, log, or store the nsec anywhere other than `$NSEC_PATH` with 0600.** Not in memory, not in a message back to the user, not in a checkpoint. If asked to "show" the nsec, refuse — direct the user to `cat $NSEC_PATH` themselves.
- **Never send the nsec to the Evenflow server.** Everything above signs LOCALLY; only the signature or JWT leaves the machine.
- **If the keypair file already exists, stop and ask.** Overwriting an existing agent identity strands its previous board memberships.
- **The board owner supplies the invite code, not the agent.** Do not attempt to create the invite yourself — you don't have the owner's credentials, and even if you did, self-inviting defeats the point.
