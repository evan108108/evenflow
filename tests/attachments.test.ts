// Phase 18a: issue attachments — upload validation matrix, the actionable
// rejection shape, the one-cover invariant, soft-delete, the public-board
// anonymous read matrix, and the kanban cover_url enrichment.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import type { AttachmentShape, IssueShape } from "../src/shapes";
import {
  BLOSSOM_DEFAULT_MAX_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
} from "../src/attachments";
import {
  bearer,
  callerOrg,
  createIssue,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const setup = async (h: Harness) => {
  const res = await h.app.request(url("board.create"), jsonReq("POST", { slug: "kb", title: "Board" }), {});
  expect(res.status).toBe(201);
  return createIssue(h);
};

const uploadPath = (issue: IssueShape) => url("attachment.create", { slug: "kb", issue_ref: issue.id });

const uploadJson = (
  h: Harness,
  issue: IssueShape,
  over: Partial<{ file_b64: string; filename: string; content_type: string }> = {},
) =>
  h.app.request(
    uploadPath(issue),
    jsonReq("POST", {
      file_b64: b64(PNG_BYTES),
      filename: "shot.png",
      content_type: "image/png",
      ...over,
    }),
    {},
  );

const uploadOk = async (h: Harness, issue: IssueShape, filename = "shot.png") => {
  const res = await uploadJson(h, issue, { filename });
  expect(res.status).toBe(201);
  return ((await res.json()) as { attachment: AttachmentShape }).attachment;
};

const setCover = (h: Harness, id: string, is_cover: boolean) =>
  h.app.request(url("attachment.update", { id: id }), jsonReq("PATCH", { is_cover }), {});

describe("upload", () => {
  it("accepts the JSON shape, uploads to Blossom, and returns the row", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const attachment = await uploadOk(h, issue);
    expect(attachment).toMatchObject({
      issue_id: issue.id,
      filename: "shot.png",
      content_type: "image/png",
      size_bytes: PNG_BYTES.byteLength,
      storage_kind: "blossom_default",
      is_cover: false,
      blob_url: `https://blossom.test/sha-${PNG_BYTES.byteLength}`,
      sha256: `sha-${PNG_BYTES.byteLength}`,
    });
    expect(h.blossom.calls).toEqual([`image/png:shot.png:${PNG_BYTES.byteLength}`]);
    expect(h.db.attachments).toHaveLength(1);
  });

  it("accepts multipart form-data with a `file` field", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const form = new FormData();
    form.append("file", new File([PNG_BYTES], "drop.png", { type: "image/png" }));
    const res = await h.app.request(
      uploadPath(issue),
      { method: "POST", headers: bearer, body: form },
      {},
    );
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentShape };
    expect(attachment).toMatchObject({ filename: "drop.png", content_type: "image/png" });
  });

  it("rejects an over-cap file with the actionable size_exceeded shape", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const big = new Uint8Array(BLOSSOM_DEFAULT_MAX_BYTES + 1);
    const res = await uploadJson(h, issue, { file_b64: b64(big) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string; link: string };
    expect(body.code).toBe("size_exceeded");
    expect(body.message).toContain("5.0MB per file");
    expect(body.message).toContain("Set up your own bucket");
    expect(body.link).toBe("/@tester/settings#storage");
    expect(h.blossom.calls).toHaveLength(0);
  });

  it("rejects the 21st attachment with count_exceeded", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    for (let i = 0; i < MAX_ATTACHMENTS_PER_ISSUE; i++) {
      await uploadOk(h, issue, `f${i}.png`);
    }
    const res = await uploadJson(h, issue, { filename: "straw.png" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("count_exceeded");
    expect(body.message).toContain(String(MAX_ATTACHMENTS_PER_ISSUE));
  });

  it("rejects disallowed types; executables get named loudly", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const html = await uploadJson(h, issue, { content_type: "text/html", filename: "page.html" });
    expect(html.status).toBe(400);
    expect(((await html.json()) as { code: string }).code).toBe("type_not_allowed");

    const exe = await uploadJson(h, issue, {
      content_type: "application/x-msdownload",
      filename: "setup.exe",
    });
    expect(exe.status).toBe(400);
    const body = (await exe.json()) as { code: string; message: string };
    expect(body.code).toBe("type_not_allowed");
    expect(body.message).toContain("Executable");
    expect(h.blossom.calls).toHaveLength(0);
  });

  it("requires auth (401 anonymous) and contributor role (403 viewer)", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const anon = await h.app.request(
      uploadPath(issue),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_b64: b64(PNG_BYTES), filename: "x.png", content_type: "image/png" }),
      },
      {},
    );
    expect(anon.status).toBe(401);

    // Public board: a signed-in stranger holds only the viewer floor.
    await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "public" }), {});
    const viewer = await h.app.request(
      uploadPath(issue),
      jsonReq("POST", { file_b64: b64(PNG_BYTES), filename: "x.png", content_type: "image/png" }, "tok-stranger"),
      {},
    );
    expect(viewer.status).toBe(403);
  });

  it("surfaces a Blossom outage as 502 without writing a row", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    h.blossom.failUploads = true;
    const res = await uploadJson(h, issue);
    expect(res.status).toBe(502);
    expect(h.db.attachments).toHaveLength(0);
  });

  // ── EFB-80 ────────────────────────────────────────────────────────────
  // The default host's free tier serves images only; documents and archives
  // are gated behind a paid plan. We used to accept all eight allowed types
  // at the edge and let four of them 415 upstream, which reached the user as
  // an opaque 502 and left no server-side trace at all.

  it("refuses BYO-only types on default storage before touching the host", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    for (const [content_type, filename] of [
      ["application/pdf", "spec.pdf"],
      ["text/plain", "notes.txt"],
      ["application/zip", "bundle.zip"],
      ["application/json", "data.json"],
    ] as const) {
      const res = await uploadJson(h, issue, { content_type, filename });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string; link: string };
      expect(body.code).toBe("type_not_allowed");
      // Actionable: names the type, points at BYO setup, and never names
      // the upstream host — routing stays an implementation detail.
      expect(body.message).toContain(content_type);
      expect(body.message).toContain("your own storage bucket");
      expect(body.message).not.toContain("blossom");
      expect(body.link).toContain("#storage");
    }
    // The whole point: no wasted round-trip, and no row.
    expect(h.blossom.calls).toHaveLength(0);
    expect(h.db.attachments).toHaveLength(0);
  });

  it("takes those same types once the org brings its own bucket", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const put = await h.app.request(
      url("storage.get", { org_slug: String(callerOrg(h)["slug"]) }),
      jsonReq("PUT", { kind: "blossom", blossom_url: "https://blobs.acme.dev" }),
      {},
    );
    expect(put.status).toBe(200);
    const res = await uploadJson(h, issue, { content_type: "application/pdf", filename: "spec.pdf" });
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as { attachment: AttachmentShape };
    expect(attachment.storage_kind).toBe("blossom_byo");
  });

  it("carries the upstream status out of a storage failure and audits it", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    h.blossom.failUploads = true;
    const res = await uploadJson(h, issue);
    expect(res.status).toBe(502);
    // Previously every storage failure collapsed to reason:"http" with the
    // status dropped, so a rate-limit was indistinguishable from an outage.
    expect(await res.json()).toMatchObject({ error: "storage-unavailable", status: 502 });

    const failure = h.audit.events.find((e) => e.event_type === "attachment_upload_failed");
    expect(failure).toBeDefined();
    // The operator-facing half: upstream status + message land in the audit
    // log (a JSON line in Workers observability), not in the HTTP response.
    expect(failure?.details).toMatchObject({
      storage_kind: "default",
      error: "BlossomError",
      status: 502,
      detail: "test-outage",
      content_type: "image/png",
    });
    expect(h.db.attachments).toHaveLength(0);
  });

  it("rejects a malformed body with 400", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const res = await h.app.request(uploadPath(issue), jsonReq("POST", { filename: "x.png" }), {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("upload-body");
  });

  it("resolves the issue by short id on the org-scoped path too", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const res = await h.app.request(
      url("attachment.create", { slug: "kb", issue_ref: issue.short_id }, "tester"),
      jsonReq("POST", { file_b64: b64(PNG_BYTES), filename: "org.png", content_type: "image/png" }),
      {},
    );
    expect(res.status).toBe(201);
  });
});

