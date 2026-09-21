# Patches

AI-powered CSS patch injector for any website. Built with Electron + Gemini.

## Setup

```bash
npm install
```

### Firebase (login & cloud storage)

Patches uses Firebase for user authentication and syncing patches to **Cloud Firestore**. As the developer, you should set up your own central Firebase project so beta testers can seamlessly sign up inside the app.

1. Create a project at [Firebase Console](https://console.firebase.google.com/).
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Firestore Database** → Create database (production mode is fine).
4. Deploy security rules from `firestore.rules` in this repo (Firebase CLI: `firebase deploy --only firestore:rules`, or paste into the Rules tab).
5. **Project settings** → Your apps → add a **Web** app.
6. Copy the configuration values into `firebase-config.json` in the root of this repository.

By placing your Firebase config in `firebase-config.json`, the credentials will be bundled into the packaged Electron app. Beta testers will simply see a **Sign in** / **Sign up** screen upon launching the app and will be authenticated against your central Firebase project without needing to configure their own backend. 
(Note: You can still use `.env` for local testing if you prefer).

### Set your Gemini API key

Get a key at <https://aistudio.google.com/apikey>

Google AI Studio now creates **authorization keys** that start with `AQ.`. As of September 2026 the Gemini API **rejects standard `AIza…` keys**. Create a new key in AI Studio, then:

```bash
# create a .env file in the project root
echo "GEMINI_API_KEY=AQ.your_api_key_here" > .env
npm start
```

Settings accepts both `AQ.` (new) and `AIza` (legacy) prefixes. Prefer an `AQ.` key.

Patches sends the key as an `x-goog-api-key` header (not a `?key=` query parameter).

### Choose a model (optional)

Default: `gemini-3.8-flash`. Shut-down IDs (e.g. `gemini-2.0-flash`, `gemini-2.0-flash-lite`) return 404 on every request, and deprecated 2.5 IDs 404 on many newer keys; use the list below or call the API [ListModels](https://ai.google.dev/api/rest/v1beta/models/list) for your key.

```bash
export PATCHES_MODEL="gemini-3.8-flash"
```

Supported in the app:
- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.5-flash-lite`

Note: thinking models spend output tokens on reasoning, so the app sets `maxOutputTokens: 8192` — `max_output_tokens` covers thinking + answer, and small caps truncate responses (`finishReason: MAX_TOKENS`).

## Usage

Sign in first, then browse and patch sites.

- **New patch** (navbar, ⌘K)  →  AI prompt bar in the center (what you use to *create* a patch)
- **Notes** (navbar, ⌘⇧N)     →  Same prompt bar, routed to sticky notes for this page
- **Saved** (navbar, ⌘⇧P)     →  Right sidebar: list, aspect checkboxes, **Reset site**, remove
- Toggle switch →  Enable/disable all patches

## How the LLM pipeline works

1. Grabs a structural outline of the live DOM (tags, id/class/role, short text).
2. trimDOM() also prepares a trimmed HTML snapshot for context.
3. Sends to Gemini: system prompt asks for a **JSON** object `{"aspects":[{"label","css"},...]}` so independent changes (e.g. dark mode vs font size) can be toggled separately in the patches panel.
4. Each aspect’s CSS is validated (braces, `!important` where needed); legacy patches with a single `css` field still work as one aspect.
5. Combined enabled aspects are injected as `<style>` tags, saved under `storage/patches.json` per domain.

### Page notes (prompt-driven)

Use **Notes** (⌘⇧N) like **New patch**: type what you want pinned (e.g. “show popular videos”). Patches builds a redacted outline once, sends it **with your prompt** to Gemini, and overlays **one grouped sticky note** whose entries (title + snippet, sorted by importance) each keep their anchor — click an entry to scroll to that element on the page. Refresh re-runs the last prompt. There is no background page reading. User-initiated notes are capped at 30 requests per domain per hour. Raw page text is not saved; the group note's position is stored locally.

Render-time anchor diagnostics: main.js logs `[patches:notes] anchor <n> …: FOUND/MISSING on page at render time` for every item, so if the target page re-renders between outline capture and the Gemini response (anchors gone), it's visible in the console.

### Color requests (“blues → reds”)

The snapshot does **not** include colors from external stylesheets, so the model cannot see every blue hex on the page. The prompt instructs it to use **hue-rotate / filter** on the root when a broad recolor is needed, plus targeted rules for classes/ids that appear in the snapshot. Results vary by site; try rephrasing (e.g. “strong red theme via filter on html”) if one attempt is weak.

## Distribution

Build artifacts are created with `electron-builder` and written to `dist/`.

### Build locally

```bash
# macOS DMG + ZIP
npm run build:mac

# Windows NSIS installer
npm run build:win

# Linux AppImage
npm run build:linux
```

You can also run all configured platform targets with:

```bash
npm run build
```

### Build outputs

| Target command | Platform | Output |
| --- | --- | --- |
| `npm run build:mac` | macOS | `dist/*.dmg`, `dist/*.zip` |
| `npm run build:win` | Windows | `dist/*.exe` (NSIS installer) |
| `npm run build:linux` | Linux | `dist/*.AppImage` |

### End-user API key setup

`.env` is intentionally excluded from installers. Beta users add a key in **Settings** (recommended) or create `.env` manually. Without a key, the browser and **saved** patches still work; only **New patch** (AI generation) needs a key.

- macOS packaged app: create `.env` at `Patches.app/Contents/.env`
- Windows packaged app: create `.env` in the same folder as `Patches.exe`
- Supported fallback: `%APPDATA%/Patches/.env` on Windows or `~/Library/Application Support/Patches/.env` on macOS

Required content:

```env
GEMINI_API_KEY=AQ.your_api_key_here
```

Legacy `AIza…` keys may still be stored locally; Gemini itself rejects standard keys as of September 2026. Use a new authorization key from AI Studio.

If no key is found on launch, Patches opens **Settings** (always-on-top) and the main window. You can browse and use saved patches; add a key to enable AI patch generation.

### Unsigned beta builds

For beta distribution without code signing:

- macOS: right-click the app and choose **Open** to bypass Gatekeeper.
- Windows: click **More info** then **Run anyway** in SmartScreen.

### Code signing stubs (to enable later)

`package.json` uses unsigned defaults for beta builds. When you are ready to sign, add fields like these under `build.mac` and `build.win`:

```json
{
  "build": {
    "mac": {
      "// signing identity": "Developer ID Application: Your Team",
      "// notarization env": "APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID"
    },
    "win": {
      "// cert file": "build/certs/windows-signing.pfx",
      "// cert password env": "CSC_KEY_PASSWORD"
    }
  }
}
```
