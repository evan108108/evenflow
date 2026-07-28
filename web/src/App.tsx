// Router + layout shell. Pages own their content; this owns the routes.
// /auth/callback is where 4a's AS returns with the JWT; everything unknown
// drifts to the 404.

import { Route, Router } from "@solidjs/router";
import { BoardPage } from "./pages/board/BoardPage";
import { BoardsList } from "./pages/BoardsList";
import { Landing } from "./pages/Landing";
import { SignIn } from "./pages/SignIn";

const Drifting = () => (
  <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
    <p class="muted">
      This page is drifting. <a href="/">Head back to the flow →</a>
    </p>
  </main>
);

export const App = () => (
  <Router>
    <Route path="/" component={Landing} />
    <Route path="/auth/callback" component={SignIn} />
    <Route path="/boards" component={BoardsList} />
    <Route path="/boards/:slug" component={BoardPage} />
    <Route path="/boards/:slug/backlog" component={BoardPage} />
    <Route path="/boards/:slug/icebox" component={BoardPage} />
    <Route path="/boards/:slug/issues/:id" component={BoardPage} />
    <Route path="*" component={Drifting} />
  </Router>
);
