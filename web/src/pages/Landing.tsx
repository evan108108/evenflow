// Landing — the editorial front door. Big serif wordmark on cream, two
// sign-in buttons that hand off to the Worker's /auth/oauth/start (which
// 302s to 4a's AS).

export const Landing = () => (
  <main
    style={{
      display: "grid",
      "place-items": "center",
      "min-height": "100vh",
      padding: "3rem 1.5rem",
    }}
  >
    <div style={{ "max-width": "var(--measure)", "text-align": "center" }}>
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
