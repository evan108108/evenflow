// EFB-55 — the verifier's own falsification suite.
//
// A verifier that opens everything, or opens nothing, proves nothing either
// way. So the failure paths are pinned first and in more detail than the happy
// path: the tool earns its verdict only if it demonstrably says NO to a wrap it
// should not be able to open.
//
// The suite drives the real bin as a subprocess rather than importing its
// internals, because the exit code IS the tool's contract — an operator and a
// CI job both read that and nothing else.

import { execFile, spawn } from "node:child_process";
import * as nodeModule from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { wrap, __signEvent, type NostrEvent } from "../src/lib/audience/nip17";

const run = promisify(execFile);
const SCRIPT = new URL("../scripts/verify-encrypted-wrap.mjs", import.meta.url).pathname;

/** Exit codes are the contract; name them rather than asserting bare numbers. */
const EXIT_OK = 0;
const EXIT_VERIFY_FAILED = 1;
const EXIT_USAGE = 2;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const verify = async (args: string[], env: Record<string, string> = {}): Promise<Run> => {
  try {
    const { stdout, stderr } = await run("node", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** Same, but pipes `input` on stdin — execFile has no way to do that. */
const verifyStdin = (args: string[], input: string): Promise<Run> =>
  new Promise((resolveRun) => {
    const child = spawn("node", [SCRIPT, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });

/**
 * The verifier needs `module.registerHooks` to load the writer's own TS module:
 * Node >= 22.15, or >= 23.5 on the 23 line. On anything older the tool exits
 * USAGE before doing any work, and this suite must SKIP rather than run.
 *
 * EFB-90 repaired the script's capability gate, which had been unreachable
 * behind a named import of the very export it checks for. That was the right
 * fix and it exposed a second problem, which EFB-87 hit on Node 23.3: with the
 * gate reporting USAGE cleanly instead of dying on an import, the usage-path
 * tests started PASSING. `exits USAGE on malformed JSON` went green on a run
 * where the JSON was never parsed at all.
 *
 * A test that passes because the tool refused to start is the exact thing this
 * suite's own header warns about — a verifier that proves nothing while looking
 * like it proved something. Red was noisy; falsely green is worse.
 *
 * So: skipped, visibly, rather than either.
 */
const HAS_REGISTER_HOOKS = "registerHooks" in nodeModule;

let dir: string;

// The board's audience identity — the SENDER of every wrap.
const audPriv = randomBytes(32);
const audPub = bytesToHex(schnorr.getPublicKey(audPriv));
// A member the wrap is addressed to — the only key that can open it.
const memberPriv = randomBytes(32);
const memberPub = bytesToHex(schnorr.getPublicKey(memberPriv));
// Somebody else entirely.
const strangerPriv = randomBytes(32);

let rumor: NostrEvent;
let giftWrap: NostrEvent;
let wrapPath: string;
let memberSecretPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "efb55-"));
  rumor = __signEvent(
    {
      pubkey: audPub,
      kind: 30555,
      created_at: 1_700_000_000,
      tags: [["d", "board-1:issue-1"], ["fa:epoch", "1"]],
      content: "opaque-ciphertext",
    },
    audPriv,
  );
  giftWrap = wrap(rumor, audPriv, memberPub);
  wrapPath = join(dir, "wrap.json");
  writeFileSync(wrapPath, JSON.stringify(giftWrap));
  memberSecretPath = join(dir, "member.key");
  writeFileSync(memberSecretPath, `${bytesToHex(memberPriv)}\n`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_REGISTER_HOOKS)("the instrument can fail (falsification first)", () => {
  it("REJECTS the board's audience key — the exact confusion the flag name guards", async () => {
    // This is the regression guard for EFB-55's central finding: the audience
    // key is the SENDER, and the outer layer is ECDH between a discarded
    // ephemeral key and the RECIPIENT. If this test ever goes green, either the
    // wrap model changed or the tool started accepting something it shouldn't.
    const r = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(audPriv),
    });
    expect(r.code).toBe(EXIT_VERIFY_FAILED);
    expect(r.stderr).toMatch(/FAILED/);
    expect(r.stdout).not.toContain("30555");
  });

  it("REJECTS an unrelated key", async () => {
    const r = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(strangerPriv),
    });
    expect(r.code).toBe(EXIT_VERIFY_FAILED);
    expect(r.stdout).not.toContain("opaque-ciphertext");
  });

  it("REJECTS a wrap of the wrong kind", async () => {
    const notAWrap = join(dir, "kind1.json");
    writeFileSync(notAWrap, JSON.stringify({ ...giftWrap, kind: 1 }));
    const r = await verify(["--wrap", notAWrap], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_VERIFY_FAILED);
    expect(r.stderr).toMatch(/expected kind:1059/);
  });

  it("REJECTS a wrap whose ciphertext has been tampered with", async () => {
    const tampered = join(dir, "tampered.json");
    const flipped = giftWrap.content.slice(0, -4) + (giftWrap.content.endsWith("A") ? "BBBB" : "AAAA");
    writeFileSync(tampered, JSON.stringify({ ...giftWrap, content: flipped }));
    const r = await verify(["--wrap", tampered], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_VERIFY_FAILED);
  });

  it("exits USAGE (not VERIFY_FAILED) on malformed JSON — a broken input is not a failed proof", async () => {
    const junk = join(dir, "junk.json");
    writeFileSync(junk, "{not json");
    const r = await verify(["--wrap", junk], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_USAGE);
  });

  it("exits USAGE when no secret is supplied, and when two are", async () => {
    const none = await verify(["--wrap", wrapPath]);
    expect(none.code).toBe(EXIT_USAGE);

    const both = await verify(
      ["--wrap", wrapPath, "--recipient-secret", bytesToHex(memberPriv)],
      { EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv) },
    );
    expect(both.code).toBe(EXIT_USAGE);
    expect(both.stderr).toMatch(/more than one secret source/);
  });

  it("rejects --secret with a pointer at the real flag", async () => {
    // `--secret` is what the ticket originally specified and what a user is
    // most likely to reach for. Failing with a bare "unknown argument" would
    // leave them guessing; this names the distinction that matters.
    const r = await verify(["--wrap", wrapPath, "--secret", bytesToHex(memberPriv)]);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stderr).toMatch(/--recipient-secret/);
    expect(r.stderr).toMatch(/audience key/);
  });
});

