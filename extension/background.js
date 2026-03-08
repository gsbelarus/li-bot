const DEFAULT_SETTINGS = {
  backendBaseUrl: "http://localhost:3000",
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    backendBaseUrl: (stored.backendBaseUrl || DEFAULT_SETTINGS.backendBaseUrl).replace(/\/$/, ""),
  };
}

async function getState() {
  const stored = await chrome.storage.local.get({
    monitoring: false,
    sessionId: null,
  });
  return stored;
}

async function setBadge(monitoring) {
  await chrome.action.setBadgeBackgroundColor({ color: monitoring ? "#0A66C2" : "#666666" });
  await chrome.action.setBadgeText({ text: monitoring ? "ON" : "" });
  await chrome.action.setTitle({
    title: monitoring ? "LinkedIn monitoring is on" : "LinkedIn monitoring is off",
  });
}

async function createSession(tabId) {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendBaseUrl}/api/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "chrome-extension",
      tabId,
      metadata: {
        userAgent: navigator.userAgent,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }

  return response.json();
}

async function stopSession(sessionId) {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendBaseUrl}/api/sessions/${sessionId}/stop`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endedAt: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to stop session: ${response.status}`);
  }

  return response.json();
}

async function sendMessageToTab(tabId, payload) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    console.warn("Could not reach content script for tab", tabId, error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  await setBadge(false);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  await setBadge(Boolean(state.monitoring));
});

chrome.action.onClicked.addListener(async (tab) => {
  const state = await getState();

  if (!state.monitoring) {
    const session = await createSession(tab.id);
    await chrome.storage.local.set({
      monitoring: true,
      sessionId: session._id,
    });
    await setBadge(true);
    await sendMessageToTab(tab.id, {
      type: "MONITORING_STARTED",
      sessionId: session._id,
    });
    return;
  }

  await sendMessageToTab(tab.id, {
    type: "MONITORING_STOP_REQUEST",
  });

  if (state.sessionId) {
    await stopSession(state.sessionId);
  }

  await chrome.storage.local.set({
    monitoring: false,
    sessionId: null,
  });
  await setBadge(false);
  await sendMessageToTab(tab.id, {
    type: "MONITORING_STOPPED",
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_MONITORING_STATE") {
    getState()
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "LOG_VISIT") {
    Promise.all([getSettings(), getState()])
      .then(async ([settings, state]) => {
        const response = await fetch(`${settings.backendBaseUrl}/api/visits`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...message.payload,
            sessionId: message.payload.sessionId || state.sessionId,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to log visit: ${response.status}`);
        }

        return response.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  return false;
});
