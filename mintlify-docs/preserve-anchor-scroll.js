(() => {
  const retryDelaysMs = [0, 100, 300, 700, 1200, 2000];
  const userEvents = ["wheel", "touchstart", "pointerdown", "keydown"];

  let cancelCurrentAttempt = () => {};

  function preserveCurrentAnchor() {
    cancelCurrentAttempt();

    const expectedHash = window.location.hash;
    if (!expectedHash || expectedHash === "#") return;

    let anchorId;
    try {
      anchorId = decodeURIComponent(expectedHash.slice(1));
    } catch {
      anchorId = expectedHash.slice(1);
    }

    let cancelled = false;
    const timers = [];

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach(window.clearTimeout);
      userEvents.forEach((eventName) =>
        window.removeEventListener(eventName, cancel, true),
      );
    };

    cancelCurrentAttempt = cancel;
    userEvents.forEach((eventName) =>
      window.addEventListener(eventName, cancel, {
        capture: true,
        passive: true,
      }),
    );

    const restoreAnchor = () => {
      if (cancelled || window.location.hash !== expectedHash) return;

      const target = document.getElementById(anchorId);
      if (!target) return;

      const scrollMarginTop = Number.parseFloat(
        window.getComputedStyle(target).scrollMarginTop,
      );
      const expectedTop = Number.isFinite(scrollMarginTop) ? scrollMarginTop : 0;

      if (Math.abs(target.getBoundingClientRect().top - expectedTop) > 4) {
        target.scrollIntoView({block: "start"});
      }
    };

    retryDelaysMs.forEach((delayMs) => {
      timers.push(
        window.setTimeout(
          () => window.requestAnimationFrame(restoreAnchor),
          delayMs,
        ),
      );
    });
    timers.push(
      window.setTimeout(cancel, retryDelaysMs[retryDelaysMs.length - 1] + 100),
    );
  }

  window.addEventListener("hashchange", preserveCurrentAnchor);
  window.addEventListener("pageshow", preserveCurrentAnchor);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", preserveCurrentAnchor, {
      once: true,
    });
  } else {
    preserveCurrentAnchor();
  }
})();
