// attachParallax — subtle scroll parallax for card cover images.
//
// IntersectionObserver gates the work: the scroll listener only computes
// while the card is on screen, and each scroll tick coalesces through
// requestAnimationFrame. Formula: the card's offset from the viewport
// center, normalized by viewport height, drives a translate3d of up to
// ±15px (ratio * -30) — visible but quiet. Respects
// prefers-reduced-motion by attaching nothing at all.

const PARALLAX_RANGE_PX = -30;

export const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Attach the effect; returns a cleanup function for card unmount.
 * Only call for cards that actually have a cover image.
 */
export const attachParallax = (el: HTMLElement, imageEl: HTMLImageElement): (() => void) => {
  // No observer (ancient browser / test env without a stub) → no effect.
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
    return () => undefined;
  }

  let visible = false;
  let frame: number | null = null;

  const apply = () => {
    frame = null;
    const rect = el.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 1;
    const ratio = (rect.top - viewportHeight / 2) / viewportHeight;
    imageEl.style.transform = `translate3d(0, ${(ratio * PARALLAX_RANGE_PX).toFixed(1)}px, 0)`;
  };

  const onScroll = () => {
    if (!visible || frame !== null) return;
    frame = requestAnimationFrame(apply);
  };

  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) onScroll();
  });
  observer.observe(el);
  window.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    observer.disconnect();
    window.removeEventListener("scroll", onScroll);
    if (frame !== null) cancelAnimationFrame(frame);
  };
};
