// Landing — the editorial front door. Big serif wordmark on cream, two
// sign-in buttons that hand off to the Worker's /auth/oauth/start (which
// 302s to 4a's AS). If the visitor is already signed in, bounces to
// /boards on mount — no sense making a returning user re-tap Sign in.

import { For, onMount } from "solid-js";
import { url } from "@routes-manifest";
import { useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import { ButterflyMark } from "../components/TopBar";
import { AuthManager, appRuntime } from "../effects";

/**
 * EFB-39 — the free-tier callouts.
 *
 * Every string here is a static literal and nothing in this section reads
 * auth, props or the network. The landing page is the one route a signed-out
 * visitor is guaranteed to reach, so it stays signed-out-safe by
 * construction: there is no user-derived value in scope to leak.
 *
 * Each bullet is a claim followed by the reason the claim survives being
 * checked, which is the register EFB-57 landed for the attachment notice.
 * A bare "unlimited issues" is marketing; "no ticket ceiling" names the
 * gotcha and denies it, and a reader can go verify that.
 */
const BANDS: ReadonlyArray<{ title: string; lines: ReadonlyArray<string> }> = [
  {
    title: "No caps, ever",
    lines: [
      "Unlimited team size — no per-seat pricing. The seat count isn't a number anyone here tracks.",
      "Unlimited issues — no ticket ceiling, no archiving things to stay under a line.",
      "Unlimited boards — no per-org limit.",
      "No storage tier — bring your own S3 or Blossom bucket. No per-GB bill, no upgrade to buy more room.",
    ],
  },
  {
    title: "Full product, not a crippled tier",
    lines: [
      "Sprints, burndown and velocity — the whole planning layer, not a preview of it behind an upgrade.",
      "Public boards — anyone with the link reads them. No account, no login wall.",
      // EFB-57's exact wording, deliberately. The reader meets this same
      // sentence on the issue sheet after they upload a file; a near-miss
      // paraphrase here would cost the page the thing it is claiming.
      "Encrypted private boards — issues, comments and sprints are end-to-end encrypted, not just encrypted at rest. Attachment files are links, and a link, once shared, opens for anyone.",
      "Rich comments — markdown, not a plaintext box.",
      "Cross-board moves — an issue filed on the wrong board moves to the right one and takes its comments with it.",
      "Archive for boards and sprints — finished work leaves the view without leaving the record.",
      // Rule-driven, not automatic: no default rules are seeded, so a bare
      // "merging it moves the issue" would promise behaviour a fresh board
      // does not have until someone writes the rule.
      "GitHub integration — link a pull request to an issue, and your own rules transition it when the PR merges.",
    ],
  },
  {
    title: "Developer + AI surface",
    lines: [
      "A REST API and your own keys — mint one, it acts as you, revoke it whenever.",
      "An MCP endpoint — Claude and any other MCP client drive Evenflow directly. No scraping, no glue code.",
      "Docs and an /evenflow skill — written for callers who aren't people.",
      "AI agents as first-class members — invite one with a pubkey-bound invite, and only that key can accept it.",
    ],
  },
  {
    title: "Identity + data, portable",
    lines: [
      "Bring your own Nostr identity, or sign in with Google or GitHub — there's no account here to create.",
      "Public boards are events on the 4a substrate — your kanban in an open format, not Evenflow's private one.",
      "Leave by reading the substrate. Nothing locks you in, and nothing needs exporting first.",
    ],
  },
];

export const Landing = () => {
  const navigate = useNavigate();
  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then((jwt) => {
        if (jwt !== null) navigate("/boards", { replace: true });
      });
  });
  return (
  <>
  <main
    class="landing-hero-over-ocean"
    style={{
      display: "grid",
      "place-items": "center",
      "min-height": "100vh",
      padding: "3rem 1.5rem",
    }}
  >
    <div style={{ "max-width": "var(--measure)", "text-align": "center" }}>
      <ButterflyMark class="landing-mark" />
      <h1 style={{ "font-size": "clamp(3.5rem, 14vw, 7.5rem)" }}>Evenflow</h1>
      <p
        class="muted"
        style={{ "font-style": "italic", "font-size": "1.3rem", margin: "1.2rem 0 0" }}
      >
        The Even Flow of Work.
      </p>
      <p class="muted" style={{ margin: "0.4rem 0 3.5rem" }}>
        A kanban built on <a href="https://4a4.ai">4a</a>. Free. Yours.
      </p>
      <div style={{ display: "flex", gap: "1rem", "justify-content": "center", "flex-wrap": "wrap" }}>
        {/*
          Full-page nav (not Solid-Router SPA nav) — the Worker returns 302 to
          api.4a4.ai's AS, which then bounces to Google/GitHub. Solid-Router's
          global anchor-click delegate would otherwise intercept these and try
          to SPA-route, hit no match, and render the 404 shell.
        */}
        <a
          class="btn btn-solid btn-over-ocean btn-over-ocean-primary"
          href={`${url("auth.oauth.start")}?provider=google`}
          rel="external"
          onClick={(e) => {
            e.preventDefault();
            window.location.assign(`${url("auth.oauth.start")}?provider=google`);
          }}
        >
          Sign in with Google
        </a>
        <a
          class="btn btn-over-ocean"
          href={`${url("auth.oauth.start")}?provider=github`}
          rel="external"
          onClick={(e) => {
            e.preventDefault();
            window.location.assign(`${url("auth.oauth.start")}?provider=github`);
          }}
        >
          Sign in with GitHub
        </a>
      </div>
      <p class="muted" style={{ "margin-top": "4rem", "font-size": "0.8rem", "letter-spacing": "0.1em", "text-transform": "uppercase" }}>
        <a href="https://github.com/evan108108/evenflow" style={{ "text-decoration": "none" }}>
          github.com/evan108108/evenflow
        </a>
      </p>
    </div>
  </main>
  {/*
    Deliberately a sibling of <main> rather than a child: <main> is a
    place-items:center / min-height:100vh grid, and a second grid item would
    make the hero share the viewport instead of owning it. The ticket is
    explicit that the mark and wordmark above this band stay untouched, so
    the band lands below them and the hero renders pixel-identical.
  */}
  <section class="landing-free">
    <div class="landing-free-head">
      <h2>Everything, at any scale</h2>
      <p class="landing-free-subhead muted">Free by construction, not by promotion.</p>
    </div>

    <For each={BANDS}>
      {(band) => (
        <div class="landing-band">
          <h3 class="landing-band-title">{band.title}</h3>
          <ul>
            <For each={band.lines}>{(line) => <li>{line}</li>}</For>
          </ul>
        </div>
      )}
    </For>

    <p class="landing-free-closer">
      Evenflow doesn't run the meter. The substrate is <a href="https://4a4.ai">4a</a>, the
      storage is yours, the identity is yours — there's no metered surface to bill you for.
    </p>
  </section>
  </>
  );
};
