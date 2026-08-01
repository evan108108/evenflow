// EFB-67 v2 — MobileBoardHeader.
//
// The point of these tests, and their limit, stated up front: the mobile
// header now duplicates the signed-out / read-only conditions that the desktop
// header states separately (Evan's chosen tradeoff for a clean split). The
// failure mode of duplication is silent drift, so what is asserted here is the
// EFB-47 gate on the mobile copy specifically.
//
// WHAT THESE CANNOT TELL YOU: which header a phone actually displays. That is
// decided by a CSS media query, and jsdom does not lay out or apply media
// queries. Asserting "renders under viewport ≤768px" in this environment would
// mean stubbing matchMedia and then asserting the stub — a test that passes by
// construction, which is the exact shape that let v1 through. The real check is
// a device-emulated screenshot at 375/393/428, recorded in the PR.

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { MobileBoardHeader } from "./MobileBoardHeader";

const mount = (props: Partial<Parameters<typeof MobileBoardHeader>[0]> = {}) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => (
      <MobileBoardHeader
        title="Evan's Flow Board"
        issuePrefix="EFB"
        base="/@evan108108/evan-s-flow-board"
        orgHandle="evan108108"
        readOnly={false}
        onNewIssue={() => {}}
        {...props}
      />
    ),
    host,
  );
  return { host, dispose };
};

const text = (host: HTMLElement) => host.textContent ?? "";

describe("MobileBoardHeader — content", () => {
  it("renders the board title and prefix chip", () => {
    const { host, dispose } = mount();
    expect(host.querySelector(".mbh-title")?.textContent).toBe("Evan's Flow Board");
    expect(host.querySelector(".prefix-chip")?.textContent).toBe("EFB");
    dispose();
  });

  it("omits the prefix chip when the board has no prefix", () => {
    const { host, dispose } = mount({ issuePrefix: null });
    expect(host.querySelector(".prefix-chip")).toBeNull();
    dispose();
  });

  it("gives every icon-only control an accessible name", () => {
    // `title` is not an accessible name on a touch device — there is no hover
    // to reveal it — so each icon button carries an .sr-only label.
    const { host, dispose } = mount();
    const labels = [...host.querySelectorAll(".mbh-icon-btn .sr-only")].map((n) =>
      n.textContent?.trim(),
    );
    expect(labels).toEqual(["Sprint controls", "Board settings"]);
    dispose();
  });

  it("fires onNewIssue when the primary action is tapped", () => {
    const onNewIssue = vi.fn();
    const { host, dispose } = mount({ onNewIssue });
    host.querySelector<HTMLButtonElement>(".mbh-new")?.click();
    expect(onNewIssue).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("MobileBoardHeader — EFB-47 read-only gate", () => {
  // Absence assertions with a signed-in counterpart each, per the reasoning in
  // signedOutBoard.test.tsx: a gate that hid the control from everybody would
  // pass an absence-only test while breaking the app.

  it("hides both mutation entry points for a read-only viewer", () => {
    const { host, dispose } = mount({ readOnly: true });
    expect(host.querySelector(".mbh-new")).toBeNull();
    expect(text(host)).not.toContain("Board settings");
    dispose();
  });

  it("keeps sprint history reachable for a read-only viewer", () => {
    // Read-only view; a signed-out visitor on a public board may open it.
    const { host, dispose } = mount({ readOnly: true });
    expect(text(host)).toContain("Sprint controls");
    dispose();
  });

  it("shows both mutation entry points for a contributor", () => {
    const { host, dispose } = mount({ readOnly: false });
    expect(host.querySelector(".mbh-new")).not.toBeNull();
    expect(text(host)).toContain("Board settings");
    dispose();
  });

  it("hides settings when the board resolves to no org, even if writable", () => {
    // Mirrors the desktop condition `orgHandle() && !boardReadOnly()` — the
    // settings route does not exist without an org handle.
    const { host, dispose } = mount({ orgHandle: null, readOnly: false });
    expect(text(host)).not.toContain("Board settings");
    expect(host.querySelector(".mbh-new")).not.toBeNull();
    dispose();
  });
});
