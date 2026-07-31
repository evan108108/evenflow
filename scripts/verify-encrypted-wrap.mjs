#!/usr/bin/env node
// EFB-55 — decrypt-with-key verifier for encrypted-substrate observability.
//
// WHY THIS EXISTS
//
// A private board's substrate publishes go out as NIP-59 gift-wraps, one per
// audience member. A public relay query for the audience returns zero events —
// correct for encrypted fan-out, and indistinguishable from "the publish never
// happened". EFB-32's verification could only prove delivery by tailing worker
// logs, which needs operator access and treats silence as evidence. This tool
// lets anyone holding the right key prove it from outside: hand it a candidate
// 1059 and see the real inner event, or a clean non-zero exit.
//
// WHICH KEY — READ THIS BEFORE YOU PASTE ANYTHING
//
// The `--recipient-secret` is the private key of the MEMBER (or ephemeral
// session) the wrap was addressed to. It is NOT the board's audience key.
//
// That is not a naming preference, it is the crypto. audiences.ts builds each
// wrap as `wrap(rumor, audIdPriv, recipientPub)`: the audience key is the
// SENDER, and the outer gift-wrap layer is an ECDH between a fresh ephemeral
// key and the RECIPIENT. The ephemeral private key is discarded at wrap time,
// so nothing but the recipient's own key can open the outer layer — the
// audience key does not enter until the seal inside, which you cannot reach
// without opening the wrap first.
//
// Paste the audience key here and you get "MAC verification failed", which
// reads exactly like a broken publish. It isn't. Use `--expect-publisher` with
// the audience PUBLIC key if what you want to check is "who published this".
//
// WHY IT IMPORTS FROM src/ RATHER THAN VENDORING A COPY
//
// `src/lib/audience/nip17.ts` is the same module that WRITES these wraps. A
// verifier holding its own copy of the protocol can pass while the writer is
// broken, or fail while the writer is fine — either way its verdict says
// nothing about the path it is supposed to be verifying. Importing the writer's
// own module makes divergence impossible by construction, and means any future
// change to unwrap semantics is picked up here automatically.
//
// The module is TypeScript with extensionless relative imports, which Node's
// ESM resolver rejects even though it strips the types happily. The resolve
// hook below bridges exactly that gap and nothing else. Adding `.ts` to the
// import in src/ was the alternative and was rejected: it requires
// `allowImportingTsExtensions` project-wide to serve one script.
//
// Requires Node >= 22.15 (module.registerHooks) with type stripping
// (>= 22.6, on by default from 23). Checked explicitly below.

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const EXIT_OK = 0;
const EXIT_VERIFY_FAILED = 1;
const EXIT_USAGE = 2;

const HEX64 = /^[0-9a-f]{64}$/i;

const USAGE = `
verify-encrypted-wrap — unwrap a NIP-59 gift-wrap from an evenflow private board

USAGE
  node scripts/verify-encrypted-wrap.mjs --wrap <file|-> [key source] [options]

KEY SOURCE (exactly one; in order of preference)
  EVENFLOW_RECIPIENT_SECRET=<hex|nsec>   environment variable
  --recipient-secret-file <path>         file containing the key, trimmed
  --recipient-secret <hex|nsec>          inline (VISIBLE in shell history and ps)

  This is the key of the MEMBER the wrap was addressed to — NOT the board's
  audience key. The audience key cannot open a wrap; see docs.

OPTIONS
  --wrap <file|->        the candidate kind:1059 event as JSON; - reads stdin
  --expect-publisher <hex>  assert the inner event's pubkey equals this
                            (the board's audience PUBLIC key). Non-zero on
                            mismatch.
  --json                 emit a single machine-readable JSON object
  -h, --help             this text

EXIT CODES
  0  unwrapped, and publisher matched when --expect-publisher was given
  1  decrypt, signature, structure, or publisher-match failure
  2  usage error / unreadable input
`.trimStart();

/** Print to stderr. Never used for anything derived from the secret. */
const warn = (msg) => process.stderr.write(`${msg}\n`);

const die = (code, msg) => {
  warn(msg);
  process.exit(code);
};

