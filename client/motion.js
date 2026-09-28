/*
 * Motion layer for Solhustle — smooth scrolling, scroll reveals, marquee ticker
 * and the sticky-nav scroll state.
 *
 * The feel is borrowed from the Framer/Lenis reference site the landing page is
 * modelled on, but everything here is hand-rolled and dependency-free so the app
 * keeps its no-build-step frontend. Every effect is opt-in per element and the
 * whole module no-ops under `prefers-reduced-motion: reduce`.
 *
 *   <html data-smooth-scroll>   enable wheel-driven smooth scrolling
 *   [data-reveal]               fade + rise into view once, on first intersect
 *   [data-reveal-delay="120"]   stagger, in milliseconds
 *   [data-scale]                subtle scroll-linked scale (0.94 → 1)
 *   [data-marquee]              duplicate .marquee-track children for a seamless loop
 *   [data-native-scroll]        opt an inner scroller out of the wheel hijack
 */
(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;

  // ---------------------------------------------------------------------------
  // Smooth scrolling. Only on pointer devices: on touch the OS already has
  // momentum and hijacking wheel events there does nothing but break scrolling.
  //
  // The wheel listener calls preventDefault(), which hands us full control of
  // scrolling — so it must never do that unless the animation loop is provably
  // running. `requestAnimationFrame` stops entirely in a backgrounded or
  // occluded tab, and if we had already swallowed the wheel the page would be
  // left with no way to scroll at all. So:
  //
  //   `healthy` is only ever set from inside a frame that actually executed,
  //   and is cleared again by the stall watchdog, which then re-primes. Until a
  //   frame has run we simply do not touch the event and the browser scrolls
  //   natively.
  // ---------------------------------------------------------------------------
  function initSmoothScroll() {
    if (reduce || !root.hasAttribute("data-smooth-scroll")) return;
    if (window.matchMedia && !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    var target = window.scrollY;
    var current = window.scrollY;
    var frame = 0;
    var animating = false;
    var healthy = false;
    var framedAt = 0;

    // Deliberately well above a frame (~16ms) so it can never trip on a busy
    // main thread, but short enough that a throttled tab recovers in one wheel.
    var STALL_MS = 350;

    function maxScroll() {
      return Math.max(0, root.scrollHeight - window.innerHeight);
    }
    function clamp(v) {
      return Math.min(Math.max(v, 0), maxScroll());
    }
    function prime() {
      // A frame that runs sets `healthy`; one that never runs leaves us on the
      // native scroll path, which is the safe default.
      requestAnimationFrame(function () {
        healthy = true;
        framedAt = performance.now();
      });
    }
    function drop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      animating = false;
      healthy = false;
    }
    function step() {
      frame = 0;
      healthy = true;
      framedAt = performance.now();

      current += (target - current) * 0.14;
      if (Math.abs(target - current) < 0.4) {
        current = target;
        animating = false;
      }
      window.scrollTo(0, current);
      if (animating) frame = requestAnimationFrame(step);
    }
    function start() {
      if (!animating) {
        animating = true;
        current = window.scrollY;
      }
      if (frame === 0) frame = requestAnimationFrame(step);
    }
    function stalled() {
      return animating && performance.now() - framedAt > STALL_MS;
    }

    prime();

    window.addEventListener(
      "wheel",
      function (e) {
        // Let pinch-zoom, already-handled events and inner scrollers through.
        if (e.ctrlKey || e.metaKey || e.defaultPrevented) return;
        if (e.target && e.target.closest && e.target.closest("[data-native-scroll]")) return;

        // The loop has stopped under us: give the browser this scroll back and
        // re-prime, so a throttled tab can never trap the user.
        if (healthy && stalled()) {
          drop();
          prime();
        }
        if (!healthy) return;

        e.preventDefault();
        target = clamp(target + e.deltaY);
        start();
      },
      { passive: false },
    );

    // Anything we did not move (keyboard, scrollbar drag, find-in-page, anchor
    // jumps the browser handled itself) becomes the new baseline.
    window.addEventListener(
      "scroll",
      function () {
        if (animating) return;
        target = current = window.scrollY;
      },
      { passive: true },
    );

    window.addEventListener("resize", function () {
      drop();
      prime();
      target = current = clamp(window.scrollY);
    });

    // Hiding a tab suspends rAF, so never resume with a stale `animating` flag.
    document.addEventListener("visibilitychange", function () {
      drop();
      prime();
      target = current = clamp(window.scrollY);
    });

    // In-page anchors glide instead of teleporting.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var hash = a.getAttribute("href");
      if (!hash || hash.length < 2) return;
      var el = document.querySelector(hash);
      if (!el) return;
      e.preventDefault();
      target = clamp(el.getBoundingClientRect().top + window.scrollY - 72);
      current = window.scrollY;
      start();
    });
  }

  // ---------------------------------------------------------------------------
  // Reveals. The hidden state lives in CSS behind `html.js-motion`, so if this
  // file never runs the content simply stays visible.
  // ---------------------------------------------------------------------------
  function initReveals() {
    // `refresh()` re-runs this after a view swap, so skip anything already bound.
    var els = Array.prototype.slice
      .call(document.querySelectorAll("[data-reveal]"))
      .filter(function (el) {
        if (el.getAttribute("data-reveal-bound") === "1") return false;
        el.setAttribute("data-reveal-bound", "1");
        return true;
      });
    if (!els.length) return;

    function show(el) {
      var d = parseInt(el.getAttribute("data-reveal-delay") || "0", 10);
      if (d) el.style.transitionDelay = d + "ms";
      el.classList.add("is-in");
    }

    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(show);
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          show(entry.target);
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
    );

    els.forEach(function (el) {
      io.observe(el);
    });

    // Belt and braces for the load case: the observer fires for anything already
    // on screen, but a timer guarantees the hero is never left hidden if the
    // observer is slow or rAF is throttled.
    setTimeout(function () {
      els.forEach(function (el) {
        if (el.getBoundingClientRect().top < window.innerHeight) show(el);
      });
    }, 120);

    // Last resort. IntersectionObserver notifications ride on rendering frames, so
    // a window that is not being painted (an occluded or backgrounded pane)
    // delivers none — and because the hidden state lives in CSS behind
    // `js-motion`, everything below the fold would then stay invisible for good.
    // This pass is the same test the observer makes, run from the scroll event
    // instead: one bounding-box read per still-hidden element per tick, and it
    // retires itself as soon as the last one has been shown.
    var pending = els.slice();
    var onScroll = function () {
      pending = pending.filter(function (el) {
        if (el.getBoundingClientRect().top >= window.innerHeight) return true;
        show(el);
        io.unobserve(el);
        return false;
      });
      if (!pending.length) window.removeEventListener("scroll", onScroll);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Scroll-linked scale, the reference site's stacked-card trick: an element
  // settles from 0.94 to 1 as it travels up the viewport.
  // ---------------------------------------------------------------------------
  function initScrollScale() {
    var els = Array.prototype.slice
      .call(document.querySelectorAll("[data-scale]"))
      .filter(function (el) {
        if (el.getAttribute("data-scale-bound") === "1") return false;
        el.setAttribute("data-scale-bound", "1");
        return true;
      });
    if (!els.length || reduce) return;

    var ticking = false;
    function apply() {
      ticking = false;
      var vh = window.innerHeight;
      els.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var p = (vh - r.top) / (vh + r.height);
        p = Math.min(Math.max(p, 0), 1);
        el.style.transform = "scale(" + (0.94 + 0.06 * p).toFixed(4) + ")";
      });
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    apply();
  }

  // ---------------------------------------------------------------------------
  // Marquee. Duplicating the track once lets a single -50% keyframe loop
  // seamlessly, whatever the content width happens to be.
  // ---------------------------------------------------------------------------
  function initMarquees() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-marquee]"), function (m) {
      var track = m.querySelector(".marquee-track");
      if (!track || track.getAttribute("data-cloned") === "1") return;
      track.setAttribute("data-cloned", "1");
      track.innerHTML += track.innerHTML;
    });
  }

  // ---------------------------------------------------------------------------
  // Sticky nav picks up a shadow once the page has moved.
  // ---------------------------------------------------------------------------
  function initNavState() {
    var nav = document.querySelector("header.app-nav");
    if (!nav) return;
    function sync() {
      nav.classList.toggle("is-scrolled", window.scrollY > 8);
    }
    sync();
    window.addEventListener("scroll", sync, { passive: true });
  }

  function boot() {
    initMarquees();
    initNavState();
    initReveals();
    initScrollScale();
    initSmoothScroll();
  }

  /**
   * Single-page screens (the app shell, the auth pages) swap their DOM after
   * load, so they need to re-arm the reveal/scale observers for new elements.
   */
  window.SolhustleMotion = {
    refresh: function () {
      initMarquees();
      initReveals();
      initScrollScale();
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
