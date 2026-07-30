// Landing — the editorial front door. Big serif wordmark on cream, two
// sign-in buttons that hand off to the Worker's /auth/oauth/start (which
// 302s to 4a's AS). If the visitor is already signed in, bounces to
// /boards on mount — no sense making a returning user re-tap Sign in.

import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { Effect } from "effect";
import { ButterflyMark } from "../components/TopBar";
import { AuthManager, appRuntime } from "../effects";

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
  <main
    style={{
      display: "grid",
      "place-items": "center",
      "min-height": "100vh",
      padding: "3rem 1.5rem",
    }}
  >
    <div style={{ "max-width": "var(--measure)", "text-align": "center" }}>
      {/* Kept for document structure / screen readers — the visual identity is the seal below. */}
      <h1
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          "white-space": "nowrap",
          border: 0,
        }}
      >
        Evenflow
      </h1>
      {/*
        Landing seal — butterfly at rest inside a two-arc wordmark ring.
        Split-arc typography: top arc reads left-to-right along the top,
        bottom arc is drawn right-to-left so its text reads right-side up
        from below (classic Residence Era-style seal). A single full-loop
        path leaves the bottom half upside down; two arcs fix that.
      */}
      <div class="landing-seal" role="img" aria-label="Evenflow — the even flow of work">
        <svg class="landing-seal-ring" viewBox="0 0 600 600" aria-hidden="true">
          <defs>
            {/* Top arc: 9 o'clock → 12 → 3 o'clock, sweep=1 (goes UP over top). */}
            <path
              id="landing-seal-arc-top"
              d="M 90,300 A 210,210 0 0 1 510,300"
            />
            {/* Bottom arc: 3 o'clock → 6 → 9 o'clock, sweep=0 (goes DOWN under bottom).
                Path direction reversed vs top so textPath letters flip to read
                right-side up from below. */}
            <path
              id="landing-seal-arc-bottom"
              d="M 510,300 A 210,210 0 0 0 90,300"
            />
          </defs>
          <text class="landing-seal-text landing-seal-text-top">
            <textPath href="#landing-seal-arc-top" startOffset="50%" text-anchor="middle">
              THE EVEN FLOW
            </textPath>
          </text>
          <text class="landing-seal-text landing-seal-text-bottom">
            <textPath href="#landing-seal-arc-bottom" startOffset="50%" text-anchor="middle">
              OF WORK
            </textPath>
          </text>
        </svg>
        <ButterflyMark class="landing-seal-butterfly" />
      </div>
      <p class="muted" style={{ margin: "2.4rem 0 3.5rem" }}>
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
          class="btn btn-solid"
          href="/auth/oauth/start?provider=google"
          rel="external"
          onClick={(e) => {
            e.preventDefault();
            window.location.assign("/auth/oauth/start?provider=google");
          }}
        >
          Sign in with Google
        </a>
        <a
          class="btn"
          href="/auth/oauth/start?provider=github"
          rel="external"
          onClick={(e) => {
            e.preventDefault();
            window.location.assign("/auth/oauth/start?provider=github");
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
  );
};
