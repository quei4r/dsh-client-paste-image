# dsh-client-paste-image

中文 | [English](README.en.md)

DeepSeek Harness (DSH) web client plugin: **paste an image → it lands on disk as a file path**.

## The problem it solves

Text-only models (DeepSeek / GLM, etc.) cannot accept pasted images — the composer outright rejects them with "this model does not support vision, please switch to a vision model". This plugin intercepts clipboard image pastes in the capture phase, uploads the raw bytes through [dsh-drop-caret](https://www.npmjs.com/package/dsh-drop-caret)'s host route `POST /api/dsh-drop` (stored as a content-addressed file under the session directory), and inserts the resulting **file path** into the composer. The conversation stays pure text; when the image actually needs to be looked at, the agent hands the path to an image-capable model (e.g. a workflow with a per-agent model override, or any vision tool).

## Dependency

- **dsh-drop-caret** (provides the upload route and file storage; this plugin is browser-only, its host half is empty)

## Behavior

- **Only acts on routes explicitly listed as text-only** (config `textOnlyRoutes`, `provider/model` glob patterns): pasting an image in a listed model's session → converted to a path; **vision-capable and all other models are completely unaffected** — the native thumbnail, draft-attachment, and image-admission pipeline runs exactly as before
- Empty list = intercepts nothing anywhere (fail-safe: equivalent to not being installed)
- Interception scope: image pastes inside the composer (textarea / contenteditable); plain-text pastes are never touched
- Files land in `<session-cwd>/.dsh-drop/<sessionId>/` (drop-caret's established layout)
- Insertion form: a filename label in the draft, serialized to the plain path text on send (ships its own trigger-source codec)
- **Alt+paste**: bypasses the interception and uses the product's native behavior
- Feedback: a bottom toast (filename on success, reason on failure)

> v0.3.0 rewired the plumbing (the v0.2.x gate never fired, two root causes): ① static client plugins receive **no config at all** — the boot manifest carries only id/url/rev/inject and `loader.create({name})` passes none, so the host half now bridges `textOnlyRoutes` from `cordis.patch.yml` to the browser over `GET /plugin-paste-image-config` (loopback/Origin trust fence), cached by the client at boot; ② the session id cannot be read off a service property — the conversation slots hand `sessionId` to the injected component via `inject(sessionId)` (the same mechanism dsh-drop-caret rides), and an invisible probe component records it for the paste listener. Config-not-yet-arrived / fetch-failure never intercept (fail-safe). Ships a browser-side smoke test `test/smoke.mjs` (11 cases: gating, globs, boot races, fail-safe paths, Alt bypass, plain text, non-composer).

Example config:

```yaml
- id: ui-paste-image
  name: dsh-client-paste-image
  config:
    textOnlyRoutes:
      - zai-coding-cn/glm-5.3
      - "opencode-go/deepseek-*"   # glob
```

## Install

```bash
cp -r dsh-client-paste-image ~/.dsh/profiles/web/node_modules/
```

Add to the `- insert:` list of `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
    - id: ui-paste-image
      name: dsh-client-paste-image
```

(The bundled `cordis.patch.yml` is for `dsh plugin add` / marketplace installs.)

**Restart `dsh web` to activate**: since v0.3.0 the host half registers the `GET /plugin-paste-image-config` bridge route (static client plugins receive no config through the module pipeline — `textOnlyRoutes` crosses over via this route), and host routes only register at startup — a page refresh alone is not enough. Requires **dsh-drop-caret** as a prerequisite (it provides the `POST /api/dsh-drop` upload route).

## Files

| File | Purpose |
|------|---------|
| `client.js` | Browser half: paste interception + upload + path-reference insertion (reuses the drop-caret mechanism) |
| `index.js` | Host half: the `GET /plugin-paste-image-config` config bridge route (feeds `textOnlyRoutes` to the browser, loopback/Origin trust fence) |

Compatibility: tested against `@deepseek-ai/dsh` 0.1.0-rc.6.

## License

MIT
