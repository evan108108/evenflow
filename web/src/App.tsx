// Router + layout shell. Pages own their content; this owns the routes.
// /signin is where the Worker's /auth/callback lands with #jwt= after the
// code exchange; everything unknown drifts to the 404.
//
// Phase 16: the /@{handle} namespace. Solid Router params can't embed a
// literal @ inside a segment, so handle routes use :handle with a
// matchFilter requiring the @ prefix; pages strip it. /i/inv-* is the
// invite preview (short-id /i/FLOW-42 links are 302'd by the Worker before
// the SPA ever sees them).

import { Route, Router } from "@solidjs/router";
import { BoardPage } from "./pages/board/BoardPage";
import { BoardSettings } from "./pages/BoardSettings";
import { BoardsList } from "./pages/BoardsList";
import { DeveloperKeys } from "./pages/DeveloperKeys";
import { Docs } from "./pages/Docs";
import { HandlePage } from "./pages/HandlePage";
import { InvitePreview } from "./pages/InvitePreview";
import { Landing } from "./pages/Landing";
import { LegacyBoardRedirect } from "./pages/LegacyBoardRedirect";
import { NewOrg } from "./pages/NewOrg";
import { OrgMembers } from "./pages/OrgMembers";
import { OrgSettings } from "./pages/OrgSettings";
import { Profile } from "./pages/Profile";
import { SignIn } from "./pages/SignIn";

const HANDLE_FILTER = { handle: /^@[a-z0-9][a-z0-9-]*$/ };
const INVITE_FILTER = { code: /^inv-[a-z0-9]+$/ };

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
    <Route path="/signin" component={SignIn} />
    <Route path="/profile" component={Profile} />
    <Route path="/docs" component={Docs} />
    <Route path="/settings/keys" component={DeveloperKeys} />
    <Route path="/boards" component={BoardsList} />
    <Route path="/boards/:slug" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/backlog" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/icebox" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/issues/:issueRef" component={LegacyBoardRedirect} />
    <Route path="/o/new" component={NewOrg} />
    <Route path="/i/:code" component={InvitePreview} matchFilters={INVITE_FILTER} />
    <Route path="/:handle" component={HandlePage} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/settings" component={OrgSettings} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/members" component={OrgMembers} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/:board_slug" component={BoardPage} matchFilters={HANDLE_FILTER}>
      <Route path="/" />
      <Route path="/backlog" />
      <Route path="/icebox" />
      <Route path="/issues/:issueRef" />
    </Route>
    <Route
      path="/:handle/:board_slug/settings"
      component={BoardSettings}
      matchFilters={HANDLE_FILTER}
    />
    <Route path="*" component={Drifting} />
  </Router>
);
