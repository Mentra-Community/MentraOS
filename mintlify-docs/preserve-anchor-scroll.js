(() => {
  const stabilizationDurationMs = 2000;
  const retryIntervalMs = 200;
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
    let intervalId;
    let timeoutId;

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
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
      if (cancelled) return;

      if (window.location.hash !== expectedHash) {
        cancel();
        return;
      }

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

    restoreAnchor();
    intervalId = window.setInterval(
      () => window.requestAnimationFrame(restoreAnchor),
      retryIntervalMs,
    );
    timeoutId = window.setTimeout(cancel, stabilizationDurationMs);
  }

  window.addEventListener("hashchange", preserveCurrentAnchor);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", preserveCurrentAnchor, {
      once: true,
    });
  } else {
    preserveCurrentAnchor();
  }
})();
