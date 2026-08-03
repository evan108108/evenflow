// Page shell tests in jsdom: the landing renders the editorial wordmark +
// sign-in handoffs, and the callback JWT extractor handles query and
// fragment shapes.

import { describe, expect, it } from "vitest";
import { url } from "@routes-manifest";
import { render } from "solid-js/web";
import { MemoryRouter, Route } from "@solidjs/router";
import { Landing } from "./Landing";
import { jwtFromCallbackUrl } from "./SignIn";

// Landing calls useNavigate (signed-in bounce), so it must mount inside a
// router even in jsdom.
const mount = (component: () => unknown) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <MemoryRouter>
        <Route path="*rest" component={component as () => any} />
      </MemoryRouter>
    ),
    container,
  );
  return { container, dispose };
};

describe("Landing", () => {
  it("renders the wordmark, tagline, and both sign-in buttons", () => {
    const { container, dispose } = mount(() => <Landing />);
    expect(container.querySelector("h1")?.textContent).toBe("Evenflow");
    expect(container.textContent).toContain("The Even Flow of Work.");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain(`${url("auth.oauth.start")}?provider=google`);
    expect(hrefs).toContain(`${url("auth.oauth.start")}?provider=github`);
    dispose();
    container.remove();
  });
});

describe("jwtFromCallbackUrl", () => {
  it("reads ?jwt=, ?token=, and #jwt= shapes; null when absent", () => {
    expect(jwtFromCallbackUrl(new URL("https://x/auth/callback?jwt=a.b.c"))).toBe("a.b.c");
    expect(jwtFromCallbackUrl(new URL("https://x/auth/callback?token=t.t.t"))).toBe("t.t.t");
    expect(jwtFromCallbackUrl(new URL("https://x/auth/callback#jwt=f.f.f"))).toBe("f.f.f");
    expect(jwtFromCallbackUrl(new URL("https://x/auth/callback"))).toBeNull();
  });
});
