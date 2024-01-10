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

    /** Resolve the previewed file (session + workspace path) from the hovered line. */
    function fileAt(ctx, element) {
      let sidebarRight;
      try {
        sidebarRight = ctx.sidebarRight || (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined);
      } catch (_error) {
        sidebarRight = undefined;
      }
      if (!sidebarRight) return undefined;

      const sessionEl = element.closest('[data-sidebar-right-session]');
      const tabEl = element.closest('[data-sidebar-right-tab]');
      if (!sessionEl) return undefined;
      const sessionId = sessionEl.dataset.sidebarRightSession;
      const tabId = tabEl && tabEl.dataset.sidebarRightTab;
      if (!sessionId) return undefined;

      let tab;
      try {
        const tabs = sidebarRight.tabsIn(sessionId) || [];
        tab = tabId === undefined ? undefined : tabs.find((candidate) => candidate.id === tabId);
      } catch (_error) {
        tab = undefined;
      }
      if (!tab && typeof sidebarRight.active === 'function') {
        try {
          tab = sidebarRight.active();
        } catch (_error) {
          tab = undefined;
        }
      }
      if (!tab || typeof tab.contentId !== 'string') return undefined;

      const parsed = parseFileAddress(tab.contentId);
      if (!parsed || parsed.scope !== 'session') return undefined;
      return { sessionId: parsed.sessionId, path: parsed.path, contentId: tab.contentId };
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
        const rafRef = React.useRef(0);
        const timerRef = React.useRef(0);
        const seqRef = React.useRef(0);
        const lastKeyRef = React.useRef('');

        React.useEffect(() => {
          const publish = (next) => {
            tipRef.current = next;
            setTip(next);
          };

          const hide = () => {
            clearTimeout(timerRef.current);
            if (tipRef.current !== null) {
              lastKeyRef.current = '';
              publish(null);
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

          const process = (x, y, target) => {
            if (!(target instanceof Element)) {
              hide();
              return;
            }
            const line = lineAt(target);
            if (line === undefined) {
              hide();
              return;
            }
            const file = fileAt(ctx, target);
            if (!file) {
              hide();
              return;
            }
            const key = `${file.contentId}#${line}`;
            const current = tipRef.current;

            if (current && current.key === key) {
              if (current.x !== x || current.y !== y) publish({ ...current, x, y });
              return;
            }

            lastKeyRef.current = key;
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

          const onPointerMove = (event) => {
            const x = event.clientX;
            const y = event.clientY;
            const target = event.target;
            if (rafRef.current !== 0) return;
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = 0;
              process(x, y, target);
            });
          };

          const onScroll = () => hide();
          const onKeyDown = (event) => {
            if (event.key === 'Escape') hide();
          };

          document.addEventListener('pointermove', onPointerMove, { passive: true });
          document.addEventListener('scroll', onScroll, true);
          document.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('blur', hide);

          return () => {
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', hide);
            if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current);
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
