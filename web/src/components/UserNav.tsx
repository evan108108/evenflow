// Small nav pill: Profile link + Sign out button. Sign out clears the JWT
// from localStorage and lands the visitor back on the marketing landing.

import { useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import { AuthManager, appRuntime } from "../effects";

export const UserNav = () => {
  const navigate = useNavigate();
  const signOut = () => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.clear()))
      .then(() => navigate("/", { replace: true }));
  };
  return (
    <>
      <a class="btn" href="/profile">
        Profile
      </a>
      <button class="btn" type="button" onClick={signOut} title="Sign out of Evenflow">
        Sign out
      </button>
    </>
  );
};
