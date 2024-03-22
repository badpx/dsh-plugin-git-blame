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
  id: '@local/dsh-git-blame-hover',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const FILE_PREFIX = 'dsh-resource://file/';
    const FETCH_DELAY_MS = 110;
    const DWELL_DELAY_MS = 500;
    const LEAVE_DELAY_MS = 500;
    const CARD_WIDTH = 360;

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

    function buildUrl(sessionId, filePath, line) {
      const url = new URL('plugin/git-blame', document.baseURI);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('path', filePath);
      url.searchParams.set('line', String(line));
      return url.href;
    }

    /** The floating card content. */
    function renderCard(tip) {
      const body = { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 };

      if (tip.status === 'loading') {
        return h('div', { style: body },
          h('div', { style: { fontWeight: 600, fontSize: '12px' } }, 'Reading git blame…'),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } }, `line ${tip.line}`));
      }

      if (tip.status === 'error') {
        return h('div', { style: body },
          h('div', { style: { fontWeight: 600, fontSize: '12px' } }, 'Git blame unavailable'),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', whiteSpace: 'normal' } },
            tip.message || 'Unknown error'));
      }

      const data = tip.data || {};
      const sha = h('span', {
        style: {
          fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
          fontSize: '11px',
          color: 'var(--dsw-alias-label-tertiary)',
        },
      }, data.shortSha || '');

      const author = h('span', {
        title: data.authorMail || undefined,
        style: { fontWeight: 600, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, data.author || 'Unknown author');

      const meta = h('div', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', minWidth: 0 },
      },
      sha,
      h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' } }, data.date || ''),
      data.uncommitted
        ? h('span', {
          style: {
            fontSize: '10px',
            padding: '0 5px',
            borderRadius: 'var(--dsw-radius-sm)',
            background: 'var(--dsw-alias-state-warn-tertiary)',
            color: 'var(--dsw-alias-state-warn-label)',
          },
        }, 'uncommitted')
        : null);

      return h('div', { style: body },
        meta,
        author,
        data.summary
          ? h('div', {
            title: data.summary,
            style: {
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '11px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, data.summary)
          : null,
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px' } }, `line ${tip.line}`));
    }

    function apply(ctx) {
      function Overlay() {
        const [tip, setTip] = React.useState(null);
        const tipRef = React.useRef(null);
        const cacheRef = React.useRef(new Map());
        const timerRef = React.useRef(0);
        const seqRef = React.useRef(0);
        const lastKeyRef = React.useRef('');

        React.useEffect(() => {
          const publish = (next) => {
            tipRef.current = next;
            setTip(next);
          };

          let hideTimer = 0;
          let dwellTimer = 0;
          let dwellKey = '';
          let dwellFile = null;
          let dwellLine = 0;
          let dwellX = 0;
          let dwellY = 0;

          const clearDwell = () => {
            clearTimeout(dwellTimer);
            dwellTimer = 0;
            dwellKey = '';
          };

          const hide = () => {
            clearTimeout(hideTimer);
            hideTimer = 0;
            clearDwell();
            clearTimeout(timerRef.current);
            if (tipRef.current !== null) {
              lastKeyRef.current = '';
              publish(null);
            }
          };

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

          const fetchBlame = (key, file, line) => {
            const seq = ++seqRef.current;
            fetch(buildUrl(file.sessionId, file.path, line), {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
              .then((response) => response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` })))
              .then((data) => {
                if (seq !== seqRef.current) return;
                if (!tipRef.current || tipRef.current.key !== key) return;
                if (data && data.ok) cacheRef.current.set(key, data);
                publish({
                  ...tipRef.current,
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

          const showLine = (key, file, line, x, y) => {
            const cached = cacheRef.current.get(key);
            if (cached) {
              publish({ key, x, y, line, status: 'ok', data: cached });
              return;
            }
            publish({ key, x, y, line, status: 'loading' });
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              if (tipRef.current && tipRef.current.key === key) fetchBlame(key, file, line);
            }, FETCH_DELAY_MS);
          };

          const process = (x, y, target) => {
            if (!(target instanceof Element)) {
              clearDwell();
              scheduleHide();
              return;
            }
            // Leaving the right-sidebar column hides the bubble after LEAVE_DELAY_MS.
            if (!target.closest('[data-sidebar-right-session]')) {
              clearDwell();
              scheduleHide();
              return;
            }
            cancelHide();

            const line = lineAt(target);
            const file = line === undefined ? undefined : fileAt(target);
            if (line === undefined || !file) {
              // Inside the sidebar but not on a blamable line: stop a pending dwell and
              // keep any already-visible bubble where it is.
              clearDwell();
              return;
            }

            const key = `${file.contentId}#${line}`;
            const current = tipRef.current;
            if (current && current.key === key) {
              if (current.x !== x || current.y !== y) publish({ ...current, x, y });
              return;
            }

            if (current) {
              // Already visible: follow the pointer onto the next line immediately.
              clearDwell();
              showLine(key, file, line, x, y);
              return;
            }

            // Not visible yet: require a DWELL_DELAY_MS rest on this line before showing.
            if (dwellKey !== key) {
              clearDwell();
              dwellKey = key;
            }
            dwellFile = file;
            dwellLine = line;
            dwellX = x;
            dwellY = y;
            if (dwellTimer === 0) {
              dwellTimer = setTimeout(() => {
                dwellTimer = 0;
                const pendingKey = dwellKey;
                if (pendingKey === '' || !dwellFile) return;
                const shown = tipRef.current;
                if (shown && shown.key === pendingKey) return;
                showLine(pendingKey, dwellFile, dwellLine, dwellX, dwellY);
                dwellKey = '';
              }, DWELL_DELAY_MS);
            }
          };

          let lastMoveAt = 0;
          const onMove = (event) => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now - lastMoveAt < 16) return;
            lastMoveAt = now;
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
            clearDwell();
            clearTimeout(timerRef.current);
          };
        }, []);

        if (tip === null) return null;

        const viewportWidth = window.innerWidth || 1280;
        const viewportHeight = window.innerHeight || 800;
        const left = Math.max(8, Math.min(tip.x + 16, viewportWidth - CARD_WIDTH - 8));
        const top = tip.y + 18 + 110 > viewportHeight ? Math.max(8, tip.y - 110 - 10) : tip.y + 18;

        return h('div', {
          'data-git-blame-card': true,
          style: {
            position: 'fixed',
            left: `${left}px`,
            top: `${top}px`,
            width: `${CARD_WIDTH}px`,
            boxSizing: 'border-box',
            padding: '8px 10px',
            pointerEvents: 'none',
            zIndex: 2147483000,
            opacity: 0.94,
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
    }

    return {
      inject: ['slots'],
      apply,
    };
  },
});
