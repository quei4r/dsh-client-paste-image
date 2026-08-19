/* Paste-image-as-path plugin (browser half).
 *
 * Text-only models cannot accept pasted images: the composer's admission
 * rejects them with "switch to a vision model". This plugin intercepts
 * clipboard image pastes in the CAPTURE phase (before the composer sees
 * them), uploads the raw bytes through dsh-drop-caret's existing
 * /api/dsh-drop host route (content-addressed file under the session's
 * .dsh-drop directory), and inserts the resulting file PATH into the draft
 * as a reference — the conversation stays pure text. The agent can then
 * hand the path to an image-capable model (e.g. via a workflow per-agent
 * model override) when the image actually needs to be looked at.
 *
 * Two wiring facts learned the hard way (v0.3.0):
 *  - Static client plugins get NO config through the module pipeline (the
 *    boot manifest carries only id/url/rev/inject). The host half bridges
 *    `textOnlyRoutes` over GET /plugin-paste-image-config; we cache it at
 *    boot. Until it arrives (or if it fails) we intercept NOTHING.
 *  - The session id cannot be read off a service property; the
 *    conversation slots pass it to the injected component's props via
 *    `inject(sessionId)` (the same mechanism dsh-drop-caret rides). An
 *    invisible slot component records it for the paste listener.
 *
 * Requires dsh-drop-caret (upload route + reference source codec are
 * reused; we register our own trigger source with the same wire format).
 * Plain-text pastes and file drops are untouched. Alt+paste bypasses.
 * Vision-capable / unlisted routes: zero side effects, native pipeline.
 */
