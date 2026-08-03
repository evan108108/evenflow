// Phase 18b: BYOB storage — the server-pubkey endpoint, the org storage
// config CRUD (owner-only, secrets never echoed), the connection test, and
// upload routing to default Blossom / BYO Blossom / BYO S3. The S3 config
// round-trips REAL NIP-44: tests encrypt creds to the server pubkey with an
// ephemeral sender key exactly like the web client does, and the upload
// path unwraps them with the server secret.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import type { AttachmentShape, IssueShape } from "../src/shapes";
import {
  CALLER,
  callerOrg,
  createIssue,
  jsonReq,
  makeHarness,
  pubkeyFor,
  seedOrgMember,
  tokenFor,
  type Harness,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A fixed, valid secp256k1 scalar standing in for the Worker secret. */
const SERVER_SECRET = "11".repeat(32);
const ENV = { EVENFLOW_STORAGE_SECRET: SERVER_SECRET };

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Board + issue under the caller's personal org; returns issue + org row. */
const setup = async (h: Harness) => {
  const res = await h.app.request(url("board.create"), jsonReq("POST", { slug: "kb", title: "Board" }), {});
  expect(res.status).toBe(201);
  const issue = await createIssue(h);
  return { issue, org: callerOrg(h) };
};

const storagePath = (slug: unknown) => url("storage.get", { org_slug: String(slug) });

const upload = (h: Harness, issue: IssueShape, env: Record<string, unknown> = {}) =>
  h.app.request(
    url("attachment.create", { slug: "kb", issue_ref: issue.id }),
    jsonReq("POST", { file_b64: b64(PNG_BYTES), filename: "shot.png", content_type: "image/png" }),
    env,
  );

/** Encrypt creds to `serverPubkey` with a fresh ephemeral sender — the client flow. */
const encryptCreds = (serverPubkey: string, creds: Record<string, string>) => {
  const eph = generateSecretKey();
  const conversationKey = getConversationKey(eph, serverPubkey);
  const ciphertext = encrypt(JSON.stringify(creds), conversationKey);
  return { ciphertext, senderPubkey: getPublicKey(eph) };
};

const serverPubkey = async (h: Harness) => {
  const res = await h.app.request(url("storage.serverPubkey"), {}, ENV);
  expect(res.status).toBe(200);
  return ((await res.json()) as { pubkey: string }).pubkey;
};

const putS3Config = async (h: Harness, orgSlug: unknown, over: Record<string, unknown> = {}) => {
  const { ciphertext, senderPubkey } = encryptCreds(await serverPubkey(h), {
    access_key_id: "AKIATEST",
    secret_access_key: "swordfish",
  });
  return h.app.request(
    storagePath(orgSlug),
    jsonReq("PUT", {
      kind: "s3",
      s3_endpoint: "acct.r2.cloudflarestorage.com",
      s3_region: "auto",
      s3_bucket: "blobs",
      s3_creds_ciphertext: ciphertext,
      s3_creds_sender_pubkey: senderPubkey,
      ...over,
    }),
    ENV,
  );
};

describe("server-pubkey", () => {
  it("serves the derived static pubkey with a day of cache", async () => {
    const h = makeHarness();
    const res = await h.app.request(url("storage.serverPubkey"), {}, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const { pubkey } = (await res.json()) as { pubkey: string };
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers 503 when the storage secret is not configured", async () => {
    const h = makeHarness();
    const res = await h.app.request(url("storage.serverPubkey"), {}, {});
    expect(res.status).toBe(503);
  });
});

describe("storage config CRUD", () => {
  it("defaults to kind 'default' when no row exists", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    const res = await h.app.request(storagePath(org["slug"]), jsonReq("GET"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: { kind: "default" } });
  });

  it("is owner-only: admins 403, anonymous 401", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    seedOrgMember(h, String(org["id"]), pubkeyFor("bob"), "admin");
    const admin = await h.app.request(
      storagePath(org["slug"]),
      jsonReq("PUT", { kind: "default" }, tokenFor("bob")),
      {},
    );
    expect(admin.status).toBe(403);
    const anon = await h.app.request(storagePath(org["slug"]), { method: "GET" }, {});
    expect(anon.status).toBe(401);
  });

  it("upserts a BYO Blossom URL and reads it back", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    const put = await h.app.request(
      storagePath(org["slug"]),
      jsonReq("PUT", { kind: "blossom", blossom_url: "https://blossom.example.org/" }),
      {},
    );
    expect(put.status).toBe(200);
    const { config } = (await put.json()) as { config: Record<string, unknown> };
    // Trailing slash trimmed; no secret-bearing fields for blossom.
    expect(config).toMatchObject({ kind: "blossom", blossom_url: "https://blossom.example.org", has_credentials: false });
  });

  it("rejects malformed bodies field-first", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    for (const [body, reason] of [
      [{ kind: "ftp" }, "kind"],
      [{ kind: "blossom", blossom_url: "not a url" }, "blossom_url"],
      [{ kind: "s3", s3_region: "auto", s3_bucket: "b" }, "s3_endpoint"],
      [{ kind: "s3", s3_endpoint: "e", s3_region: "auto", s3_bucket: "b" }, "s3_creds_ciphertext"],
    ] as const) {
      const res = await h.app.request(storagePath(org["slug"]), jsonReq("PUT", body), ENV);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe(reason);
    }
  });

  it("stores NIP-44 creds it can decrypt, never echoes them, and keeps them on cred-less re-PUT", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    const put = await putS3Config(h, org["slug"]);
    expect(put.status).toBe(200);
    const { config } = (await put.json()) as { config: Record<string, unknown> };
    expect(config).toMatchObject({ kind: "s3", s3_bucket: "blobs", has_credentials: true });
    expect(JSON.stringify(config)).not.toContain("swordfish");

    // Re-PUT without creds: config fields update, saved ciphertext survives.
    const before = h.db.storageConfigs[0]!["s3_creds_ciphertext"];
    const rePut = await h.app.request(
      storagePath(org["slug"]),
      jsonReq("PUT", { kind: "s3", s3_endpoint: "acct.r2.cloudflarestorage.com", s3_region: "auto", s3_bucket: "blobs2" }),
      ENV,
    );
    expect(rePut.status).toBe(200);
    expect(h.db.storageConfigs[0]!["s3_bucket"]).toBe("blobs2");
    expect(h.db.storageConfigs[0]!["s3_creds_ciphertext"]).toBe(before);
  });

  it("rejects ciphertext the server cannot unwrap", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    // Encrypted to the WRONG pubkey (a random one, not the server's).
    const { ciphertext, senderPubkey } = encryptCreds(getPublicKey(generateSecretKey()), {
      access_key_id: "AKIATEST",
      secret_access_key: "swordfish",
    });
    const res = await h.app.request(
      storagePath(org["slug"]),
      jsonReq("PUT", {
        kind: "s3",
        s3_endpoint: "e",
        s3_region: "auto",
        s3_bucket: "b",
        s3_creds_ciphertext: ciphertext,
        s3_creds_sender_pubkey: senderPubkey,
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("s3_creds_undecryptable");
  });

  it("DELETE resets to default", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    const del = await h.app.request(storagePath(org["slug"]), jsonReq("DELETE"), {});
    expect(del.status).toBe(200);
    expect(h.db.storageConfigs).toHaveLength(0);
  });
});

