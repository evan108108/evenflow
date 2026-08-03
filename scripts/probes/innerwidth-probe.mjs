// innerwidth-probe — demonstrates the layout-viewport trap that EFB-67 v1
// shipped as a regression and EFB-77 closed the last callers of.
//
// THE CLAIM UNDER TEST
//
//   On a page that overflows horizontally, Chromium reports
//   `window.innerWidth` as the SCROLLABLE width, not the layout viewport.
//   `document.documentElement.clientWidth` stays correct. Any layout decision
//   keyed on innerWidth therefore reads the wrong number precisely when the
//   page overflows — including the decisions that determine whether it
//   overflows at all.
//
// WHY THIS FILE EXISTS RATHER THAN A UNIT TEST
//
//   No unit test can demonstrate this. jsdom does not implement the mobile
//   layout-viewport algorithm, and neither does desktop-width Chrome — the
//   inflation only appears under mobile emulation. web/src/lib/layout.ts says
//   it plainly: a pure function tested with clean synthetic widths is not
//   evidence about the number the caller actually holds. The property tests
//   for these predicates passed throughout EFB-67 v1, while v1 was broken on
//   real phones. This probe is the evidence those tests cannot be.
//
//   Three tickets have now hit this trap (EFB-67 v1, EFB-67 v2, EFB-77). It is
//   kept in-repo so the fourth one starts with a reproduction instead of a
//   debate.
//
// WHAT IT DOES
//
//   Drives real Chromium over CDP at a 393px iPhone viewport — the width EFB-67
//   v1 was measured on — and renders a kanban-ish row of columns twice: once
//   fitting the viewport, once wide enough to overflow it. It reports both
//   width reads in each case and which layout branch each would select.
//
//   The thresholds are parsed out of web/src/lib/layout.ts rather than copied,
//   so this cannot silently drift from the values the app actually ships.
//
// USAGE
//
//   node scripts/probes/innerwidth-probe.mjs        (or: npm run probe:innerwidth)
//   CHROME_PATH=/path/to/chrome node scripts/probes/innerwidth-probe.mjs
//
//   Exits 0 when the trap reproduces AND the fixed read stays correct; exits 1
//   otherwise. A non-zero exit means either Chromium changed this behavior
//   (good news, and layout.ts's warnings can be revisited) or the probe broke.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT_TS = resolve(HERE, "../../web/src/lib/layout.ts");

const CHROME =
  process.env["CHROME_PATH"] ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env["PROBE_CDP_PORT"] ?? 9333);
// The viewport EFB-67 v1 was measured on, and the width innerWidth lied about.
const DEVICE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
const CDP_READY_ATTEMPTS = 40;
const CDP_POLL_MS = 250;
const RENDER_SETTLE_MS = 600;

/** Read a threshold from layout.ts so the probe cannot drift from the app. */
const thresholdFrom = (source, name) => {
  const m = source.match(new RegExp(`export const ${name} = (\\d+)`));
  if (m === null) {
    throw new Error(
      `Could not find ${name} in ${LAYOUT_TS}. If it was renamed, update this probe — ` +
        `do not hardcode the value, that is the drift this parse exists to prevent.`,
    );
  }
  return Number(m[1]);
};

const page = (overflow, columnPx) => `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; }
  /* The temporary column min-width bump EFB-77's ticket calls for, made
     permanent here as a switch rather than an edit to real CSS. */
  .board { display: flex; }
  .col { min-width: ${overflow ? columnPx : 100}px; height: 200px; background: #ddd; margin: 4px; }
</style>
<div class="board"><div class="col"></div><div class="col"></div><div class="col"></div></div>
`;

const connect = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", () => fail(new Error("CDP socket failed")), { once: true });
  });
  let id = 0;
  return {
    ws,
    send: (method, params = {}, sessionId) => {
      const msgId = ++id;
      const reply = new Promise((ok) => {
        const onMsg = (e) => {
          const d = JSON.parse(e.data);
          if (d.id === msgId) {
            ws.removeEventListener("message", onMsg);
            ok(d);
          }
        };
        ws.addEventListener("message", onMsg);
      });
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
      return reply;
    },
  };
};