// ── Node capability gate ────────────────────────────────────────────────────
// A missing registerHooks otherwise surfaces as an import-time TypeError with
// a stack trace, which tells an operator nothing actionable.
if (typeof registerHooks !== "function") {
  die(
    EXIT_USAGE,
    `[verify-wrap] this tool needs Node >= 22.15 for module.registerHooks; running ${process.version}.`,
  );
}

// ── resolve hook: let Node load the writer's own TypeScript module ──────────
// Scoped as tightly as possible: only extensionless RELATIVE specifiers, and
// only by trying the `.ts` sibling first. Anything else falls through to the
// default resolver untouched.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("./") && !/\.[a-z0-9]+$/i.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // fall through to the default resolution below
      }
    }
    return nextResolve(specifier, context);
  },
});

// ── argument parsing ────────────────────────────────────────────────────────
const parseArgs = (argv) => {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[++i];
      if (v === undefined) die(EXIT_USAGE, `[verify-wrap] ${name} needs a value`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(EXIT_OK);
        break;
      case "--wrap":
        out.wrap = need("--wrap");
        break;
      case "--recipient-secret":
        out.secretInline = need("--recipient-secret");
        break;
      case "--recipient-secret-file":
        out.secretFile = need("--recipient-secret-file");
        break;
      case "--expect-publisher":
        out.expectPublisher = need("--expect-publisher");
        break;
      case "--json":
        out.json = true;
        break;
      case "--secret":
        die(
          EXIT_USAGE,
          "[verify-wrap] --secret is not a flag here. Use --recipient-secret, and note it is the\n" +
            "              MEMBER's key the wrap was addressed to, not the board's audience key.",
        );
        break;
      default:
        die(EXIT_USAGE, `[verify-wrap] unknown argument: ${a}\n\n${USAGE}`);
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));

// ── secret resolution ───────────────────────────────────────────────────────
// Deliberately ordered so the least-leaky source wins, and deliberately never
// echoed: not in errors, not in --json output, not on success.
const readSecret = () => {
  const sources = [
    ["EVENFLOW_RECIPIENT_SECRET", process.env["EVENFLOW_RECIPIENT_SECRET"]],
    [
      "--recipient-secret-file",
      args.secretFile === undefined ? undefined : readFileOrDie(args.secretFile, "secret file"),
    ],
    ["--recipient-secret", args.secretInline],
  ].filter(([, v]) => v !== undefined && v !== "");

  if (sources.length === 0) {
    die(EXIT_USAGE, `[verify-wrap] no recipient secret supplied.\n\n${USAGE}`);
  }
  if (sources.length > 1) {
    die(
      EXIT_USAGE,
      `[verify-wrap] more than one secret source given (${sources.map(([n]) => n).join(", ")}). Pick one.`,
    );
  }
  if (sources[0][0] === "--recipient-secret") {
    warn(
      "[verify-wrap] note: --recipient-secret is visible in shell history and `ps`.\n" +
        "              EVENFLOW_RECIPIENT_SECRET or --recipient-secret-file avoid that.",
    );
  }
  return sources[0][1].trim();
};

function readFileOrDie(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    die(EXIT_USAGE, `[verify-wrap] could not read ${what} at ${path}: ${err.code ?? err.message}`);
  }
}

/**
 * Accept 64-char hex or a bech32 `nsec1…`. Returns raw bytes.
 *
 * Errors here never quote the input — a malformed secret is still a secret.
 */
const decodeSecret = async (raw) => {
  if (HEX64.test(raw)) {
    const { hexToBytes } = await import("@noble/hashes/utils.js");
    return hexToBytes(raw.toLowerCase());
  }
  if (/^nsec1[02-9ac-hj-np-z]+$/i.test(raw)) {
    try {
      const { nip19 } = await import("nostr-tools");
      const decoded = nip19.decode(raw.toLowerCase());
      if (decoded.type !== "nsec") throw new Error(`decoded as ${decoded.type}`);
      return decoded.data;
    } catch (err) {
      die(EXIT_USAGE, `[verify-wrap] nsec did not decode: ${err.message}`);
    }
  }
  die(
    EXIT_USAGE,
    "[verify-wrap] recipient secret must be 64-char hex or an nsec1… key. (Value not echoed.)",
  );
};