describe("covers", () => {
  it("sets a cover, and switching covers clears the previous one", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const a = await uploadOk(h, issue, "a.png");
    const b = await uploadOk(h, issue, "b.png");

    const setA = await setCover(h, a.id, true);
    expect(setA.status).toBe(200);
    expect(((await setA.json()) as { attachment: AttachmentShape }).attachment.is_cover).toBe(true);

    const setB = await setCover(h, b.id, true);
    expect(setB.status).toBe(200);

    const rows = h.db.attachments;
    expect(rows.find((r) => r["id"] === a.id)!["is_cover"]).toBe(0);
    expect(rows.find((r) => r["id"] === b.id)!["is_cover"]).toBe(1);
  });

  it("clears a cover with is_cover:false", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const a = await uploadOk(h, issue);
    await setCover(h, a.id, true);
    const res = await setCover(h, a.id, false);
    expect(res.status).toBe(200);
    expect(h.db.attachments[0]!["is_cover"]).toBe(0);
  });

  it("validates the body and 404s unknown or deleted attachments", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const a = await uploadOk(h, issue);
    const bad = await h.app.request(url("attachment.update", { id: a.id }), jsonReq("PATCH", { is_cover: "yes" }), {});
    expect(bad.status).toBe(400);
    const ghost = await setCover(h, "ghost", true);
    expect(ghost.status).toBe(404);

    await h.app.request(url("attachment.update", { id: a.id }), jsonReq("DELETE"), {});
    const gone = await setCover(h, a.id, true);
    expect(gone.status).toBe(404);
  });

  it("requires auth", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const a = await uploadOk(h, issue);
    const res = await h.app.request(url("attachment.update", { id: a.id }), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_cover: true }),
    }, {});
    expect(res.status).toBe(401);
  });
});