const main = async () => {
  const source = await readFile(LAYOUT_TS, "utf8");
  const AUTO_VERTICAL_MAX_PX = thresholdFrom(source, "AUTO_VERTICAL_MAX_PX");
  const FORCE_VERTICAL_MAX_PX = thresholdFrom(source, "FORCE_VERTICAL_MAX_PX");
  // Wide enough that three of them clear the widest threshold in play.
  const COLUMN_PX = AUTO_VERTICAL_MAX_PX;

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    `--user-data-dir=/tmp/innerwidth-probe-profile-${PORT}`,
  ]);
  chrome.on("error", (e) => {
    console.error(`[probe] could not launch Chrome at ${CHROME} — set CHROME_PATH. ${e.message}`);
  });

  try {
    let wsUrl = null;
    for (let i = 0; i < CDP_READY_ATTEMPTS && wsUrl === null; i++) {
      await sleep(CDP_POLL_MS);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
    }
    if (wsUrl === null) throw new Error("Chrome never exposed a CDP endpoint");

    const cdp = await connect(wsUrl);
    const { result: created } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { result: attached } = await cdp.send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    const session = attached.sessionId;

    const measure = async (overflow) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", DEVICE, session);
      await cdp.send(
        "Page.navigate",
        { url: `data:text/html,${encodeURIComponent(page(overflow, COLUMN_PX))}` },
        session,
      );
      await sleep(RENDER_SETTLE_MS);
      const { result } = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => ({
            innerWidth: window.innerWidth,
            clientWidth: document.documentElement.clientWidth,
            visualViewport: window.visualViewport ? Math.round(window.visualViewport.width) : null,
            overflowing: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          }))()`,
          returnByValue: true,
        },
        session,
      );
      return result.result.value;
    };

    // Mirrors effectiveKanbanLayout / resolveKanbanLayout, over parsed thresholds.
    const renderedLayout = (w) => (w < FORCE_VERTICAL_MAX_PX ? "vertical" : "columns");
    const defaultPref = (w) => (w < AUTO_VERTICAL_MAX_PX ? "vertical" : "columns");
    const describe = (m) => ({
      ...m,
      rendered_from_innerWidth: renderedLayout(m.innerWidth),
      rendered_from_clientWidth: renderedLayout(m.clientWidth),
      default_pref_from_innerWidth: defaultPref(m.innerWidth),
      default_pref_from_clientWidth: defaultPref(m.clientWidth),
    });

    const control = describe(await measure(false));
    const probe = describe(await measure(true));

    // The control is not ceremony: it is the evidence that this class of bug is
    // LATENT rather than firing. With nothing overflowing, the two reads agree
    // exactly, which is why a broken caller looks fine until the day it doesn't.
    const controlAgrees = control.innerWidth === control.clientWidth;
    const inflated = probe.innerWidth > probe.clientWidth;
    const fixedReadStaysTrue = probe.clientWidth === DEVICE.width;
    const branchDiverged =
      probe.rendered_from_innerWidth !== probe.rendered_from_clientWidth ||
      probe.default_pref_from_innerWidth !== probe.default_pref_from_clientWidth;

    console.log(
      "[probe] " +
        JSON.stringify(
          {
            device: `${DEVICE.width}x${DEVICE.height} mobile=${DEVICE.mobile}`,
            thresholds: { AUTO_VERTICAL_MAX_PX, FORCE_VERTICAL_MAX_PX, parsed_from: "web/src/lib/layout.ts" },
            control_no_overflow: control,
            probe_with_overflow: probe,
          },
          null,
          2,
        ),
    );

    const checks = {
      control_reads_agree_when_nothing_overflows: controlAgrees,
      page_actually_overflowed: probe.overflowing,
      innerWidth_inflated_under_overflow: inflated,
      clientWidth_stayed_true_viewport: fixedReadStaysTrue,
      layout_branch_diverged: branchDiverged,
    };
    console.log("[probe] " + JSON.stringify(checks));

    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    if (failed.length > 0) {
      console.error(`[probe] FAILED: ${failed.map(([k]) => k).join(", ")}`);
      console.error(
        "[probe] Either Chromium changed this behavior — in which case layout.ts's warnings " +
          "can be revisited — or this probe needs repair. Do not assume the trap is gone.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `[probe] OK — innerWidth reported ${probe.innerWidth} on a ${DEVICE.width}px viewport; ` +
        `clientWidth held ${probe.clientWidth}. Layout branch flipped ` +
        `${probe.rendered_from_clientWidth} → ${probe.rendered_from_innerWidth}. ` +
        `Use layoutViewportWidth().`,
    );
  } finally {
    chrome.kill();
  }
};

await main();
