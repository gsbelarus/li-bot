(function () {
  const state = {
    monitoring: false,
    sessionId: null,
    currentUrl: location.href,
    currentVisit: null,
  };

  function isLinkedInProfileUrl(url) {
    return /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/.test(url);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function startVisit(url) {
    if (!state.monitoring || !isLinkedInProfileUrl(url)) {
      return;
    }

    state.currentVisit = {
      sessionId: state.sessionId,
      url,
      title: document.title,
      startedAt: nowIso(),
      actions: [],
      scrollCount: 0,
      maxScrollY: window.scrollY || 0,
    };
  }

  function finalizeVisit() {
    if (!state.currentVisit) {
      return;
    }

    const endedAt = new Date();
    const startedAt = new Date(state.currentVisit.startedAt);
    const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

    const payload = {
      ...state.currentVisit,
      endedAt: endedAt.toISOString(),
      durationMs,
      title: document.title,
      maxScrollY: Math.max(state.currentVisit.maxScrollY, window.scrollY || 0),
    };

    chrome.runtime.sendMessage(
      {
        type: "LOG_VISIT",
        payload,
      },
      () => chrome.runtime.lastError
    );

    state.currentVisit = null;
  }

  function handleUrlChange() {
    if (location.href === state.currentUrl) {
      return;
    }

    finalizeVisit();
    state.currentUrl = location.href;
    startVisit(state.currentUrl);
  }

  function addAction(action) {
    if (!state.currentVisit) {
      return;
    }

    state.currentVisit.actions.push(action);
    if (state.currentVisit.actions.length > 100) {
      state.currentVisit.actions = state.currentVisit.actions.slice(-100);
    }
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!state.currentVisit) {
        return;
      }

      state.currentVisit.scrollCount += 1;
      state.currentVisit.maxScrollY = Math.max(state.currentVisit.maxScrollY, window.scrollY || 0);
    },
    { passive: true }
  );

  document.addEventListener(
    "click",
    (event) => {
      if (!state.currentVisit) {
        return;
      }

      const target = event.target instanceof Element ? event.target.closest("a, button, input, textarea") : null;

      if (!target) {
        return;
      }

      const tag = target.tagName.toLowerCase();
      const label =
        target.innerText?.trim() ||
        target.getAttribute("aria-label") ||
        target.getAttribute("name") ||
        target.getAttribute("href") ||
        "unlabeled";

      addAction(`click:${tag}:${label.slice(0, 80)}`);
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MONITORING_STARTED") {
      state.monitoring = true;
      state.sessionId = message.sessionId || null;
      state.currentUrl = location.href;
      finalizeVisit();
      startVisit(state.currentUrl);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "MONITORING_STOP_REQUEST") {
      finalizeVisit();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "MONITORING_STOPPED") {
      state.monitoring = false;
      state.sessionId = null;
      state.currentVisit = null;
      sendResponse({ ok: true });
    }
  });

  setInterval(handleUrlChange, 1000);

  window.addEventListener("beforeunload", () => {
    finalizeVisit();
  });

  chrome.runtime.sendMessage({ type: "GET_MONITORING_STATE" }, (response) => {
    if (chrome.runtime.lastError || !response || response.error) {
      return;
    }

    state.monitoring = Boolean(response.monitoring);
    state.sessionId = response.sessionId || null;

    if (state.monitoring) {
      startVisit(location.href);
    }
  });
})();
