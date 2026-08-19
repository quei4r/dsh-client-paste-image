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
 * Requires dsh-drop-caret to be installed (its route + reference source
 * codec are reused; we register our own trigger source with the same wire
 * format). Plain-text pastes and file drops are untouched. Alt+paste
 * bypasses the interception.
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

    /* Should THIS paste be converted to a path? Only for models the user
     * listed as text-only (config `textOnlyRoutes`: "provider/model" glob
     * patterns). Vision-capable sessions keep the native paste pipeline —
     * thumbnails, image blocks, admission — completely untouched. Empty
     * list = convert nowhere (fail-safe: native behavior everywhere).
     *
     * Route data comes from the same per-session ModelDirectory the
     * composer's model seat uses (modelDirectories service); that seat
     * loads the store on mount, so the synchronous snapshot read is
     * reliable at paste time. Any gap (service missing, directory not
     * yet loaded, unknown session) fails safe to the native pipeline.
     * NOTE: config is apply()'s SECOND argument — the dynamic ctx guard
     * does not expose plugin config as a ctx property. */
    function routeMatches(pattern, provider, model) {
      var pat = pattern.split('/');
      if (pat.length !== 2) return false;
      var pp = pat[0].trim();
      var mm = pat[1].trim();
      var rx = function (s) { return new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); };
      return rx(pp).test(provider) && rx(mm).test(model);
    }

    function shouldConvert(cfg, ctx, sessionId) {
      var routes = Array.isArray(cfg && cfg.textOnlyRoutes) ? cfg.textOnlyRoutes : [];
      if (routes.length === 0) return false;
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

    function apply(ctx, config) {
      var cfg = config || {};
      var doc = document;

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

      /* Page-lifetime paste listener; no React mount needed because the
       * session scope for insertion is resolved per-paste from the
       * sessions service (single-session GUI). */
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
          var sessionId = ctx.sessions && ctx.sessions.selected ? ctx.sessions.selected : null;
          if (sessionId === null || sessionId === undefined) return;
          if (!shouldConvert(cfg, ctx, sessionId)) return;
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
    exports.inject = ['inputTriggers', 'sessions'];
    return module.exports;
  }
});
