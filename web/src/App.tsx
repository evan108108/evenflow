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
import { ArchivedBoardsList, BoardsList } from "./pages/BoardsList";
import { DeveloperKeys } from "./pages/DeveloperKeys";
import { Docs } from "./pages/Docs";
import { DocsSection } from "./pages/DocsSection";
import { SiteFooter } from "./components/SiteFooter";
import { HandlePage } from "./pages/HandlePage";
import { InvitePreview } from "./pages/InvitePreview";
import { Landing } from "./pages/Landing";
import { LegacyBoardRedirect } from "./pages/LegacyBoardRedirect";
import { NewOrg } from "./pages/NewOrg";
import { OrgMembers } from "./pages/OrgMembers";
import { Orgs } from "./pages/Orgs";
import { NotificationsSettings } from "./pages/NotificationsSettings";
import { OrgSettings } from "./pages/OrgSettings";
import { Profile } from "./pages/Profile";
import { SignIn } from "./pages/SignIn";
import { SprintArchive } from "./pages/SprintArchive";
import { SprintsList } from "./pages/SprintsList";

const HANDLE_FILTER = { handle: /^@[a-z0-9][a-z0-9-]*$/ };
const INVITE_FILTER = { code: /^inv-[a-z0-9]+$/ };

const Drifting = () => (
  <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
    <p class="muted">
      This page is drifting. <a href="/">Head back to the flow →</a>
    </p>
  </main>
);

/**
 * Every page, plus the footer that carries the documentation link.
 *
 * Rendered by the Router's `root`, so it wraps every route — including routes
 * added later and including the 404. EFB-103 asked for a docs link on every
 * page; putting it in shared chrome that eight pages do not use would have
 * looked like compliance without being it.
 */
import { OceanBackground } from "./components/OceanBackground";

export const Shell = (props: { children?: unknown }) => (
  <>
    <OceanBackground />
    {props.children as never}
    <SiteFooter />
  </>
);

export const App = () => (
  <Router root={Shell}>
    <Route path="/" component={Landing} />
    <Route path="/signin" component={SignIn} />
    <Route path="/profile" component={Profile} />
    <Route path="/docs" component={Docs} />
    <Route path="/docs/:section" component={DocsSection} />
    <Route path="/settings/keys" component={DeveloperKeys} />
    <Route path="/settings/notifications" component={NotificationsSettings} />
    <Route path="/boards" component={() => <BoardsList />} />
    {/* Static /boards/archived must register before the :slug legacy redirect. */}
    <Route path="/boards/archived" component={ArchivedBoardsList} />
    <Route path="/boards/:slug" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/backlog" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/icebox" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/issue/:issueRef" component={LegacyBoardRedirect} />
    <Route path="/boards/:slug/issues/:issueRef" component={LegacyBoardRedirect} />
    <Route path="/o/new" component={NewOrg} />
    <Route path="/orgs" component={Orgs} />
    <Route path="/i/:code" component={InvitePreview} matchFilters={INVITE_FILTER} />
    <Route path="/:handle" component={HandlePage} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/settings" component={OrgSettings} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/members" component={OrgMembers} matchFilters={HANDLE_FILTER} />
    <Route path="/:handle/:board_slug" component={BoardPage} matchFilters={HANDLE_FILTER}>
      <Route path="/" />
      <Route path="/backlog" />
      <Route path="/icebox" />
      {/* An issue sheet opens over whichever view you were on, so the view
          stays in the path. A bare issue ref (no view segment) is kept for
          old bookmarks and resolves to kanban.

          EFB-89: /issue/:ref is the singular canonical form — it addresses
          one issue. The plural /issues/:ref is every link minted before it
          (bookmarks, PR bodies, AFK email subjects), so it stays registered
          in parallel rather than redirecting: an additive route breaks
          nothing, where a 301 is a real trip for anything caching URLs. */}
      <Route path="/issue/:issueRef" />
      <Route path="/backlog/issue/:issueRef" />
      <Route path="/icebox/issue/:issueRef" />
      <Route path="/issues/:issueRef" />
      <Route path="/backlog/issues/:issueRef" />
      <Route path="/icebox/issues/:issueRef" />
    </Route>
    <Route
      path="/:handle/:board_slug/settings"
      component={BoardSettings}
      matchFilters={HANDLE_FILTER}
    />
    <Route
      path="/:handle/:board_slug/sprints"
      component={SprintsList}
      matchFilters={HANDLE_FILTER}
    />
    <Route
      path="/:handle/:board_slug/sprints/:sprintId"
      component={SprintArchive}
      matchFilters={HANDLE_FILTER}
    />
    <Route path="*" component={Drifting} />
  </Router>
);