window.__ModuleLoader__.load({
  id: 'dsh-client-paste-image',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var CSS = [
      '.cordis-pip-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:200;padding:6px 14px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#2a2b30);color:var(--dsw-alias-label-primary,#e8e8e8);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));font-size:12px;line-height:20px;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;transition:opacity .15s ease;pointer-events:none;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cordis-pip-toast.is-on{opacity:1}',
      '.cordis-pip-toast.is-err{border-color:var(--dsw-alias-state-error-primary,#e06c75)}',
    ].join('\n');

    var SOURCE_NAME = 'paste-image';
    var UPLOAD_ROUTE = '/api/dsh-drop';
    var CONFIG_ROUTE = '/plugin-paste-image-config';

    /* null = config not arrived yet → never intercept (fail-safe).
     * array (possibly empty) = what the host bridge served. */
    var routesCache = null;
    /* Session id recorded by the invisible conversation-slot probe; null
     * until the composer mounts a session (e.g. home screen). */
    var currentSessionId = null;

    var toastTimer = null;
    function toast(doc, text, isErr) {
      var el = doc.querySelector('.cordis-pip-toast');
      if (!el) {
        el = doc.createElement('div');
        el.className = 'cordis-pip-toast';
        doc.body.appendChild(el);
      }
      el.textContent = text;
      el.classList.toggle('is-err', !!isErr);
      var win = doc.defaultView;
      win.requestAnimationFrame(function () { el.classList.add('is-on'); });
      if (toastTimer) win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(function () {
        el.classList.remove('is-on');
        toastTimer = null;
      }, 1600);
    }

    function basename(p) {
      var at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return at === -1 ? p : p.slice(at + 1);
    }

    /* Same draft-insertion mechanism as dsh-drop-caret: an
     * input-insert-reference event with a trigger-source codec that
     * serializes to the plain path on the wire. */
    function insertPathAtEnd(actx, path) {
      var conversation = actx.get('conversation');
      if (conversation === undefined) throw new Error('conversation service unavailable');
      var input = conversation.input.for(actx);
      var state = input.state.getSnapshot();
      var pos = state.draft.length;
      actx.emit('slash/input-insert-reference', {
        reference: {
          source: SOURCE_NAME,
          ref: path,
          label: basename(path),
          clipboardText: path
        },
        span: { start: pos, end: pos, draftRev: state.draftRev }
      });
    }

    function extOf(type) {
      if (type === 'image/png') return 'png';
      if (type === 'image/jpeg') return 'jpg';
      if (type === 'image/webp') return 'webp';
      if (type === 'image/gif') return 'gif';
      return 'png';
    }

    function uploadAndInsert(actx, doc, file, sessionId) {
      var win = doc.defaultView;
      var name = 'pasted-' + Date.now().toString(36) + '.' + extOf(file.type);
      var reader = new win.FileReader();
      reader.onload = function () {
        fetch(UPLOAD_ROUTE, {
          method: 'POST',
          headers: {
            'content-type': file.type,
            'x-file-name': encodeURIComponent(name),
            'x-session-id': sessionId
          },
          body: new Uint8Array(reader.result),
          signal: AbortSignal.timeout(20_000),
        }).then(function (res) {
          if (!res.ok) {
            return res.text().then(function (detail) {
              toast(doc, '图片保存失败：HTTP ' + res.status + ' ' + detail.slice(0, 60), true);
            });
          }
          return res.json().then(function (data) {
            if (!data || typeof data.path !== 'string') throw new Error('bad response');
            insertPathAtEnd(actx, data.path);
            toast(doc, '图片已存为路径：' + basename(data.path));
          });
        }, function (err) {
          toast(doc, '图片上传失败：' + String((err && err.message) || err).slice(0, 60), true);
        });
      };
      reader.readAsArrayBuffer(file);
    }

    /* Pull the host-bridged textOnlyRoutes once at boot. Any failure (or
     * a non-array) collapses to [] — i.e. this plugin stops intercepting
     * and the native pipeline runs everywhere. */
    function loadRoutes(doc) {
      fetch(CONFIG_ROUTE, { signal: AbortSignal.timeout(10_000) })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          routesCache = data && Array.isArray(data.textOnlyRoutes)
            ? data.textOnlyRoutes.map(String)
            : [];
        })
        .catch(function () {
          routesCache = [];
          toast(doc, 'paste-image：配置获取失败，本次不拦截', true);
        });
    }

    /* Should THIS paste be converted to a path? Only for models the user
     * listed as text-only (host-bridged `textOnlyRoutes`: "provider/model"
     * glob patterns). Route data comes from the same per-session
     * ModelDirectory the composer's model seat uses (modelDirectories
     * service; that seat loads the store on mount, so the synchronous
     * snapshot read is reliable at paste time). Vision-capable sessions
     * keep the native paste pipeline — thumbnails, image blocks,
     * admission — completely untouched. Every gap (config not arrived,
     * directory not loaded, service missing) fails safe to native. */
    function routeMatches(pattern, provider, model) {
      var pat = pattern.split('/');
      if (pat.length !== 2) return false;
      var pp = pat[0].trim();
      var mm = pat[1].trim();
      var rx = function (s) { return new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); };
      return rx(pp).test(provider) && rx(mm).test(model);
    }

    function shouldConvert(routes, ctx, sessionId) {
      if (routes === null || routes.length === 0) return false;
      var directories;
      try { directories = ctx.get('modelDirectories'); } catch (e) { return false; }
      if (directories === undefined || directories === null || typeof directories.directoryFor !== 'function') return false;
      var directory;
      try { directory = directories.directoryFor(sessionId); } catch (e) { return false; }
      if (directory === undefined || directory === null || !directory.store || typeof directory.store.getSnapshot !== 'function') return false;
      var current = directory.store.getSnapshot().current;
      if (current === null || current === undefined) return false;
      for (var i = 0; i < routes.length; i++) {
        if (routeMatches(String(routes[i]), String(current.provider), String(current.model))) return true;
      }
      return false;
    }

    /* Invisible conversation-slot probe: the slots system hands the owning
     * session id to `inject(sessionId)`, whose return value becomes the
     * component's props. Recording it here is the reliable way to know
     * which session the composer belongs to (drop-caret does the same). */
    function SessionProbe(props) {
      currentSessionId = props.sessionId || null;
      return null;
    }

    function apply(ctx) {
      var doc = document;

      loadRoutes(doc);

      ctx.effect(function () {
        var el = doc.createElement('style');
        el.textContent = CSS;
        doc.head.appendChild(el);
        return function () { el.remove(); };
      });

      /* Trigger source: label in the draft, plain path on the wire. */
      ctx.effect(function () {
        return ctx.inputTriggers.registerSource({
          trigger: '@',
          name: SOURCE_NAME,
          candidates: async function () { return [] },
          onPick: function () { return undefined },
          codec: {
            clipboardText: function (ref) { return ref },
            serialize: async function (ref) { return ref }
          }
        });
      });

      /* Seat the session probe into the composer's slot row. */
      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-client-paste-image',
              order: 0,
              inject: function (sessionId) {
                return { sessionId: sessionId };
              }
            },
            SessionProbe
          );
        });
      });

      /* Page-lifetime paste listener; the session id comes from the slot
       * probe above, the scope for insertion from ctx.sessions.scope(). */
      ctx.effect(function () {
        var onPaste = function (e) {
          if (e.altKey) return;
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          var image = null;
          for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
              image = it.getAsFile();
              if (image) break;
            }
          }
          if (!image) return; // plain-text paste: none of our business
          var composer = e.target && e.target.closest
            ? e.target.closest('textarea, [contenteditable="true"]')
            : null;
          if (!composer) return; // pasting outside the composer: let it be
          // Decide BEFORE touching the event: only intercept when the
          // session's route is listed as text-only. Vision-capable and
          // unlisted routes never see any side effect from us — the native
          // paste pipeline (thumbnail, draft attachment, admission) runs
          // exactly as without this plugin.
          var sessionId = currentSessionId;
          if (sessionId === null || sessionId === undefined) return;
          if (!shouldConvert(routesCache, ctx, sessionId)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          var actx = ctx.sessions.scope(sessionId);
          uploadAndInsert(actx, doc, image, sessionId);
        };
        doc.addEventListener('paste', onPaste, true);
        return function () {
          doc.removeEventListener('paste', onPaste, true);
          if (toastTimer) doc.defaultView.clearTimeout(toastTimer);
          var t = doc.querySelector('.cordis-pip-toast');
          if (t) t.remove();
        };
      });
    }

    exports.apply = apply;
    exports.inject = ['slots', 'inputTriggers', 'sessions'];
    return module.exports;
  }
});