// ── wrap input ──────────────────────────────────────────────────────────────
const readWrap = () => {
  if (args.wrap === undefined) die(EXIT_USAGE, `[verify-wrap] --wrap is required.\n\n${USAGE}`);
  const text =
    args.wrap === "-" ? readFileOrDie(0, "wrap on stdin") : readFileOrDie(args.wrap, "wrap file");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    die(EXIT_USAGE, `[verify-wrap] --wrap is not valid JSON: ${err.message}`);
  }
  // Relay queries hand back `["EVENT", <subid>, {…}]` frames and arrays of
  // events as often as they hand back a bare event; accept all three rather
  // than making the operator reshape JSON by hand at 2am.
  if (Array.isArray(parsed)) {
    const candidate = parsed.find((x) => x !== null && typeof x === "object" && "kind" in x);
    if (candidate === undefined) {
      die(EXIT_USAGE, "[verify-wrap] --wrap was an array with no event object in it.");
    }
    parsed = candidate;
  }
  if (parsed === null || typeof parsed !== "object") {
    die(EXIT_USAGE, "[verify-wrap] --wrap did not contain an event object.");
  }
  return parsed;
};

// ── main ────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const NIP17 = resolvePath(here, "../src/lib/audience/nip17.ts");

const secretBytes = await decodeSecret(readSecret());
const giftWrap = readWrap();

if (args.expectPublisher !== undefined && !HEX64.test(args.expectPublisher)) {
  die(EXIT_USAGE, `[verify-wrap] --expect-publisher must be 64-char hex, got ${args.expectPublisher}`);
}

let unwrap;
try {
  ({ unwrap } = await import(NIP17));
} catch (err) {
  die(
    EXIT_USAGE,
    `[verify-wrap] could not load the audience crypto from ${NIP17}.\n` +
      `              Node >= 22.6 type stripping is required (running ${process.version}).\n` +
      `              ${err.message}`,
  );
}

let result;
try {
  result = unwrap(giftWrap, secretBytes);
} catch (err) {
  // The common case by far is a wrap addressed to somebody else — those land
  // in the same relay query and are SUPPOSED to fail here.
  const hint =
    /MAC|decrypt/i.test(err.message ?? "")
      ? "\n              This wrap is not addressed to that key. If you used the board's audience\n" +
        "              key, that is expected — see docs/verify-encrypted-wrap.md."
      : "";
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
  } else {
    warn(`[verify-wrap] FAILED: ${err.message}${hint}`);
  }
  process.exit(EXIT_VERIFY_FAILED);
}

const { rumor, publisherPub } = result;
const publisherMatched =
  args.expectPublisher === undefined
    ? null
    : publisherPub.toLowerCase() === args.expectPublisher.toLowerCase();

if (args.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: publisherMatched !== false,
        publisher_pubkey: publisherPub,
        publisher_expected: args.expectPublisher ?? null,
        publisher_matched: publisherMatched,
        outer_wrap_pubkey: giftWrap.pubkey,
        rumor,
      },
      null,
      2,
    )}\n`,
  );
} else {
  // The publisher line is printed FIRST and always — including when it matched
  // — so a log reviewer sees the identity itself rather than inferring it from
  // an exit code.
  process.stdout.write(`publisher (inner seal signer): ${publisherPub}\n`);
  if (args.expectPublisher !== undefined) {
    process.stdout.write(
      `expected publisher:            ${args.expectPublisher.toLowerCase()}\n` +
        `publisher match:               ${publisherMatched ? "YES" : "NO"}\n`,
    );
  }
  // Named as ephemeral so nobody tries to check it against a known key: NIP-59
  // generates a fresh signing key per wrap, so this value is meaningless as an
  // identity and only useful for correlating with the relay row you fetched.
  process.stdout.write(`outer wrap pubkey (ephemeral): ${giftWrap.pubkey}\n\n`);
  process.stdout.write(`${JSON.stringify(rumor, null, 2)}\n`);
}

if (publisherMatched === false) {
  warn(
    `[verify-wrap] FAILED: unwrapped fine, but the publisher is not the expected key.\n` +
      `              The wrap is genuine; it was published by somebody else.`,
  );
  process.exit(EXIT_VERIFY_FAILED);
}

process.exit(EXIT_OK);
