// SiteFooter — the one place every page links to the documentation.
//
// EFB-103 requires a docs link on EVERY page, the homepage included. The
// obvious move is to add one to TopBar, and it would have LOOKED like it
// satisfied that: TopBar is shared chrome across most of the app. But eight
// pages do not use it — SignIn, NostrSignIn, Profile, InvitePreview, NewOrg,
// OrgMembers, LegacyBoardRedirect and Docs itself — and sign-in is precisely
// where someone arrives without knowing what this is.
//
// So the footer renders from the Router's `root` layout instead: one mount,
// every route, including ones added later and including the 404. A future page
// cannot forget it, which is the difference between "we added the link" and
// "the link is there".
export const SiteFooter = () => (
  <footer class="site-footer">
    <nav class="site-footer-links" aria-label="Site">
      <a href="/docs">Documentation</a>
      <a href="/docs/quickstart">Quickstart</a>
      <a href="/docs/api">API reference</a>
      {/* Served as text/plain by the Worker: the whole documentation set in
          one request, for agents that would rather not crawl seven pages. */}
      <a href="/docs/llms.txt">llms.txt</a>
      {/* API keys removed from footer — it's a settings surface, not a doc.
          Reachable from /settings/keys via the user nav. */}
    </nav>
    <p class="site-footer-note muted">
      Evenflow — the even flow of work. The API is documented in full and open to
      read without an account.
    </p>
  </footer>
);
