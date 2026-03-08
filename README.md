# LinkedIn Visit Logger

This repository contains:

- a Chrome Manifest V3 extension that can monitor your own LinkedIn profile browsing session after you click the toolbar button
- a Node.js backend server that stores session and visit data in MongoDB Atlas

The implementation intentionally does **not** automate LinkedIn browsing, random dwell time, or profile traversal. It logs real user-driven activity on LinkedIn pages so you can review visit history safely.

## Project structure

```text
.
|-- extension/
|-- server/
`-- README.md
```

## What gets stored

The backend uses the MongoDB database named `linkedin` and creates these collections:

- `extensionsessions`
- `visits`

Each visit record includes:

- visited URL
- visit start time
- visit end time
- time spent on page in milliseconds
- actions taken
- scroll metrics

## 1. Backend setup

### Requirements

- Node.js 20+ recommended
- npm
- network access to MongoDB Atlas

### Install dependencies

```bash
cd server
npm install
```

### Configure environment

Copy the example file and keep the provided MongoDB connection string:

```bash
cp .env.example .env
```

If you are on PowerShell:

```powershell
Copy-Item .env.example .env
```

The default `.env.example` already includes:

- `MONGODB_URI=mongodb+srv://bot-user:bot-user-5254@andersenrnd.6gyafbr.mongodb.net/?appName=AndersenRND`
- `MONGODB_DB=linkedin`
- `PORT=3000`
- `CORS_ORIGIN=*`

### Start the server

Development:

```bash
npm run dev
```

Production-style:

```bash
npm start
```

### Verify the backend

Open:

- [http://localhost:3000/api/health](http://localhost:3000/api/health)

You should see a JSON response showing the API is up.

## 2. Extension installation

### Load the unpacked extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the [extension](C:/Users/gs199/Documents/Playground/extension) folder.
6. Open the extension details page and then `Extension options`.

### Configure the backend URL

In the options page, set:

- `Backend base URL`: `http://localhost:3000`

Save the settings.

## 3. How to use the extension

### Start monitoring

1. Log in to LinkedIn in Chrome.
2. Open LinkedIn in the active tab.
3. Click the extension toolbar button once.
4. The extension badge changes to `ON`.

This starts a backend session and enables logging for LinkedIn tabs.

### Browse normally

While monitoring is enabled, the extension watches your actual LinkedIn navigation and records:

- profile page URL changes
- time spent on each profile page
- scroll count and max scroll position
- click actions on buttons, links, and form controls

### Stop monitoring

1. Click the toolbar button again.
2. The badge clears and the current visit is finalized.

The extension then closes the backend session.

## 4. Backend API

### `GET /api/health`

Health check.

### `POST /api/sessions`

Creates a monitoring session.

Example body:

```json
{
  "source": "chrome-extension",
  "tabId": 123
}
```

### `PATCH /api/sessions/:sessionId/stop`

Stops an existing session.

### `POST /api/visits`

Stores one visit entry.

Example body:

```json
{
  "sessionId": "mongo-session-id",
  "url": "https://www.linkedin.com/in/example/",
  "startedAt": "2026-03-08T15:00:00.000Z",
  "endedAt": "2026-03-08T15:03:45.000Z",
  "durationMs": 225000,
  "actions": [
    "click:button:Connect",
    "scroll:900"
  ],
  "scrollCount": 5,
  "maxScrollY": 1800,
  "title": "Example Person | LinkedIn"
}
```

## 5. Open Claw note

Open Claw already ships its own Chrome extension relay for Chrome Extension Mode. If you want the agent to control a tab through Open Claw, use the official install flow from the docs:

- [Chrome extension docs](https://docs.openclaw.ai/tools/chrome-extension)
- [Browser tool docs](https://docs.openclaw.ai/tools/browser)

This repository's extension is separate and focused on visit logging to your own backend.

## 6. Important limitation

This project is designed for user-driven browsing analytics. It does not automatically visit LinkedIn profiles, simulate dwell time, or perform automated friend traversal.
