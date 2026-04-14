# Patches

AI-powered CSS patch injector for any website. Built with Electron + Gemini.

## Setup

```bash
npm install
```

### Set your Gemini API key

Get a key at <https://aistudio.google.com/apikey>

```bash
# create a .env file in the project root
echo "GEMINI_API_KEY=your_api_key_here" > .env
npm start
```

### Choose a model (optional)

Default: `gemini-2.0-flash`

```bash
export PATCHES_MODEL="gemini-2.0-flash-lite"
```

Other options:
- `gemini-2.0-flash-lite`
- `gemini-1.5-flash`
- `gemini-1.5-flash-8b`

## Usage

- **New patch** (navbar, ⌘K)  →  AI prompt bar in the center (what you use to *create* a patch)
- **Saved** (navbar, ⌘⇧P)     →  Right sidebar: list, aspect checkboxes, **Reset site**, remove
- Toggle switch →  Enable/disable all patches

## How the LLM pipeline works

1. Grabs a structural outline of the live DOM (tags, id/class/role, short text).
2. trimDOM() also prepares a trimmed HTML snapshot for context.
3. Sends to Gemini: system prompt asks for a **JSON** object `{"aspects":[{"label","css"},...]}` so independent changes (e.g. dark mode vs font size) can be toggled separately in the patches panel.
4. Each aspect’s CSS is validated (braces, `!important` where needed); legacy patches with a single `css` field still work as one aspect.
5. Combined enabled aspects are injected as `<style>` tags, saved under `storage/patches.json` per domain.

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

`.env` is intentionally excluded from installers. Beta users must create it manually.

- macOS packaged app: create `.env` at `Patches.app/Contents/.env`
- Windows packaged app: create `.env` in the same folder as `Patches.exe`
- Supported fallback: `%APPDATA%/Patches/.env` on Windows or `~/Library/Application Support/Patches/.env` on macOS

Required content:

```env
GEMINI_API_KEY=your_api_key_here
```

If no key is found on launch, Patches shows a native dialog with the exact path and opens the destination folder automatically.

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
