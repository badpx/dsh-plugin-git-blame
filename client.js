/**
 * Client half of the Git Blame on Hover plugin.
 *
 * It owns no document renderer. Instead it listens for pointer movement over a
 * source line inside the right-sidebar file preview (`[data-code-preview]` or
 * `[data-textpreview-plain]`), resolves the previewed file from the tab's
 * `dsh-resource://file/session/...` address, asks the Host route for that line's
 * blame, and paints a small floating card in `shell.overlay`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-git-blame',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const FILE_PREFIX = 'dsh-resource://file/';
    const FETCH_DELAY_MS = 110;
    const DWELL_DELAY_MS = 500;
    const LEAVE_DELAY_MS = 500;
    const CARD_WIDTH = 360;
    /** Blame cache: entries older than this are treated as misses. */
    const CACHE_TTL_MS = 600000;
    /** Maximum number of line entries kept in the client blame cache. */
    const CACHE_LIMIT = 2000;
    /** Idle delay before the bubble fades to its dimmed opacity. */
    const IDLE_DIM_MS = 9000;

    /** Full git object id (SHA-1 or SHA-256), never the all-zero "uncommitted" id. */
    const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
    /** Cache key sharing one commit's message across the rows that belong to it. */
    function commitCacheKey(contentId, sha) {
      return typeof sha === 'string' && COMMIT_SHA_RE.test(sha) && !/^0+$/.test(sha)
        ? `${contentId}#commit:${sha}`
        : '';
    }

    /**
     * Snapshot-version notifier. When a file's version changes (branch switch or
     * edit) the toggle records it; the overlay subscribes so an already-open
     * bubble for that file is dismissed instead of showing a stale commit.
     */
    const versionListeners = new Set();
    const knownVersions = new Map();
    function onVersionChange(listener) {
      versionListeners.add(listener);
      return () => versionListeners.delete(listener);
    }
    function recordFileVersion(contentId, version) {
      if (!contentId || typeof version !== 'string' || version === '') return;
      const prev = knownVersions.get(contentId);
      if (prev !== undefined && prev !== version) {
        for (const listener of versionListeners) {
          try {
            listener(contentId, version);
          } catch (_error) {
            /* ignore */
          }
        }
      }
      knownVersions.set(contentId, version);
    }

    /** Persisted on/off switch shared by the toolbar toggle and the overlay. */
    const ENABLED_STORAGE_KEY = 'dsh.git-blame-hover.enabled';
    const enabledListeners = new Set();
    let enabledValue = (() => {
      try {
        const stored = window.localStorage.getItem(ENABLED_STORAGE_KEY);
        return stored === null ? true : stored === '1';
      } catch (_error) {
        return true;
      }
    })();

    function isEnabled() {
      return enabledValue;
    }

    function setEnabled(next) {
      const value = !!next;
      if (value === enabledValue) return;
      enabledValue = value;
      try {
        window.localStorage.setItem(ENABLED_STORAGE_KEY, value ? '1' : '0');
      } catch (_error) {
        /* storage may be unavailable */
      }
      for (const listener of enabledListeners) {
        try {
          listener();
        } catch (_error) {
          /* ignore a failing subscriber */
        }
      }
    }

    function subscribeEnabled(listener) {
      enabledListeners.add(listener);
      return () => enabledListeners.delete(listener);
    }

    /** Shortcut command id and the effective binding shown in the tooltip. */
    const SHORTCUT_COMMAND_ID = 'git-blame.toggle';
    let shortcutHint = { keys: [], aria: undefined };
    const shortcutHintListeners = new Set();

    function getShortcutHint() {
      return shortcutHint;
    }

    function setShortcutHint(next) {
      shortcutHint = next;
      for (const listener of shortcutHintListeners) {
        try {
          listener();
        } catch (_error) {
          /* ignore */
        }
      }
    }

    function subscribeShortcutHint(listener) {
      shortcutHintListeners.add(listener);
      return () => shortcutHintListeners.delete(listener);
    }

    /** Short-lived per-file status cache: git-tracked? text? content version? */
    const STATUS_TTL_MS = 1000;
    const STATUS_CACHE_MAX_ENTRIES = 500;
    const statusCache = new Map();
    const statusInflight = new Map();

    async function fetchFileStatus(file) {
      const cached = statusCache.get(file.contentId);
      if (cached !== undefined) {
        if (Date.now() - cached.ts <= STATUS_TTL_MS) return cached.value;
        statusCache.delete(file.contentId); // drop expired so the map stays bounded
      }
      const inflight = statusInflight.get(file.contentId);
      if (inflight !== undefined) return inflight;
      const request = (async () => {
        let value = { tracked: false, text: false, version: '', determined: false };
        try {
          const response = await fetch(buildStatusUrl(file.sessionId, file.path), {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const data = await response.json().catch(() => null);
          if (data && data.ok) {
            value = {
              tracked: !!data.tracked,
              text: !!data.text,
              version: typeof data.version === 'string' ? data.version : '',
              determined: true,
            };
          }
        } catch (_error) {
          /* leave determined=false so callers can retry */
        }
        if (!statusCache.has(file.contentId) && statusCache.size >= STATUS_CACHE_MAX_ENTRIES) {
          const oldest = statusCache.keys().next();
          if (!oldest.done) statusCache.delete(oldest.value);
        }
        statusCache.set(file.contentId, { value, ts: Date.now() });
        statusInflight.delete(file.contentId);
        return value;
      })();
      statusInflight.set(file.contentId, request);
      return request;
    }

    /* ------------------------------------------------------------------ *
     * Inline blame gutter: injected into the built-in highlighted preview.
     * ------------------------------------------------------------------ */

    const GUTTER_WIDTH = 150;
    const GUTTER_STYLE_ID = 'dsh-git-blame-gutter-style';
    /** Byte budget for the whole-file blame cache (parsed per-line arrays). */
    const GUTTER_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
    /** Hard entry cap regardless of size (protects many tiny files). */
    const GUTTER_CACHE_MAX_ENTRIES = 200;
    /** A single file whose parsed line array exceeds this is not cached. */
    const GUTTER_CACHE_ENTRY_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
    /** LRU: key -> { lines, bytes }. Insertion order is the recency order. */
    const gutterCache = new Map();
    let gutterCacheBytes = 0;

    /** Rough byte size of one parsed per-line blame array, for the cache budget. */
    function estimateGutterBytes(lines) {
      if (!Array.isArray(lines)) return 0;
      let bytes = 32;
      for (const entry of lines) {
        if (!entry) {
          bytes += 8;
          continue;
        }
        bytes += 72;
        if (entry.sha) bytes += entry.sha.length;
        if (entry.shortSha) bytes += entry.shortSha.length;
        if (entry.author) bytes += entry.author.length * 2;
        if (entry.date) bytes += entry.date.length;
      }
      return bytes;
    }

    /** LRU get: touch recency on hit. */
    function gutterCacheGet(key) {
      const entry = gutterCache.get(key);
      if (entry === undefined) return undefined;
      gutterCache.delete(key);
      gutterCache.set(key, entry);
      return entry.lines;
    }

    /** LRU set with a total byte budget and entry cap; evicts least-recently-used. */
    function gutterCacheSet(key, lines) {
      const bytes = estimateGutterBytes(lines);
      if (bytes > GUTTER_CACHE_ENTRY_MAX_BYTES || bytes > GUTTER_CACHE_MAX_BYTES) return;
      if (gutterCache.has(key)) {
        gutterCacheBytes -= gutterCache.get(key).bytes;
        gutterCache.delete(key);
      }
      while (
        gutterCache.size > 0
        && (gutterCacheBytes + bytes > GUTTER_CACHE_MAX_BYTES || gutterCache.size >= GUTTER_CACHE_MAX_ENTRIES)
      ) {
        const oldest = gutterCache.keys().next();
        if (oldest.done) break;
        gutterCacheBytes -= gutterCache.get(oldest.value).bytes;
        gutterCache.delete(oldest.value);
      }
      gutterCache.set(key, { lines, bytes });
      gutterCacheBytes += bytes;
    }

    /** Coalesce concurrent whole-file reads for the same file + version. */
    const gutterInflight = new Map();
    /** The line mapping the gutter currently shows for the open preview, so the
     *  bubble can reuse it even when a huge mapping is too large to cache. */
    let activePreviewMapping = null;

    function buildFileBlameUrl(sessionId, filePath, version) {
      const url = new URL('plugin/git-blame/file', document.baseURI);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('path', filePath);
      if (version) url.searchParams.set('version', version);
      return url.href;
    }

    /**
     * Fetch the whole-file blame mapping. Returns `{ lines, version }` where
     * `version` is the snapshot the host actually blamed. Concurrent calls for the
     * same file+version share one request, and a successful payload is cached under
     * the ACTUAL version (never under a stale requested one).
     */
    async function fetchGutterLines(file) {
      const requestedVersion = file.version || '';
      const requestedKey = `${file.contentId}@${requestedVersion}`;
      const cached = gutterCacheGet(requestedKey);
      if (cached !== undefined) return { lines: cached, version: requestedVersion };
      const inflight = gutterInflight.get(requestedKey);
      if (inflight !== undefined) return inflight;
      const request = (async () => {
        try {
          const response = await fetch(buildFileBlameUrl(file.sessionId, file.path, file.version), {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const data = await response.json().catch(() => null);
          if (data && data.ok && Array.isArray(data.lines)) {
            const actualVersion = typeof data.version === 'string' && data.version ? data.version : requestedVersion;
            gutterCacheSet(`${file.contentId}@${actualVersion}`, data.lines);
            return { lines: data.lines, version: actualVersion };
          }
        } catch (_error) {
          /* do not cache the failure */
        }
        return { lines: [], version: requestedVersion };
      })();
      gutterInflight.set(requestedKey, request);
      try {
        return await request;
      } finally {
        gutterInflight.delete(requestedKey);
      }
    }

    function ensureGutterStyle() {
      if (document.getElementById(GUTTER_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = GUTTER_STYLE_ID;
      style.textContent =
        `[data-textpreview-url].gb-gutter-on [data-code-preview] pre .line{` +
        `padding-inline-start:calc(${GUTTER_WIDTH}px + var(--dsl-code-block-line-number-width) + 12px) !important;}` +
        `[data-textpreview-url].gb-gutter-on [data-code-preview] pre .line::before{` +
        `inset-inline-start:${GUTTER_WIDTH}px !important;}` +
        `.gb-gutter{position:absolute;inset-inline-start:0;top:0;bottom:0;width:${GUTTER_WIDTH}px;box-sizing:border-box;` +
        `display:flex;align-items:center;gap:6px;padding:0 6px;overflow:hidden;white-space:nowrap;` +
        `font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:1.4;` +
        `color:var(--dsw-alias-label-secondary);border-inline-end:0.5px solid var(--dsw-alias-border-l1);` +
        `user-select:none;cursor:default;pointer-events:auto;}` +
        `.gb-gutter .gb-date{flex:none;color:var(--dsw-alias-label-tertiary);}` +
        `.gb-gutter .gb-author{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;}`;
      document.head.appendChild(style);
    }

    function gutterColor(sha) {
      if (!sha || /^0+$/.test(sha)) return 'rgba(130,130,130,0.10)';
      let hash = 0;
      for (let i = 0; i < sha.length; i += 1) hash = (hash * 31 + sha.charCodeAt(i)) >>> 0;
      return `hsla(${hash % 360}, 62%, 52%, 0.20)`;
    }

    function formatGutterDate(iso) {
      if (!iso) return '';
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
    }

    function clearGutterDom(preview) {
      preview.querySelectorAll('.gb-gutter').forEach((element) => element.remove());
    }

    function syncGutterDom(preview, lines) {
      ensureGutterStyle();
      preview.classList.add('gb-gutter-on');
      const lineElements = preview.querySelectorAll('[data-code-preview] pre .line');
      lineElements.forEach((lineElement, index) => {
        const info = lines[index];
        let span = lineElement.querySelector(':scope > .gb-gutter');
        if (!info) {
          if (span) span.remove();
          return;
        }
        if (!span) {
          span = document.createElement('span');
          span.className = 'gb-gutter';
          span.dataset.line = String(index + 1);
          lineElement.insertBefore(span, lineElement.firstChild);
        }
        const dateText = formatGutterDate(info.date);
        const authorText = info.uncommitted ? '未提交' : (info.author || '');
        const signature = `${info.sha || ''}|${dateText}|${authorText}`;
        if (span.dataset.sig === signature) return;
        span.dataset.sig = signature;
        span.dataset.sha = info.sha || '';
        span.style.background = gutterColor(info.sha);
        span.textContent = '';
        const dateElement = document.createElement('span');
        dateElement.className = 'gb-date';
        dateElement.textContent = dateText;
        const authorElement = document.createElement('span');
        authorElement.className = 'gb-author';
        authorElement.textContent = authorText;
        span.append(dateElement, authorElement);
        span.title = info.uncommitted ? '未提交的更改' : `${dateText} ${authorText} ${info.shortSha || ''}`.trim();
      });
    }

    /** Parse a `dsh-resource://file/...` address into session + path. */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined;
      const end = address.search(/[?#]/);
      const body = end === -1 ? address.slice(FILE_PREFIX.length) : address.slice(FILE_PREFIX.length, end);
      const parts = body.split('/');
      const scope = parts.shift();
      try {
        if (scope === 'session') {
          const id = parts.shift();
          if (id === undefined || id === '' || parts.length === 0) return undefined;
          return { scope, sessionId: decodeURIComponent(id), path: parts.map(decodeURIComponent).join('/') };
        }
        if (scope === 'absolute') {
          const unc = parts[0] === '' && parts.length > 1;
          const segments = (unc ? parts.slice(1) : parts).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === '') return undefined;
          if (unc) return { scope, path: `//${segments.join('/')}` };
          return { scope, path: segments[0].match(/^[A-Za-z]:$/) ? segments.join('/') : `/${segments.join('/')}` };
        }
      } catch (_decodeError) {
        return undefined;
      }
      return undefined;
    }

    /** Find the 1-based source line under an element inside a preview body. */
    function lineAt(element) {
      if (!(element instanceof Element)) return undefined;

      const codeBody = element.closest('[data-code-preview]');
      if (codeBody) {
        const lineEl = element.closest('.line');
        if (lineEl && codeBody.contains(lineEl)) {
          const pre = lineEl.closest('pre');
          if (pre) {
            const rows = Array.from(pre.querySelectorAll('.line'));
            const index = rows.indexOf(lineEl);
            if (index >= 0) return index + 1;
          }
        }
        return undefined;
      }

      const plainBody = element.closest('[data-textpreview-plain]');
      if (plainBody) {
        const lineEl = element.closest('[data-textpreview-line]');
        if (lineEl) {
          const rows = Array.from(plainBody.querySelectorAll('[data-textpreview-line]'));
          const index = rows.indexOf(lineEl);
          if (index >= 0) return index + 1;
        }
      }
      return undefined;
    }

    /**
     * Resolve the previewed file (session + workspace path) from the hovered line.
     * The preview container publishes its own `dsh-resource://file/...` address on
     * `data-textpreview-url`, so no sidebar service lookup is required.
     */
    function fileAt(element) {
      const preview = element.closest('[data-textpreview-url]');
      if (!preview) return undefined;
      const contentId = preview.dataset.textpreviewUrl;
      if (typeof contentId !== 'string' || contentId === '') return undefined;
      const parsed = parseFileAddress(contentId);
      if (!parsed || parsed.scope !== 'session') return undefined;
      return { sessionId: parsed.sessionId, path: parsed.path, contentId };
    }

    function buildUrl(sessionId, filePath, line, version) {
      const url = new URL('plugin/git-blame', document.baseURI);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('path', filePath);
      url.searchParams.set('line', String(line));
      if (version) url.searchParams.set('version', version);
      return url.href;
    }

    function buildStatusUrl(sessionId, filePath) {
      const url = new URL('plugin/git-blame/status', document.baseURI);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('path', filePath);
      return url.href;
    }

    /**
     * Fixed-width, tabular line number whose spare space sits AFTER the digits
     * (left aligned) so `#line` starts flush with the title below and the
     * following short SHA never shifts as the digit count changes.
     */
    const lineBadgeStyle = {
      flex: 'none',
      minWidth: '5ch',
      display: 'inline-block',
      textAlign: 'left',
      fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    /** Maximum commit-message body lines shown in the bubble. */
    const MAX_BODY_LINES = 5;

    /** Cap a message body at MAX_BODY_LINES logical lines, appending an ellipsis when cut. */
    function clampMessageBody(text) {
      const lines = String(text || '').split('\n');
      if (lines.length <= MAX_BODY_LINES) return String(text || '');
      return lines.slice(0, MAX_BODY_LINES).join('\n') + '…';
    }

    /** Top section: #line, short SHA, date, author. */
    function renderTopLine(tip, data) {
      return h('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0, whiteSpace: 'nowrap' },
      },
      h('span', { style: lineBadgeStyle }, `#${tip.line}`),
      h('span', {
        style: {
          flex: 'none',
          fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
          fontSize: '11px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, data.shortSha || ''),
      h('span', { style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, data.date || ''),
      h('span', {
        title: data.authorMail || undefined,
        style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '12px', fontWeight: 600 },
      }, data.author || 'Unknown author'));
    }

    /** The floating card content. */
    function renderCard(tip) {

      if (tip.status === 'loading') {
        return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
          h('span', { style: lineBadgeStyle }, `#${tip.line}`),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, 'Reading git blame…'));
      }

      if (tip.status === 'error') {
        return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
          h('span', { style: lineBadgeStyle }, `#${tip.line}`),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'normal' } },
            tip.message || 'Git blame unavailable'));
      }

      const data = tip.data || {};
      const title = data.title || data.summary || '';
      const messageBody = data.body || '';
      // When the commit message is a single line it becomes the title; let that
      // lone line wrap and use the whole message line budget instead of being
      // truncated to one line.
      const titleOnly = Boolean(title) && !messageBody;

      const message = (title || messageBody)
        ? h('div', {
          style: { marginTop: '3px', display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
        },
        title
          ? h('div', {
            title: title,
            style: titleOnly
              ? {
                fontSize: '12px',
                fontWeight: 700,
                color: 'var(--dsw-alias-label-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: MAX_BODY_LINES,
                WebkitBoxOrient: 'vertical',
              }
              : {
                fontSize: '12px',
                fontWeight: 700,
                color: 'var(--dsw-alias-label-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
          }, title)
          : null,
        messageBody
          ? h('div', {
            title: messageBody,
            style: {
              fontSize: '12px',
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'pre-wrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: MAX_BODY_LINES,
              WebkitBoxOrient: 'vertical',
            },
          }, clampMessageBody(messageBody))
          : null)
        : null;

      return h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
        renderTopLine(tip, data),
        message);
    }

    /** Toolbar switch in the preview header that turns the blame bubble on/off. */
    function BlameToggle() {
      const [enabled, setEnabledUi] = React.useState(isEnabled());
      const [hover, setHover] = React.useState(false);
      const [support, setSupport] = React.useState('unknown');
      const [fileInfo, setFileInfo] = React.useState(null);
      const [tipOpen, setTipOpen] = React.useState(false);
      const [tipTop, setTipTop] = React.useState(0);
      const [tipRight, setTipRight] = React.useState(0);
      const [shortcut, setShortcut] = React.useState(getShortcutHint());
      const buttonRef = React.useRef(null);
      const tipTimerRef = React.useRef(0);
      React.useEffect(() => subscribeEnabled(() => setEnabledUi(isEnabled())), []);
      React.useEffect(() => subscribeShortcutHint(() => setShortcut(getShortcutHint())), []);
      React.useEffect(() => {
        let active = true;
        let observer = null;
        let observed = null;
        let debounce = 0;
        let pollTimer = 0;

        const scheduleImmediate = () => {
          clearTimeout(debounce);
          debounce = setTimeout(evaluate, 150);
        };

        const evaluate = () => {
          if (!active) return;
          const element = buttonRef.current;
          const preview = element && element.closest ? element.closest('[data-textpreview-url]') : null;
          // Re-bind the observer whenever the preview node changes (e.g. a tab or
          // renderer switch) so renderer changes are noticed promptly.
          if (preview && preview !== observed) {
            if (observer) observer.disconnect();
            observed = preview;
            observer = new MutationObserver(scheduleImmediate);
            observer.observe(preview, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-textpreview-url'] });
          }
          const address = preview && preview.dataset ? preview.dataset.textpreviewUrl : undefined;
          const parsed = address ? parseFileAddress(address) : undefined;
          if (!parsed || parsed.scope !== 'session') {
            setSupport('no');
            setFileInfo(null);
            return;
          }
          fetchFileStatus({ sessionId: parsed.sessionId, path: parsed.path, contentId: address })
            .then((status) => {
              if (!active) return;
              if (!status.determined) return; // transient; the poll retries
              // The gutter only exists in the highlighted code renderer
              // (`[data-code-preview]`); plain-text previews have no line nodes, so
              // do not offer the toggle there. Re-checked on every renderer change.
              const hasCodePreview = Boolean(preview && preview.querySelector && preview.querySelector('[data-code-preview]'));
              const eligible = status.tracked && status.text && hasCodePreview;
              if (status.tracked && status.text) recordFileVersion(address, status.version || '');
              setSupport(eligible ? 'yes' : 'no');
              setFileInfo((prev) => {
                if (!eligible) return null;
                const version = status.version || '';
                if (prev && prev.contentId === address && prev.version === version) return prev;
                return { sessionId: parsed.sessionId, path: parsed.path, contentId: address, version };
              });
            })
            .catch(() => {});
        };

        evaluate();
        // Poll for branch switches / edits (version changes) while mounted.
        pollTimer = setInterval(evaluate, 1000);
        return () => {
          active = false;
          clearTimeout(debounce);
          clearInterval(pollTimer);
          if (observer) observer.disconnect();
        };
      }, []);

      React.useEffect(() => () => clearTimeout(tipTimerRef.current), []);

      // Inject / remove the inline blame gutter column in the current preview.
      React.useEffect(() => {
        if (!enabled || support !== 'yes' || !fileInfo) return undefined;
        const element = buttonRef.current;
        const preview = element && element.closest ? element.closest('[data-textpreview-url]') : null;
        if (!preview) return undefined;
        let cancelled = false;
        let lines = null;
        let observer = null;
        let raf = 0;
        const retries = [];
        const schedule = () => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (cancelled || !lines) return;
            syncGutterDom(preview, lines);
            if (observer) observer.takeRecords();
          });
        };
        fetchGutterLines(fileInfo).then((result) => {
          if (cancelled) return;
          const mapping = result && Array.isArray(result.lines) ? result : { lines: [], version: fileInfo.version };
          lines = mapping.lines;
          // Expose this mapping to the bubble so it can reuse the very lines the
          // column already holds — even when they are too large to cache.
          activePreviewMapping = {
            contentId: fileInfo.contentId,
            version: mapping.version || fileInfo.version,
            lines,
          };
          syncGutterDom(preview, lines);
          observer = new MutationObserver(schedule);
          observer.observe(preview, { childList: true, subtree: true });
          observer.takeRecords();
          for (const delay of [120, 450, 900]) {
            retries.push(setTimeout(() => {
              if (!cancelled && lines) syncGutterDom(preview, lines);
            }, delay));
          }
        });
        return () => {
          cancelled = true;
          if (observer) observer.disconnect();
          if (raf) cancelAnimationFrame(raf);
          for (const timer of retries) clearTimeout(timer);
          preview.classList.remove('gb-gutter-on');
          clearGutterDom(preview);
          if (activePreviewMapping && activePreviewMapping.contentId === fileInfo.contentId) {
            activePreviewMapping = null;
          }
        };
      }, [enabled, support, fileInfo && fileInfo.contentId, fileInfo && fileInfo.version]);

      const openTip = () => {
        clearTimeout(tipTimerRef.current);
        tipTimerRef.current = setTimeout(() => {
          const element = buttonRef.current;
          if (!element) return;
          const rect = element.getBoundingClientRect();
          setTipTop(rect.bottom + 6);
          setTipRight(Math.max(8, window.innerWidth - rect.right));
          setTipOpen(true);
        }, 350);
      };

      const closeTip = () => {
        clearTimeout(tipTimerRef.current);
        setTipOpen(false);
      };

      // Keep the button mounted even when this preview is not eligible: it is the
      // stable anchor used to re-find the preview container. Its visibility is
      // controlled by `support` below, so code ineligible -> plain -> code recovers.
      const tipText = enabled ? '关闭git blame显示' : '打开git blame显示';
      const icon = h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('rect', { x: 2, y: 3, width: 12, height: 8, rx: 2 }),
      h('path', { d: 'M5 11 L5 13.6 L7.8 11' }),
      h('line', { x1: 4.6, y1: 6, x2: 11.4, y2: 6 }),
      h('line', { x1: 4.6, y1: 8.4, x2: 9.2, y2: 8.4 }),
      enabled ? null : h('line', { x1: 2.4, y1: 13.4, x2: 13.6, y2: 2.6 }));

      const button = h('button', {
        ref: buttonRef,
        type: 'button',
        'aria-label': tipText,
        'aria-pressed': enabled,
        'data-git-blame-toggle': enabled ? 'on' : 'off',
        onClick: () => setEnabled(!isEnabled()),
        onMouseEnter: () => {
          setHover(true);
          openTip();
        },
        onMouseLeave: () => {
          setHover(false);
          closeTip();
        },
        onFocus: openTip,
        onBlur: closeTip,
        style: {
          width: '28px',
          height: '28px',
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px',
          margin: '0',
          visibility: support === 'yes' ? 'visible' : 'hidden',
          color: enabled ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          cursor: 'pointer',
          opacity: enabled ? 1 : 0.72,
        },
      }, icon);

      const tipChildren = [h('span', { key: 'text' }, tipText)];
      if (shortcut && Array.isArray(shortcut.keys) && shortcut.keys.length > 0) {
        tipChildren.push(h('span', {
          key: 'keys',
          style: { display: 'inline-flex', alignItems: 'center', gap: '3px', marginLeft: '8px' },
        }, ...shortcut.keys.map((key, index) => h('kbd', {
          key: index,
          style: {
            fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
            fontSize: '11px',
            lineHeight: 1.3,
            padding: '0 4px',
            borderRadius: '3px',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'var(--dsw-alias-bg-layer-3)',
            border: '0.5px solid var(--dsw-alias-border-l2)',
          },
        }, key))));
      }

      const tooltip = tipOpen
        ? h('div', {
          'data-git-blame-tip': true,
          style: {
            position: 'fixed',
            top: `${Math.round(tipTop)}px`,
            right: `${Math.round(tipRight)}px`,
            zIndex: 2147483000,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 8px',
            maxWidth: '280px',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            lineHeight: 1.4,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-sm)',
            boxShadow: 'var(--dsw-elevation-prominent)',
            pointerEvents: 'none',
          },
        }, ...tipChildren)
        : null;

      return h(React.Fragment, null, button, tooltip);
    }

    function apply(ctx) {
      function Overlay() {
        const [tip, setTip] = React.useState(null);
        const [dimmed, setDimmed] = React.useState(false);
        const [enabled, setEnabledUi] = React.useState(isEnabled());
        const [cardHeight, setCardHeight] = React.useState(0);
        const cardRef = React.useRef(null);
        const tipRef = React.useRef(null);
        const hideRef = React.useRef(null);
        const cacheRef = React.useRef(new Map());
        const timerRef = React.useRef(0);
        const seqRef = React.useRef(0);
        const showSeqRef = React.useRef(0);
        const lastKeyRef = React.useRef('');

        React.useEffect(() => {
          const publish = (next) => {
            tipRef.current = next;
            setTip(next);
          };

          let hideTimer = 0;
          let idleTimer = 0;
          let dwellTimer = 0;
          let dwellKey = '';
          let dwellFile = null;
          let dwellLine = 0;
          let dwellX = 0;
          let dwellY = 0;

          const clearIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = 0;
          };

          /** Reset the idle countdown and restore full opacity on any pointer activity. */
          const notifyActivity = () => {
            setDimmed((was) => (was ? false : was));
            clearIdle();
            idleTimer = setTimeout(() => {
              idleTimer = 0;
              if (tipRef.current !== null) setDimmed(true);
            }, IDLE_DIM_MS);
          };

          const clearDwell = () => {
            clearTimeout(dwellTimer);
            dwellTimer = 0;
            dwellKey = '';
          };

          const hide = () => {
            clearTimeout(hideTimer);
            hideTimer = 0;
            clearIdle();
            setDimmed((was) => (was ? false : was));
            clearDwell();
            clearTimeout(timerRef.current);
            showSeqRef.current += 1;
            if (tipRef.current !== null) {
              lastKeyRef.current = '';
              publish(null);
            }
          };
          hideRef.current = hide;

          const scheduleHide = () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(hide, LEAVE_DELAY_MS);
          };

          const cancelHide = () => {
            if (hideTimer !== 0) {
              clearTimeout(hideTimer);
              hideTimer = 0;
            }
          };

          const cacheGet = (key) => {
            const entry = cacheRef.current.get(key);
            if (entry === undefined) return undefined;
            if (Date.now() - entry.ts > CACHE_TTL_MS) {
              cacheRef.current.delete(key);
              return undefined;
            }
            // Refresh recency for LRU ordering.
            cacheRef.current.delete(key);
            cacheRef.current.set(key, entry);
            return entry.data;
          };

          const cacheSet = (key, data) => {
            if (cacheRef.current.has(key)) {
              cacheRef.current.delete(key);
            } else if (cacheRef.current.size >= CACHE_LIMIT) {
              const oldest = cacheRef.current.keys().next();
              if (!oldest.done) cacheRef.current.delete(oldest.value);
            }
            cacheRef.current.set(key, { data, ts: Date.now() });
          };

          const fetchBlame = (key, cacheKey, file, line, version) => {
            const seq = ++seqRef.current;
            fetch(buildUrl(file.sessionId, file.path, line, version), {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
              .then((response) => response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` })))
              .then((data) => {
                // Cache even if this request was superseded: the payload is keyed
                // by (file + commit), so it stays valid for other rows of that commit.
                let settledKey = cacheKey;
                if (data && data.ok) {
                  // Prefer the SHA the server actually blamed.
                  const actualKey = commitCacheKey(file.contentId, data.sha);
                  if (actualKey) {
                    // Different real commit than the hint: drop the poisoned hint entry.
                    if (actualKey !== cacheKey) cacheRef.current.delete(cacheKey);
                    settledKey = actualKey;
                  } else {
                    // Uncommitted / unknown SHA: never share across lines, and never
                    // leave this payload under a real commit's key.
                    if (cacheKey !== key) cacheRef.current.delete(cacheKey);
                    settledKey = key;
                  }
                  cacheSet(settledKey, data);
                }
                if (seq !== seqRef.current) return;
                if (!tipRef.current || tipRef.current.key !== key) return;
                publish({
                  ...tipRef.current,
                  cacheKey: settledKey,
                  status: data && data.ok ? 'ok' : 'error',
                  data: data && data.ok ? data : undefined,
                  message: data && data.ok ? undefined : (data && data.message) || 'Request failed',
                });
              })
              .catch((error) => {
                if (seq !== seqRef.current) return;
                if (!tipRef.current || tipRef.current.key !== key) return;
                publish({ ...tipRef.current, status: 'error', message: String((error && error.message) || error) });
              });
          };

          const showLine = async (base, file, line, x, y) => {
            const my = ++showSeqRef.current;
            const status = await fetchFileStatus(file);
            // Superseded by a newer line or by hiding.
            if (my !== showSeqRef.current) return;
            // Only git-tracked text files get a bubble.
            if (!status.tracked || !status.text) {
              if (tipRef.current !== null) hide();
              return;
            }
            const requestedVersion = status.version;
            let effectiveVersion = requestedVersion;
            let lines;
            // Prefer the mapping the sidebar already holds for this exact version:
            // no per-hover request, and it works even for a huge mapping that is too
            // large for the byte-budget cache. Otherwise fetch (de-duplicated) one.
            if (
              activePreviewMapping
              && activePreviewMapping.contentId === file.contentId
              && activePreviewMapping.version === requestedVersion
            ) {
              lines = activePreviewMapping.lines;
            } else {
              try {
                const mapping = await fetchGutterLines({ ...file, version: requestedVersion });
                lines = mapping.lines;
                if (mapping.version) effectiveVersion = mapping.version;
              } catch (_error) {
                lines = [];
              }
            }
            if (my !== showSeqRef.current) return;
            // Identity of the hovered line (used to detect "same hover target").
            const key = `${base}@${effectiveVersion}`;
            const entry = Array.isArray(lines) ? lines[line - 1] : undefined;
            const lineSha = entry && typeof entry.sha === 'string' ? entry.sha : '';
            // A commit's message is shared across its rows; an uncommitted/all-zero
            // (or unknown) SHA falls back to per-line identity.
            const cacheKey = commitCacheKey(file.contentId, lineSha) || key;
            const cached = cacheGet(cacheKey);
            if (cached !== undefined) {
              publish({ key, base, contentId: file.contentId, version: effectiveVersion, cacheKey, x, y, line, status: 'ok', data: cached });
              return;
            }
            publish({ key, base, contentId: file.contentId, version: effectiveVersion, cacheKey, x, y, line, status: 'loading' });
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              if (tipRef.current && tipRef.current.key === key) fetchBlame(key, cacheKey, file, line, effectiveVersion);
            }, FETCH_DELAY_MS);
          };

          const process = (x, y, target) => {
            if (!isEnabled()) {
              if (tipRef.current !== null) hide();
              return;
            }
            if (!(target instanceof Element)) {
              showSeqRef.current += 1;
              hide();
              return;
            }
            const gutter = target.closest('.gb-gutter');
            if (!gutter) {
              // Bubble only shows while hovering the blame gutter; leaving closes it immediately.
              showSeqRef.current += 1;
              hide();
              return;
            }
            const line = Number(gutter.dataset.line);
            const file = fileAt(target);
            if (!Number.isInteger(line) || line < 1 || !file) {
              showSeqRef.current += 1;
              hide();
              return;
            }

            const base = `${file.contentId}#${line}`;
            // Always re-resolve, even for the same line: a branch switch or edit
            // may have changed the line's commit, and `showLine` re-verifies the
            // version and re-maps the line instead of trusting the current tip.
            showLine(base, file, line, x, y);
          };

          let lastMoveAt = 0;
          const onMove = (event) => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now - lastMoveAt < 16) return;
            lastMoveAt = now;
            notifyActivity();
            process(event.clientX, event.clientY, event.target);
          };

          const onScroll = () => hide();
          const onKeyDown = (event) => {
            if (event.key === 'Escape') hide();
          };

          document.addEventListener('pointermove', onMove, { passive: true });
          document.addEventListener('mousemove', onMove, { passive: true });
          document.addEventListener('scroll', onScroll, true);
          document.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('blur', hide);

          return () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', hide);
            clearTimeout(hideTimer);
            clearIdle();
            clearDwell();
            clearTimeout(timerRef.current);
            hideRef.current = null;
          };
        }, []);

        React.useEffect(() => subscribeEnabled(() => {
          const value = isEnabled();
          setEnabledUi(value);
          if (!value && hideRef.current) hideRef.current();
        }), []);

        // A branch switch / edit changes a file's snapshot version: dismiss an open
        // bubble for that file so it cannot keep showing the previous commit.
        React.useEffect(() => onVersionChange((contentId) => {
          const current = tipRef.current;
          if (current && current.contentId === contentId && hideRef.current) hideRef.current();
        }), []);

        // Measure the rendered card so the "above" fallback keeps the same gap.
        React.useLayoutEffect(() => {
          const node = cardRef.current;
          if (!node) return;
          const measured = node.getBoundingClientRect().height;
          setCardHeight((prev) => (Math.abs(prev - measured) > 0.5 ? measured : prev));
        }, [tip]);

        if (!enabled) return null;
        if (tip === null) return null;

        const viewportWidth = window.innerWidth || 1280;
        const viewportHeight = window.innerHeight || 800;
        const EDGE_MARGIN = 8;
        // Gap between the cursor and the card edge (same below and above).
        const CURSOR_GAP = 18;
        const left = Math.max(EDGE_MARGIN, Math.min(tip.x + 16, viewportWidth - CARD_WIDTH - EDGE_MARGIN));
        // Prefer below the cursor; when there is not enough room, flip above while
        // keeping the same gap (card bottom sits CURSOR_GAP above the cursor).
        const fitsBelow = tip.y + CURSOR_GAP + cardHeight <= viewportHeight - EDGE_MARGIN;
        const top = fitsBelow
          ? tip.y + CURSOR_GAP
          : Math.max(EDGE_MARGIN, tip.y - CURSOR_GAP - cardHeight);

        return h('div', {
          'data-git-blame-card': true,
          ref: cardRef,
          style: {
            position: 'fixed',
            left: `${left}px`,
            top: `${top}px`,
            width: `${CARD_WIDTH}px`,
            boxSizing: 'border-box',
            padding: '6px 10px',
            pointerEvents: 'none',
            zIndex: 2147483000,
            opacity: dimmed ? 0.15 : 0.85,
            transition: dimmed ? 'opacity 1s ease' : 'opacity 0.15s ease',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-lg)',
            boxShadow: 'var(--dsw-elevation-prominent)',
            fontFamily: 'var(--dsw-font-family)',
            lineHeight: 1.5,
          },
        }, renderCard(tip));
      }

      ctx.effect(() =>
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'git-blame-hover' }, Overlay)));

      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.tab.document.actions', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.document.actions', id: 'git-blame-toggle', order: 40 },
            BlameToggle,
          )));

      // Shortcut command (Option 1: registered unbound; users assign a key in Settings).
      let shortcuts;
      try {
        shortcuts = ctx.shortcuts;
      } catch (_error) {
        shortcuts = undefined;
      }
      if (shortcuts && typeof shortcuts.register === 'function') {
        ctx.effect(() => {
          let disposeCommand;
          try {
            disposeCommand = shortcuts.register({
              id: SHORTCUT_COMMAND_ID,
              label: () => '显示/关闭 Git Blame 气泡',
              regions: ['page'],
              modals: [],
              defaults: {},
              resolve: () => ({ status: 'handled', run: () => setEnabled(!isEnabled()) }),
            });
          } catch (_error) {
            return undefined;
          }
          const catalog = shortcuts.catalog;
          const sync = () => {
            try {
              const rows = catalog && typeof catalog.getSnapshot === 'function' ? catalog.getSnapshot() : [];
              const row = Array.isArray(rows) ? rows.find((candidate) => candidate.id === SHORTCUT_COMMAND_ID) : undefined;
              setShortcutHint(row ? { keys: Array.isArray(row.keys) ? row.keys : [], aria: row.aria } : { keys: [], aria: undefined });
            } catch (_error) {
              setShortcutHint({ keys: [], aria: undefined });
            }
          };
          const disposeSubscribe = catalog && typeof catalog.subscribe === 'function' ? catalog.subscribe(sync) : () => {};
          sync();
          return () => {
            disposeSubscribe();
            setShortcutHint({ keys: [], aria: undefined });
            if (disposeCommand) disposeCommand();
          };
        });
      }
    }

    return {
      inject: ['slots', 'shortcuts'],
      apply,
    };
  },
});