describe("delete + list", () => {
  it("soft-deletes: the row keeps its blob but hides from the list", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    const a = await uploadOk(h, issue, "a.png");
    const b = await uploadOk(h, issue, "b.png");

    const res = await h.app.request(url("attachment.update", { id: a.id }), jsonReq("DELETE"), {});
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ deleted: true });
    // Soft delete: the row survives with deleted_at_ms set.
    expect(h.db.attachments.find((r) => r["id"] === a.id)!["deleted_at_ms"]).not.toBeNull();

    const list = await h.app.request(uploadPath(issue), { headers: bearer }, {});
    const { attachments } = (await list.json()) as { attachments: AttachmentShape[] };
    expect(attachments.map((x) => x.id)).toEqual([b.id]);
  });

  it("404s an unknown attachment", async () => {
    const h = makeHarness();
    await setup(h);
    const res = await h.app.request(url("attachment.update", { id: "ghost" }), jsonReq("DELETE"), {});
    expect(res.status).toBe(404);
  });

  it("lists in upload order for members on a private board", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    await uploadOk(h, issue, "first.png");
    vi.setSystemTime(2_000);
    await uploadOk(h, issue, "second.png");
    const res = await h.app.request(uploadPath(issue), { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { attachments } = (await res.json()) as { attachments: AttachmentShape[] };
    expect(attachments.map((x) => x.filename)).toEqual(["first.png", "second.png"]);
  });

  it("anonymous list: 401 on a private board, 200 once public", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    await uploadOk(h, issue);

    // EFB-76: was 404. The board scope resolves before the issue lookup, so
    // the 401 comes from resolveBoardScope — the anonymous caller never learns
    // whether the issue behind it exists.
    const before = await h.app.request(uploadPath(issue), {}, {});
    expect(before.status).toBe(401);

    await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "public" }), {});
    const after = await h.app.request(uploadPath(issue), {}, {});
    expect(after.status).toBe(200);
    const { attachments } = (await after.json()) as { attachments: AttachmentShape[] };
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ filename: "shot.png", is_cover: false });
  });
});

describe("kanban cover enrichment + body_format", () => {
  it("issues list carries cover_url for image covers only", async () => {
    const h = makeHarness();
    const withCover = await setup(h);
    const without = await createIssue(h, { title: "No cover" });
    const pdfIssue = await createIssue(h, { title: "Pdf cover" });

    const img = await uploadOk(h, withCover);
    await setCover(h, img.id, true);

    // A PDF only exists as an attachment on BYO storage — the default host
    // takes images only (EFB-80) — so point the org at its own Blossom
    // before uploading the non-image cover this assertion needs.
    const byo = await h.app.request(
      url("storage.get", { org_slug: String(callerOrg(h)["slug"]) }),
      jsonReq("PUT", { kind: "blossom", blossom_url: "https://blobs.acme.dev" }),
      {},
    );
    expect(byo.status).toBe(200);
    const pdfRes = await uploadJson(h, pdfIssue, { content_type: "application/pdf", filename: "spec.pdf" });
    expect(pdfRes.status).toBe(201);
    const pdf = ((await pdfRes.json()) as { attachment: AttachmentShape }).attachment;
    await setCover(h, pdf.id, true);

    const list = await h.app.request(`${url("issue.create", { slug: "kb" })}?limit=100`, { headers: bearer }, {});
    const { issues } = (await list.json()) as { issues: Array<IssueShape & { cover_url: string | null }> };
    const byId = new Map(issues.map((i) => [i.id, i.cover_url]));
    expect(byId.get(withCover.id)).toBe(img.blob_url);
    expect(byId.get(without.id)).toBeNull();
    // Non-image cover exists in D1 but never surfaces as a card cover.
    expect(byId.get(pdfIssue.id)).toBeNull();
  });

  it("new issues default body_format markdown; PATCH validates the enum", async () => {
    const h = makeHarness();
    const issue = await setup(h);
    expect(issue.body_format).toBe("markdown");

    const plain = await createIssue(h, { title: "Old style", body: "raw", body_format: "plain" });
    expect(plain.body_format).toBe("plain");

    const flip = await h.app.request(
      url("issue.get", { id: plain.id }),
      jsonReq("PATCH", { body: "# now md", body_format: "markdown" }),
      {},
    );
    expect(flip.status).toBe(200);
    expect(((await flip.json()) as { issue: IssueShape }).issue.body_format).toBe("markdown");

    const bad = await h.app.request(
      url("issue.get", { id: plain.id }),
      jsonReq("PATCH", { body_format: "html" }),
      {},
    );
    expect(bad.status).toBe(400);
  });
});
