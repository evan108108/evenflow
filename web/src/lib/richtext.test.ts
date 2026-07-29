// Phase 18a lib tests: the markdown pipeline (GFM, sanitization,
// [[SHORT-ID]] linkification, code-fence segmentation) and the parallax
// attach/detach lifecycle.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown-bundle";
import { renderPlain } from "./markdown";
import { segmentHtml } from "../components/MarkdownView";
import { attachParallax } from "./parallax";

describe("renderMarkdown", () => {
  it("renders GFM: headings, task lists, strikethrough, tables", () => {
    const html = renderMarkdown(
      "## Acceptance\n- [x] Done\n- [ ] Todo\n\n~~gone~~\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    );
    expect(html).toContain("<h2>Acceptance</h2>");
    expect(html).toContain('type="checkbox"');
    expect(html.match(/checkbox/g)!.length).toBe(2);
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("links [[SHORT-ID]] tokens to /i/ short-links", () => {
    const html = renderMarkdown("See [[EFB-1]] and [[FLOW-42]], but not [[lowercase-1]].");
    expect(html).toContain('<a class="issue-ref" href="/i/EFB-1">EFB-1</a>');
    expect(html).toContain('<a class="issue-ref" href="/i/FLOW-42">FLOW-42</a>');
    expect(html).not.toContain("/i/lowercase-1");
  });

  it("sanitizes scripts, event handlers, and javascript: hrefs", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="https://x/y.png" onerror="alert(1)">\n\n[click](javascript:alert(1))',
    );
    // Assert on the parsed DOM — raw HTML may survive as escaped TEXT, but
    // never as live elements/attributes.
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img[onerror]")).toBeNull();
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors.some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
  });

  it("keeps the language class on fenced code for the highlighter", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain("const x = 1;");
  });

  it("renderPlain escapes markup and marks the pre-wrap paragraph", () => {
    const html = renderPlain("a < b & c\nnext line <script>");
    expect(html).toBe('<p class="plain-body">a &lt; b &amp; c\nnext line &lt;script&gt;</p>');
  });
});

describe("segmentHtml", () => {
  it("lifts fences (with unescaped code) out of the surrounding html runs", () => {
    const html = renderMarkdown('before\n\n```ts\nconst s = "<a>&amp;";\n```\n\nafter');
    const segments = segmentHtml(html);
    expect(segments.map((s) => s.kind)).toEqual(["html", "code", "html"]);
    const code = segments[1] as { code: string; lang: string | null };
    expect(code.lang).toBe("ts");
    expect(code.code).toBe('const s = "<a>&amp;";');
    expect((segments[0] as { html: string }).html).toContain("before");
    expect((segments[2] as { html: string }).html).toContain("after");
  });

  it("keeps no-language fences as plain code segments", () => {
    const segments = segmentHtml(renderMarkdown("```\nraw text\n```"));
    expect(segments).toEqual([{ kind: "code", code: "raw text", lang: null }]);
  });
});

describe("attachParallax", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stubMotion = (reduce: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduce })),
    );

  it("transforms the image from scroll position while visible, and detaches clean", () => {
    stubMotion(false);
    let intersectionCallback: (entries: Array<{ isIntersecting: boolean }>) => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn((cb: typeof intersectionCallback) => {
        intersectionCallback = cb;
        return { observe: vi.fn(), disconnect };
      }),
    );
    // Real rAF is async; the queue keeps that ordering property.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
    const flushFrames = () => {
      while (frames.length > 0) frames.shift()!(0);
    };
    vi.stubGlobal("innerHeight", 1000);

    const card = document.createElement("div");
    card.getBoundingClientRect = () => ({ top: 800 } as DOMRect); // below center
    const img = document.createElement("img");

    const detach = attachParallax(card, img);
    intersectionCallback([{ isIntersecting: true }]);
    flushFrames();
    // (800 - 500) / 1000 * -30 = -9px
    expect(img.style.transform).toBe("translate3d(0, -9.0px, 0)");

    card.getBoundingClientRect = () => ({ top: 200 } as DOMRect); // above center
    window.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(img.style.transform).toBe("translate3d(0, 9.0px, 0)");

    detach();
    expect(disconnect).toHaveBeenCalled();
    card.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    window.dispatchEvent(new Event("scroll"));
    expect(img.style.transform).toBe("translate3d(0, 9.0px, 0)"); // unchanged after detach
  });

  it("does nothing under prefers-reduced-motion", () => {
    stubMotion(true);
    const observed = vi.fn();
    vi.stubGlobal("IntersectionObserver", vi.fn(() => ({ observe: observed, disconnect: vi.fn() })));
    const img = document.createElement("img");
    const detach = attachParallax(document.createElement("div"), img);
    expect(observed).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("scroll"));
    expect(img.style.transform).toBe("");
    detach();
  });
});