describe.skipIf(!HAS_REGISTER_HOOKS)("the instrument succeeds when it should", () => {
  it("unwraps with the recipient's key and prints the inner event", async () => {
    const r = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(`publisher (inner seal signer): ${audPub}`);
    expect(r.stdout).toContain("opaque-ciphertext");
    expect(r.stdout).toContain('"kind": 30555');
  });

  it("round-trips the inner event byte-for-byte under --json", async () => {
    const r = await verify(["--wrap", wrapPath, "--json"], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_OK);
    const out = JSON.parse(r.stdout) as { ok: boolean; rumor: NostrEvent; publisher_pubkey: string };
    expect(out.ok).toBe(true);
    expect(out.publisher_pubkey).toBe(audPub);
    expect(out.rumor).toEqual(rumor);
  });

  it("reads the secret from a file", async () => {
    const r = await verify(["--wrap", wrapPath, "--recipient-secret-file", memberSecretPath]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(`publisher (inner seal signer): ${audPub}`);
  });

  it("reads the wrap from stdin", async () => {
    // The shape an operator actually uses: pipe a relay query straight in.
    const r = await verifyStdin(
      ["--wrap", "-", "--recipient-secret-file", memberSecretPath],
      JSON.stringify(giftWrap),
    );
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('"kind": 30555');
  });

  it("accepts a relay EVENT frame, not just a bare event", async () => {
    // Relays hand back `["EVENT", <subid>, {…}]`. Making the operator reshape
    // that by hand is where a 2am transcription error comes from.
    const r = await verifyStdin(
      ["--wrap", "-", "--recipient-secret-file", memberSecretPath],
      JSON.stringify(["EVENT", "sub0", giftWrap]),
    );
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('"kind": 30555');
  });

  it("accepts an nsec-encoded secret", async () => {
    const { nip19 } = await import("nostr-tools");
    const r = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: nip19.nsecEncode(memberPriv),
    });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(`publisher (inner seal signer): ${audPub}`);
  });
});

describe.skipIf(!HAS_REGISTER_HOOKS)("--expect-publisher turns 'I decrypted something' into 'my board published this'", () => {
  it("passes when the publisher matches, and SHOWS the identity either way", async () => {
    const r = await verify(["--wrap", wrapPath, "--expect-publisher", audPub], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toMatch(/publisher match:\s+YES/);
    expect(r.stdout).toContain(audPub);
  });

  it("fails when the publisher is somebody else — the wrap is genuine but not ours", async () => {
    const otherPub = bytesToHex(schnorr.getPublicKey(strangerPriv));
    const r = await verify(["--wrap", wrapPath, "--expect-publisher", otherPub], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_VERIFY_FAILED);
    expect(r.stdout).toMatch(/publisher match:\s+NO/);
    // The decrypt DID succeed, so the inner event is still shown — the failure
    // is about identity, and hiding the payload would obscure that distinction.
    expect(r.stdout).toContain('"kind": 30555');
  });

  it("exits USAGE on a malformed --expect-publisher", async () => {
    const r = await verify(["--wrap", wrapPath, "--expect-publisher", "nope"], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(memberPriv),
    });
    expect(r.code).toBe(EXIT_USAGE);
  });
});

describe.skipIf(!HAS_REGISTER_HOOKS)("no secrets in output", () => {
  it("never echoes the key, on success or on failure", async () => {
    const hex = bytesToHex(memberPriv);
    const ok = await verify(["--wrap", wrapPath, "--json"], { EVENFLOW_RECIPIENT_SECRET: hex });
    expect(ok.stdout + ok.stderr).not.toContain(hex);

    const bad = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: bytesToHex(strangerPriv),
    });
    expect(bad.stdout + bad.stderr).not.toContain(bytesToHex(strangerPriv));

    const malformed = await verify(["--wrap", wrapPath], {
      EVENFLOW_RECIPIENT_SECRET: "not-a-key-but-still-sensitive",
    });
    expect(malformed.code).toBe(EXIT_USAGE);
    expect(malformed.stdout + malformed.stderr).not.toContain("not-a-key-but-still-sensitive");
  });
});