describe("connection test", () => {
  it("probes put/head/delete against the saved S3 config", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    const res = await h.app.request(`${storagePath(org["slug"])}/test`, jsonReq("POST"), ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.s3.calls).toHaveLength(3);
    expect(h.s3.calls[0]).toMatch(/^put\(application\/octet-stream:16\):blobs\/evenflow\//);
    expect(h.s3.calls[1]).toMatch(/^head:blobs\//);
    expect(h.s3.calls[2]).toMatch(/^delete:blobs\//);
  });

  it("surfaces the specific S3 error on bad credentials", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    h.s3.failOps = true;
    const res = await h.app.request(`${storagePath(org["slug"])}/test`, jsonReq("POST"), ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: "SignatureDoesNotMatch" });
  });

  it("reports ok for default storage without probing anything", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    const res = await h.app.request(`${storagePath(org["slug"])}/test`, jsonReq("POST"), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.s3.calls).toHaveLength(0);
    expect(h.blossom.calls).toHaveLength(0);
  });
});

describe("upload routing", () => {
  it("defaults to the managed Blossom host (no config row)", async () => {
    const h = makeHarness();
    const { issue } = await setup(h);
    const res = await upload(h, issue);
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentShape };
    expect(attachment.storage_kind).toBe("blossom_default");
    expect(attachment.blob_url).toContain("blossom.test");
  });

  it("routes to the org's own Blossom when configured", async () => {
    const h = makeHarness();
    const { issue, org } = await setup(h);
    const put = await h.app.request(
      storagePath(org["slug"]),
      jsonReq("PUT", { kind: "blossom", blossom_url: "https://blobs.acme.dev" }),
      {},
    );
    expect(put.status).toBe(200);
    const res = await upload(h, issue);
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentShape };
    expect(attachment.storage_kind).toBe("blossom_byo");
    expect(attachment.blob_url).toContain("blobs.acme.dev");
    expect(h.blossom.calls.at(-1)).toContain("https://blobs.acme.dev|");
  });

  it("routes to the org's S3 bucket, unwrapping real NIP-44 creds", async () => {
    const h = makeHarness();
    const { issue, org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    const res = await upload(h, issue, ENV);
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentShape };
    expect(attachment.storage_kind).toBe("s3_byo");
    expect(attachment.blob_url).toContain("acct.r2.cloudflarestorage.com/blobs/evenflow/");
    expect(attachment.blob_url).toContain(String(org["id"]));
    expect(h.s3.calls.at(-1)).toMatch(/^put\(image\/png:8\)/);
    expect(h.blossom.calls).toHaveLength(0);
  });

  it("answers 502 storage-unavailable when saved creds cannot be unwrapped at upload time", async () => {
    const h = makeHarness();
    const { issue, org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    // Upload with a DIFFERENT server secret — decrypt must fail closed.
    const res = await upload(h, issue, { EVENFLOW_STORAGE_SECRET: "22".repeat(32) });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "storage-unavailable", reason: "creds-unreadable" });
  });

  it("keeps the executable/type allowlist on BYO storage", async () => {
    const h = makeHarness();
    const { issue, org } = await setup(h);
    expect((await putS3Config(h, org["slug"])).status).toBe(200);
    const res = await h.app.request(
      url("attachment.create", { slug: "kb", issue_ref: issue.id }),
      jsonReq("POST", { file_b64: b64(PNG_BYTES), filename: "run.exe", content_type: "application/x-msdownload" }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("type_not_allowed");
  });

  it("caller pubkey sanity: personal org owner is the uploader", async () => {
    const h = makeHarness();
    const { org } = await setup(h);
    expect(org["created_by"]).toBe(CALLER);
  });
});
