// Org Settings → Storage (phase 18b BYOB): choose where the org's
// attachment blobs live — Evenflow's managed Blossom, the org's own
// Blossom, or an S3-compatible bucket.
//
// S3 credentials never travel or persist in plaintext: on save the client
// fetches the server's static pubkey and NIP-44-encrypts them to it with an
// ephemeral sender key (lib/storageCrypto.ts). The credential signals are
// cleared as soon as the PUT is sent, and the GET view only ever reports
// has_credentials — the secret is write-only from the browser's viewpoint.

import { Show, createResource, createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { encryptCredsToServer } from "../lib/storageCrypto";

interface StorageConfigView {
  kind: "default" | "blossom" | "s3";
  blossom_url?: string | null;
  s3_endpoint?: string | null;
  s3_region?: string | null;
  s3_bucket?: string | null;
  s3_path_style?: boolean;
  has_credentials?: boolean;
}

type TestResult = { ok: true } | { ok: false; code: string; message: string };

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const StorageSection = (props: { handle: string }) => {
  const storageApi = () => `/api/v0/orgs/${encodeURIComponent(props.handle)}/storage`;

  const [saved, { refetch }] = createResource(
    () => props.handle,
    () => api<{ config: StorageConfigView }>((c) => c.get(storageApi())).then((r) => r.config),
  );

  const [kind, setKind] = createSignal<"default" | "blossom" | "s3" | null>(null);
  const [blossomUrl, setBlossomUrl] = createSignal<string | null>(null);
  const [endpoint, setEndpoint] = createSignal<string | null>(null);
  const [region, setRegion] = createSignal<string | null>(null);
  const [bucket, setBucket] = createSignal<string | null>(null);
  const [pathStyle, setPathStyle] = createSignal<boolean | null>(null);
  // Write-only: never prefilled from the server, cleared on save.
  const [accessKeyId, setAccessKeyId] = createSignal("");
  const [secretAccessKey, setSecretAccessKey] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const kindValue = () => kind() ?? saved()?.kind ?? "default";
  const field = (local: () => string | null, remote: () => string | null | undefined) => () =>
    local() ?? remote() ?? "";
  const blossomValue = field(blossomUrl, () => saved()?.blossom_url);
  const endpointValue = field(endpoint, () => saved()?.s3_endpoint);
  const regionValue = field(region, () => saved()?.s3_region);
  const bucketValue = field(bucket, () => saved()?.s3_bucket);
  const pathStyleValue = () => pathStyle() ?? saved()?.s3_path_style ?? true;

  const summary = () => {
    const cfg = saved();
    if (cfg === undefined || cfg.kind === "default") {
      return "Attachments live on Evenflow's managed storage.";
    }
    if (cfg.kind === "blossom") return `Attachments live on your Blossom at ${cfg.blossom_url}.`;
    return `Attachments live in your bucket "${cfg.s3_bucket}" at ${cfg.s3_endpoint}.`;
  };

  const clearSecrets = () => {
    setAccessKeyId("");
    setSecretAccessKey("");
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const k = kindValue();
      let body: Record<string, unknown>;
      if (k === "default") {
        body = { kind: "default" };
      } else if (k === "blossom") {
        body = { kind: "blossom", blossom_url: blossomValue().trim() };
      } else {
        body = {
          kind: "s3",
          s3_endpoint: endpointValue().trim(),
          s3_region: regionValue().trim(),
          s3_bucket: bucketValue().trim(),
          s3_path_style: pathStyleValue(),
        };
        const id = accessKeyId().trim();
        const secret = secretAccessKey().trim();
        if (id !== "" || secret !== "") {
          if (id === "" || secret === "") {
            setError("Enter both the access key id and the secret access key.");
            return;
          }
          const { pubkey } = await api<{ pubkey: string }>((c) => c.get("/api/v0/server-pubkey"));
          const sealed = encryptCredsToServer(pubkey, {
            access_key_id: id,
            secret_access_key: secret,
          });
          body["s3_creds_ciphertext"] = sealed.ciphertext;
          body["s3_creds_sender_pubkey"] = sealed.senderPubkey;
          clearSecrets();
        } else if (saved()?.has_credentials !== true) {
          setError("Enter the bucket's access key id and secret access key.");
          return;
        }
      }
      await api((c) => c.put(storageApi(), body));
      setNotice("Saved — flowing outward.");
      void refetch();
    } catch {
      setError("The current pushed back. Nothing was saved — try again.");
    } finally {
      clearSecrets();
      setBusy(false);
    }
  };

  const test = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<TestResult>((c) => c.post(`${storageApi()}/test`, {}));
      if (result.ok) setNotice("Connection test passed — the backend answered.");
      else setError(`Connection test failed (${result.code}): ${result.message}`);
    } catch {
      setError("The current pushed back — the test never ran.");
    } finally {
      setBusy(false);
    }
  };

  const radio = (value: "default" | "blossom" | "s3", label: string) => (
    <label style={{ display: "flex", "align-items": "center", gap: "0.5rem", cursor: "pointer" }}>
      <input
        type="radio"
        name="storage-kind"
        checked={kindValue() === value}
        onChange={() => setKind(value)}
      />
      {label}
    </label>
  );

  return (
    <section class="settings-section">
      <h2>Storage</h2>
      <Show when={!saved.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <form class="profile-form" onSubmit={save}>
          <div style={{ display: "flex", "flex-direction": "column", gap: "0.4rem", "margin-bottom": "0.6rem" }}>
            {radio("default", "Evenflow (default)")}
            {radio("blossom", "Your Blossom")}
            {radio("s3", "Your S3-compatible bucket")}
          </div>

          <Show when={kindValue() === "blossom"}>
            <label for="storage-blossom-url">Blossom URL</label>
            <input
              id="storage-blossom-url"
              type="text"
              maxlength="512"
              placeholder="https://blossom.example.org"
              value={blossomValue()}
              onInput={(e) => setBlossomUrl(e.currentTarget.value)}
            />
          </Show>

          <Show when={kindValue() === "s3"}>
            <label for="storage-s3-endpoint">Endpoint</label>
            <input
              id="storage-s3-endpoint"
              type="text"
              maxlength="512"
              placeholder="<account>.r2.cloudflarestorage.com"
              value={endpointValue()}
              onInput={(e) => setEndpoint(e.currentTarget.value)}
            />
            <label for="storage-s3-region">Region</label>
            <input
              id="storage-s3-region"
              type="text"
              maxlength="512"
              placeholder="auto"
              value={regionValue()}
              onInput={(e) => setRegion(e.currentTarget.value)}
            />
            <label for="storage-s3-bucket">Bucket</label>
            <input
              id="storage-s3-bucket"
              type="text"
              maxlength="512"
              value={bucketValue()}
              onInput={(e) => setBucket(e.currentTarget.value)}
            />
            <label for="storage-s3-access-key">
              Access key id{saved()?.has_credentials === true ? " (saved — leave blank to keep)" : ""}
            </label>
            <input
              id="storage-s3-access-key"
              type="password"
              autocomplete="off"
              maxlength="512"
              value={accessKeyId()}
              onInput={(e) => setAccessKeyId(e.currentTarget.value)}
            />
            <label for="storage-s3-secret-key">Secret access key</label>
            <input
              id="storage-s3-secret-key"
              type="password"
              autocomplete="off"
              maxlength="512"
              value={secretAccessKey()}
              onInput={(e) => setSecretAccessKey(e.currentTarget.value)}
            />
            <label style={{ display: "flex", "align-items": "center", gap: "0.5rem", cursor: "pointer", "margin-top": "0.4rem" }}>
              <input
                type="checkbox"
                checked={pathStyleValue()}
                onChange={(e) => setPathStyle(e.currentTarget.checked)}
              />
              Path-style addressing (required for R2)
            </label>
            <span class="muted" style={{ "font-size": "0.8rem" }}>
              Credentials are encrypted in your browser to Evenflow's server key — org members
              never see them, and they can't be read back out of this form.
            </span>
          </Show>

          <div class="actions" style={{ "margin-top": "1rem" }}>
            <button class="btn btn-solid" type="submit" disabled={busy()}>
              {busy() ? "Saving…" : "Save"}
            </button>
            <button class="btn" type="button" disabled={busy()} onClick={() => void test()}>
              Test connection
            </button>
            <Show when={notice()}>
              <span class="muted" style={{ "font-size": "0.9rem" }}>
                {notice()}
              </span>
            </Show>
          </div>
          <Show when={error()}>
            <p class="muted" role="alert" style={{ "margin-top": "0.6rem" }}>
              {error()}
            </p>
          </Show>
          <p class="muted" style={{ "font-size": "0.85rem", "margin-top": "0.8rem" }}>
            {summary()}
          </p>
        </form>
      </Show>
    </section>
  );
};
