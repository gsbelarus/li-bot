#!/usr/bin/env node

/**
 * Programmatic OpenClaw browser automation via Node.js
 *
 * Prereqs:
 *   - OpenClaw gateway running
 *   - Chrome extension connected
 *   - Target LinkedIn tab attached
 *   - OPENCLAW_GATEWAY_TOKEN set if your gateway requires auth
 *
 * Run:
 *   node linkedin-my-network.js
 */

const { spawnSync } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");

const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || "chrome"; // chrome profile = extension relay
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const WINDOWS_SHELL = process.env.ComSpec || "cmd.exe";
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SESSION_SOURCE = "openclaw-script";
const MIN_SLEEP_MS = 1000;
const MAX_SLEEP_MS = 5000;
const BACKEND_RETRY_COUNT = 3;
const BACKEND_RETRY_DELAY_MS = 500;

function oc(args, { json = false } = {}) {
  const fullArgs = ["browser", "--browser-profile", BROWSER_PROFILE];

  if (GATEWAY_URL) {
    fullArgs.push("--url", GATEWAY_URL);
  }

  if (GATEWAY_TOKEN) {
    fullArgs.push("--token", GATEWAY_TOKEN);
  }

  fullArgs.push(...args);

  if (json) {
    fullArgs.push("--json");
  }

  const command = process.platform === "win32" ? WINDOWS_SHELL : OPENCLAW_BIN;
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", OPENCLAW_BIN, ...fullArgs]
    : fullArgs;

  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        `Could not launch OpenClaw CLI. Set OPENCLAW_BIN if the executable is not on PATH. Tried: ${OPENCLAW_BIN}`
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `OpenClaw exited with code ${result.status}.`);
  }

  const stdout = result.stdout || "";
  return json ? JSON.parse(stdout) : stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomSleepMs() {
  const min = Math.min(MIN_SLEEP_MS, MAX_SLEEP_MS);
  const max = Math.max(MIN_SLEEP_MS, MAX_SLEEP_MS);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitRandomDelay(targetId, telemetry) {
  const waitMs = getRandomSleepMs();
  await sleep(waitMs);

  try {
    oc(["wait", "--time", String(waitMs), "--target-id", targetId]);
    addAction(telemetry, `wait:time:${waitMs}`);
  } catch {
    // best effort
  }

  return waitMs;
}

function nowIso() {
  return new Date().toISOString();
}

function truncate(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function parseCliValue(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postJson(path, body, { method = "POST" } = {}) {
  const url = new URL(`${BACKEND_BASE_URL}${path}`);
  const payload = JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;
  let lastError = null;

  for (let attempt = 0; attempt < BACKEND_RETRY_COUNT; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const request = transport.request(
          url,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            let raw = "";

            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              raw += chunk;
            });
            response.on("end", () => {
              const statusCode = response.statusCode || 0;
              const responseText = raw.trim();

              if (statusCode < 200 || statusCode >= 300) {
                reject(
                  new Error(
                    `Backend request failed: ${method} ${path} -> ${statusCode} ${responseText}`.trim()
                  )
                );
                return;
              }

              if (!responseText) {
                resolve(null);
                return;
              }

              try {
                resolve(JSON.parse(responseText));
              } catch (error) {
                reject(error);
              }
            });
          }
        );

        request.on("error", reject);
        request.write(payload);
        request.end();
      });
    } catch (error) {
      lastError = error;
      if (attempt < BACKEND_RETRY_COUNT - 1) {
        await sleep(BACKEND_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function createSession(activeTab) {
  const userAgent = String(
    parseCliValue(
      oc(["evaluate", "--fn", "() => navigator.userAgent", "--target-id", activeTab.id])
    ) || ""
  );

  return postJson("/api/sessions", {
    source: SESSION_SOURCE,
    metadata: {
      browserProfile: BROWSER_PROFILE,
      gatewayUrl: GATEWAY_URL || null,
      initialUrl: activeTab.url,
      targetId: activeTab.id,
      userAgent,
    },
  });
}

async function stopSession(sessionId) {
  return postJson(
    `/api/sessions/${sessionId}/stop`,
    {
      endedAt: nowIso(),
    },
    { method: "PATCH" }
  );
}

async function logVisit(payload) {
  return postJson("/api/visits", payload);
}

function createTelemetryState(sessionId) {
  return {
    sessionId,
    currentVisit: null,
  };
}

function addAction(state, action) {
  if (!state.currentVisit) {
    return;
  }

  state.currentVisit.actions.push(action);
  if (state.currentVisit.actions.length > 100) {
    state.currentVisit.actions = state.currentVisit.actions.slice(-100);
  }
}

function addPostVisit(state, postVisit) {
  if (!state.currentVisit || !postVisit) {
    return;
  }

  state.currentVisit.postVisits.push(postVisit);
  if (state.currentVisit.postVisits.length > 50) {
    state.currentVisit.postVisits = state.currentVisit.postVisits.slice(-50);
  }
}

function getRefDetails(snapshotResult, ref) {
  return getOrderedRefs(snapshotResult).find((entry) => entry.ref === ref) || null;
}

function formatClickAction(refDetails, fallbackRef) {
  const role = truncate(refDetails?.role || "element", 24);
  const name = truncate(refDetails?.name || `ref:${fallbackRef}`, 80);
  return `click:${role}:${name}`;
}

function isPostMoreLabel(label) {
  const normalized = normalizeText(label);
  return (
    normalized === "more" ||
    normalized === "...more" ||
    normalized === "…more" ||
    normalized === "see more" ||
    normalized.startsWith("see more") ||
    normalized.includes("…more") ||
    normalized.includes("...more")
  );
}

function readPageValue(targetId, expression) {
  return parseCliValue(
    oc(["evaluate", "--fn", expression, "--target-id", targetId])
  );
}

function getPageState(targetId) {
  const rawState = readPageValue(
    targetId,
    "() => JSON.stringify({ url: location.href, title: document.title, scrollY: window.scrollY || 0 })"
  );

  const pageState = typeof rawState === "string" ? JSON.parse(rawState) : rawState;

  return {
    url: String(pageState?.url || ""),
    title: String(pageState?.title || ""),
    scrollY: Number(pageState?.scrollY || 0),
  };
}

function extractPostVisit(targetId, postIndex = 1) {
  const rawPostVisit = readPageValue(
    targetId,
    `() => {
      const containers = Array.from(document.querySelectorAll(
        'article, .feed-shared-update-v2, .occludable-update, .fie-impression-container, [data-urn]'
      ));
      const container = containers[Math.max(0, ${postIndex} - 1)] || containers[0] || null;

      if (!container) {
        return JSON.stringify(null);
      }

      const links = Array.from(container.querySelectorAll('a[href]'));
      const postLink = links.find((link) => {
        const href = link.href || '';
        return href.includes('/feed/update/') || href.includes('/posts/') || href.includes('/activity-');
      });

      const postUrn =
        container.getAttribute('data-urn') ||
        container.querySelector('[data-urn]')?.getAttribute('data-urn') ||
        null;

      const textPreview = (container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);

      if (!postLink && !postUrn && !textPreview) {
        return JSON.stringify(null);
      }

      return JSON.stringify({
        url: postLink?.href || null,
        postUrn,
        textPreview,
        clickedAt: new Date().toISOString(),
      });
    }`
  );

  const postVisit = typeof rawPostVisit === "string" ? JSON.parse(rawPostVisit) : rawPostVisit;
  return postVisit || null;
}

function extractPostVisitFromSnapshot(snapshotResult, postIndex, currentUrl) {
  const refs = getOrderedRefs(snapshotResult);
  const collected = [];
  let currentPost = 0;
  let insideTargetPost = false;

  for (const entry of refs) {
    const text = String(entry.name || "").replace(/\s+/g, " ").trim();
    const normalized = normalizeText(text);

    if (entry.role === "heading" && /^feed post number \d+$/.test(normalized)) {
      currentPost += 1;
      if (insideTargetPost && currentPost > postIndex) {
        break;
      }
      insideTargetPost = currentPost === postIndex;
      continue;
    }

    if (!insideTargetPost || !text) {
      continue;
    }

    if (
      entry.role === "button" ||
      /^view[: ]/.test(normalized) ||
      normalized.startsWith("view ") ||
      normalized.startsWith("follow ") ||
      normalized.startsWith("comment") ||
      normalized.startsWith("repost") ||
      normalized.startsWith("send") ||
      normalized.startsWith("react like") ||
      normalized.startsWith("open reactions menu") ||
      normalized.startsWith("activate to view larger image") ||
      normalized.startsWith("book an appointment") ||
      /^\d+ reactions?$/.test(normalized) ||
      /^\d+ comments?/.test(normalized)
    ) {
      continue;
    }

    if (!collected.includes(text)) {
      collected.push(text);
    }
  }

  const textPreview = collected.join(" ").slice(0, 280).trim();
  if (!textPreview) {
    return null;
  }

  return {
    url: currentUrl || null,
    postUrn: null,
    textPreview,
    clickedAt: nowIso(),
  };
}

function clickRef(targetId, ref, telemetry, snapshotResult) {
  return clickRefWithOptions(targetId, ref, telemetry, snapshotResult, {});
}

function clickRefWithOptions(targetId, ref, telemetry, snapshotResult, options = {}) {
  const refDetails = getRefDetails(snapshotResult, ref);
  addAction(telemetry, formatClickAction(refDetails, ref));

  if (isPostMoreLabel(refDetails?.name || "")) {
    try {
      const postVisit =
        extractPostVisitFromSnapshot(snapshotResult, options.postIndex || 1, options.currentUrl) ||
        extractPostVisit(targetId, options.postIndex || 1);
      addPostVisit(telemetry, postVisit);
    } catch {
      // best effort
    }
  }

  oc(["click", ref, "--target-id", targetId]);
  return refDetails;
}

function startVisit(state, pageState) {
  state.currentVisit = {
    sessionId: state.sessionId,
    url: pageState.url,
    title: pageState.title,
    startedAt: nowIso(),
    actions: [],
    postVisits: [],
    scrollCount: 0,
    maxScrollY: pageState.scrollY,
  };
}

async function finalizeVisit(state, targetId, overrides = {}) {
  if (!state.currentVisit) {
    return null;
  }

  const currentVisit = state.currentVisit;
  state.currentVisit = null;

  let pageState = null;
  try {
    pageState = getPageState(targetId);
  } catch {
    pageState = null;
  }

  const endedAt = new Date();
  const startedAt = new Date(currentVisit.startedAt);
  const payload = {
    ...currentVisit,
    url: overrides.url || pageState?.url || currentVisit.url,
    title: overrides.title || pageState?.title || currentVisit.title,
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    maxScrollY: Math.max(
      currentVisit.maxScrollY,
      Number(overrides.maxScrollY ?? pageState?.scrollY ?? 0) || 0
    ),
  };

  await logVisit(payload);
  return payload;
}

function getOrderedRefs(snapshotResult) {
  const refs = snapshotResult && typeof snapshotResult === "object" ? snapshotResult.refs : null;
  if (!refs || typeof refs !== "object") {
    return [];
  }

  return Object.entries(refs).map(([ref, meta]) => ({
    ref,
    role: String(meta.role || "").toLowerCase(),
    name: String(meta.name || ""),
  }));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findFirstRefByText(snapshotResult, matcher) {
  for (const entry of getOrderedRefs(snapshotResult)) {
    const text = normalizeText(entry.name);
    if (!text) continue;
    if (matcher(text, entry)) {
      return entry.ref;
    }
  }
  return null;
}

function isLinkedInUrl(url) {
  return String(url || "").toLowerCase().includes("linkedin.com");
}

function isLinkedInProfileUrl(url) {
  return /^https:\/\/www\.linkedin\.com\/in\/[^/?#]+/.test(String(url || ""));
}

async function waitForPageState(targetId, predicate = () => true, options = {}) {
  const attempts = options.attempts || 6;
  const delayMs = options.delayMs;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const pageState = getPageState(targetId);
      if (predicate(pageState)) {
        return pageState;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      await sleep(typeof delayMs === "number" ? delayMs : getRandomSleepMs());
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error("Timed out waiting for the attached tab to reach the expected page state.");
}

function findFirstRefAfterSection(snapshotResult, sectionMatcher, candidateMatcher) {
  const refs = getOrderedRefs(snapshotResult);
  let inSection = false;

  for (const entry of refs) {
    const text = normalizeText(entry.name);

    if (!inSection) {
      if (entry.role === "heading" && text && sectionMatcher(text, entry)) {
        inSection = true;
      }
      continue;
    }

    if (entry.role === "heading" && text && !sectionMatcher(text, entry)) {
      break;
    }

    if (candidateMatcher(text, entry)) {
      return entry.ref;
    }
  }

  return null;
}

function findFirstCardAfterSection(snapshotResult) {
  const inPopularSection = findFirstRefAfterSection(
    snapshotResult,
    (text) => text.includes("popular on linkedin"),
    (text, entry) => {
      if (entry.role !== "link") {
        return false;
      }

      if (!text || text.includes("show all suggestions")) {
        return false;
      }

      return /verified|founder|ceo|co-owner|manager|director|journalist|lawyer|ambassador|followers|company/.test(text);
    }
  );

  if (inPopularSection) {
    return inPopularSection;
  }

  return findFirstRefByText(snapshotResult, (text, entry) => {
    if (entry.role !== "link") {
      return false;
    }

    if (!text || text.includes("show all") || text.includes("linkedin") || text.includes("saved items")) {
      return false;
    }

    return /verified|followers|ceo|founder|manager|director|journalist|lawyer|ambassador/.test(text);
  });
}

function findNthPostMoreRef(snapshotResult, postIndex) {
  const snapshotText = String(snapshotResult?.snapshot || "");
  if (!snapshotText) {
    return null;
  }

  const escapedPostIndex = String(postIndex).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startPattern = new RegExp(`heading "Feed post number ${escapedPostIndex}"`, "i");
  const nextPattern = /heading "Feed post number \d+"/i;
  const lines = snapshotText.split("\n");

  let startIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (nextPattern.test(line)) {
      break;
    }

    if (!/button /i.test(line) || !/ref=([A-Za-z0-9]+)/.test(line)) {
      continue;
    }

    const match = line.match(/button "([^"]+)".*\[ref=([^\]]+)\]/i);
    if (!match) {
      continue;
    }

    const [, buttonName, ref] = match;
    if (isPostMoreLabel(buttonName)) {
      return ref;
    }
  }

  return null;
}

function findShowAllPostsRef(snapshotResult) {
  return findFirstRefByText(snapshotResult, (text, entry) => {
    if (entry.role !== "link" && entry.role !== "button") {
      return false;
    }

    return text.includes("show all posts") || /^show all \d+ posts?$/.test(text);
  });
}

function buildRecentActivityUrl(profileUrl) {
  const currentUrl = new URL(String(profileUrl || ""));
  currentUrl.search = "";
  currentUrl.hash = "";
  currentUrl.pathname = `${currentUrl.pathname.replace(/\/+$/, "")}/recent-activity/all/`;
  return currentUrl.toString();
}

function clickShowAllPosts(targetId, telemetry, snapshotResult, profileUrl) {
  const showAllPostsRef = findShowAllPostsRef(snapshotResult);
  if (showAllPostsRef) {
    clickRef(targetId, showAllPostsRef, telemetry, snapshotResult);
    return showAllPostsRef;
  }

  const activityUrl = buildRecentActivityUrl(profileUrl);
  addAction(telemetry, "click:link:Show all posts");
  addAction(telemetry, `navigate:page:${truncate(activityUrl, 80)}`);
  oc(["navigate", activityUrl, "--target-id", targetId]);
  return activityUrl;
}

function scrollRefIntoView(targetId, ref, telemetry, snapshotResult, description) {
  const refDetails = getRefDetails(snapshotResult, ref);
  oc(["scrollintoview", ref, "--target-id", targetId]);
  addAction(
    telemetry,
    `scrollintoview:${truncate(description || refDetails?.name || `ref:${ref}`, 80)}`
  );
}

function getFocusedTab() {
  // `browser tabs --json` is documented; use it to discover/focus targets.
  const tabs = oc(["tabs"], { json: true });
  const list = Array.isArray(tabs) ? tabs : tabs.tabs || tabs.items || [];

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `No tabs were returned for browser profile \"${BROWSER_PROFILE}\". Open Chrome with the Browser Relay extension attached before running this script.`
    );
  }

  const active =
    list.find((t) => (t.focused || t.active || t.selected) && isLinkedInUrl(t.url)) ||
    list.find((t) => isLinkedInUrl(t.url));

  if (!active) {
    throw new Error(
      `No attached LinkedIn tab was found in browser profile \"${BROWSER_PROFILE}\". The script only uses an existing Browser Relay tab and will not open a new browser.`
    );
  }

  const id = active.targetId || active.id;
  if (!id) {
    throw new Error("Could not determine targetId from browser tabs output.");
  }
  return {
    id: String(id),
    url: String(active.url || ""),
    title: String(active.title || ""),
  };
}

async function main() {
  const activeTab = getFocusedTab();
  const targetId = activeTab.id;
  const session = await createSession(activeTab);
  const telemetry = createTelemetryState(session._id);

  console.log(`Using attached ${BROWSER_PROFILE} relay tab: ${activeTab.title || activeTab.url}`);
  console.log(`Using targetId: ${targetId}`);
  console.log(`Created backend session: ${session._id}`);

  try {
    startVisit(telemetry, {
      url: activeTab.url,
      title: activeTab.title,
      scrollY: 0,
    });
    addAction(telemetry, `attach:relay-tab:${truncate(targetId, 64)}`);
    addAction(telemetry, `page:view:${truncate(activeTab.url, 80)}`);

    if (!activeTab.url.toLowerCase().includes("linkedin.com/mynetwork")) {
      console.log("Navigating attached tab to LinkedIn My Network");
      addAction(telemetry, "navigate:page:https://www.linkedin.com/mynetwork/");
      oc(["navigate", "https://www.linkedin.com/mynetwork/", "--target-id", targetId]);
      const myNetworkWaitMs = getRandomSleepMs();

      // 3. Wait at least 5 sec
      await sleep(myNetworkWaitMs);
      try {
        oc(["wait", "--time", String(myNetworkWaitMs), "--target-id", targetId]);
        addAction(telemetry, `wait:time:${myNetworkWaitMs}`);
      } catch {
        // best effort
      }

      const myNetworkPageState = await waitForPageState(
        targetId,
        (pageState) => pageState.url.toLowerCase().includes("linkedin.com/mynetwork")
      );

      await finalizeVisit(telemetry, targetId, {
        url: "https://www.linkedin.com/mynetwork/",
      });

      startVisit(telemetry, myNetworkPageState);
      addAction(telemetry, "page:view:https://www.linkedin.com/mynetwork/");
    }

    // 4. Read the page again
    const snap2 = oc(["snapshot", "--target-id", targetId], { json: true });
    addAction(telemetry, "snapshot:page:mynetwork");

    // 5-7. Find "Popular on LinkedIn" and click first likely card in that section
    const firstCardRef = findFirstCardAfterSection(snap2);
    if (!firstCardRef) {
      throw new Error(
        'Could not find a clickable first card after the "Popular on LinkedIn" section. Inspect the snapshot and tighten the selector heuristic.'
      );
    }

    const firstCard = getRefDetails(snap2, firstCardRef);
    console.log(`Clicking first card ref=${firstCardRef}`);
    clickRef(targetId, firstCardRef, telemetry, snap2);
    const profileOpenWaitMs = getRandomSleepMs();

    // 8. Wait at least 5 sec
    await sleep(profileOpenWaitMs);
    try {
      oc(["wait", "--time", String(profileOpenWaitMs), "--target-id", targetId]);
      addAction(telemetry, `wait:time:${profileOpenWaitMs}`);
    } catch {
      // best effort
    }

    const finalPageState = await waitForPageState(
      targetId,
      (pageState) => isLinkedInProfileUrl(pageState.url),
      { attempts: 8 }
    );
    await finalizeVisit(telemetry, targetId, finalPageState);

    startVisit(telemetry, finalPageState);
    addAction(telemetry, `page:view:${truncate(finalPageState.url, 80)}`);
    addAction(telemetry, "automation:profile-opened");

    const profileSnapshot = oc(["snapshot", "--target-id", targetId], { json: true });
    addAction(telemetry, "snapshot:page:profile");
    clickShowAllPosts(targetId, telemetry, profileSnapshot, finalPageState.url);
    await waitRandomDelay(targetId, telemetry);

    const activityPageState = await waitForPageState(
      targetId,
      (pageState) => pageState.url.toLowerCase().includes("/recent-activity/all")
    );

    await finalizeVisit(telemetry, targetId, activityPageState);
    startVisit(telemetry, activityPageState);
    addAction(telemetry, `page:view:${truncate(activityPageState.url, 80)}`);

    const activitySnapshot = oc(["snapshot", "--target-id", targetId], { json: true });
    addAction(telemetry, "snapshot:page:activity");

    const thirdPostMoreRef = findNthPostMoreRef(activitySnapshot, 3);
    if (!thirdPostMoreRef) {
      throw new Error('Could not find the "more" control for the third post in Activity.');
    }

    scrollRefIntoView(targetId, thirdPostMoreRef, telemetry, activitySnapshot, "third-post");
    clickRefWithOptions(targetId, thirdPostMoreRef, telemetry, activitySnapshot, {
      postIndex: 3,
      currentUrl: activityPageState.url,
    });

    // 9. Get page URL
    const currentUrl = activityPageState.url;

    console.log(`Final URL: ${JSON.stringify(currentUrl)}`);
    await finalizeVisit(telemetry, targetId, activityPageState);
  } finally {
    try {
      await finalizeVisit(telemetry, targetId);
    } finally {
      await stopSession(session._id);
    }
  }
}

main().catch((err) => {
  console.error("\nERROR:", err.message);
  process.exit(1);
});