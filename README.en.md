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

> v0.2.1 fix: plugin config must be read from `apply(ctx, config)`'s **second argument** (cordis does not expose it as a ctx property — the old `ctx.config` read was always empty, so the gate never fired); the route check now reads the session's current selection from the same `modelDirectories` service the composer uses (`store.getSnapshot().current`, loaded on mount by the composer seat) instead of guessing at `llm`/`agentDefaultModel`. Adds a browser-side smoke test `test/smoke.mjs` (10 cases: gating, globs, fail-safe paths, Alt bypass, plain text, non-composer).

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

## Files

| File | Purpose |
|------|---------|
| `client.js` | Browser half: paste interception + upload + path-reference insertion (reuses the drop-caret mechanism) |
| `index.js` | Host-side empty placeholder (required by the loader) |

Compatibility: tested against `@deepseek-ai/dsh` 0.1.0-rc.6.

## License

MIT
