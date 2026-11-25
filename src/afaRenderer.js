'use strict';

function installAfaDesktopRenderer() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__ANTIGRAVITY_FILE_ACTIONS_INJECTED__) return;
  window.__ANTIGRAVITY_FILE_ACTIONS_INJECTED__ = true;

  const { ipcRenderer } = require('electron');
  const INITIAL_SEARCH = window.location ? (window.location.search || '') : '';

  const DANGEROUS_EXTS = new Set([
    '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse',
    '.wsf', '.msi', '.scr', '.hta', '.com', '.pif', '.reg', '.msc', '.jar'
  ]);

  const NON_FILE_SCHEMES = new Set([
    'http', 'https', 'mailto', 'ftp', 'ws', 'wss', 'data', 'blob',
    'javascript', 'about', 'command', 'vscode', 'antigravity', 'antigravity-ide',
    'conversation', 'customization', 'sidecar', 'recipe', 'terminal',
    'ai-context-provider', 'browserpage', 'slashcommand', 'rule',
    'mcpresource', 'mcpprompt', 'knowledge', 'domelement', 'consolelog',
    'browsertext', 'browsercodeblock', 'useractivity', 'slack', 'github',
    'repository', 'cci', 'repositorypath', 'jira', 'label', 'icon'
  ]);

  const CODE_FALSE_POSITIVES = new Set([
    'console.log', 'console.error', 'console.warn', 'console.info', 'console.debug',
    'window.location', 'window.vscode', 'window.document', 'document.body',
    'document.createelement', 'object.keys', 'object.values', 'object.entries',
    'object.assign', 'json.parse', 'json.stringify', 'promise.all', 'promise.resolve',
    'math.max', 'math.min', 'math.floor', 'math.round', 'array.from', 'array.isarray',
    'process.env', 'process.platform', 'process.cwd', 'module.exports', 'exports.default',
    'vscode.window', 'vscode.workspace', 'vscode.commands', 'vscode.uri', 'vscode.env',
    'event.target', 'event.preventdefault', 'event.stoppropagation', 'e.target',
    'e.preventdefault', 'e.stoppropagation', 'req.body', 'res.json', 'res.status'
  ]);

  const COMMON_FILE_EXTS = new Set([
    '.md', '.txt', '.json', '.jsonc', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.php', '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.astro',
    '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.svg',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.docx',
    '.xlsx', '.pptx', '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ps1',
    '.bat', '.cmd', '.vbs', '.exe', '.msi', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.vsix', '.log', '.lock', '.gitignore', '.npmrc', '.editorconfig', '.dockerfile',
    '.mp3', '.wav', '.mp4', '.mov', '.webm', '.srt', '.vtt', '.ass'
  ]);

  const KNOWN_BARE_FILENAMES = new Set([
    'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'authors',
    'notice', 'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'cmakelists.txt'
  ]);

  // ---------------------------------------------------------------------------
  // 1. Workspace Discovery in Antigravity Desktop
  // ---------------------------------------------------------------------------
  function safeDecodeUriPath(str) {
    if (!str) return '';
    try {
      return decodeURIComponent(str);
    } catch (_) {
      return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
        try { return decodeURIComponent(match); } catch (__) { return match; }
      });
    }
  }

  function normalizeWinPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return '';
    let s = inputPath.trim().replace(/\//g, '\\');
    if (/^[a-z]:\\/.test(s)) {
      s = s[0].toUpperCase() + s.slice(1);
    }
    const isUnc = s.startsWith('\\\\');
    const prefix = isUnc ? '\\\\' : '';
    const parts = s.split(/\\+/);
    const stack = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length > 1 || (stack.length === 1 && !/^[a-zA-Z]:$/.test(stack[0]))) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }
    let out = prefix + stack.join('\\');
    if (/^[a-zA-Z]:$/.test(out)) out += '\\';
    return out;
  }

  function uriToWinPath(uriStr) {
    if (!uriStr || typeof uriStr !== 'string') return '';
    const s = uriStr.trim();
    if (!/^file:\/\//i.test(s) && !/^vscode-remote:\/\//i.test(s)) return s;
    let p = s.replace(/^(?:file|vscode-remote):\/\/\/?/i, '');
    p = safeDecodeUriPath(p);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return normalizeWinPath(p);
  }

  function getWindowWorkspaceHints() {
    const hints = [];
    const addHint = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const p = /^file:\/\//i.test(raw) ? uriToWinPath(raw) : normalizeWinPath(raw);
      if (p && /^[a-zA-Z]:\\/.test(p) && !hints.includes(p)) {
        hints.push(p);
      }
    };
    try {
      const curWs = new URLSearchParams(window.location.search || '').get('workspaceUri');
      if (curWs) addHint(curWs);
      const initWs = new URLSearchParams(INITIAL_SEARCH).get('workspaceUri');
      if (initWs) addHint(initWs);
      // Inspect visible FilePill / anchor URIs on page to infer active workspace root if needed
      const activePill = document.querySelector('[data-workspace-root], [data-project-path]');
      if (activePill) {
        addHint(activePill.getAttribute('data-workspace-root') || activePill.getAttribute('data-project-path'));
      }
    } catch (_) { }
    return hints;
  }

  // ---------------------------------------------------------------------------
  // 2. Path Parsing & Classification
  // ---------------------------------------------------------------------------
  function stripLineAndColSuffix(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim();
    s = s.replace(/#(?:L?\d+(?:[-:–]L?\d+)?|\d+)$/i, '');
    s = s.replace(/\?[^\\/\r\n]+$/, '');
    const match = /^(.*?)((?::\d+){1,2})$/.exec(s);
    if (match && match[1].length > 2) {
      s = match[1];
    }
    const parenMatch = /^(.*?\.[a-zA-Z0-9]{1,10})\(\d+(?:,\s*\d+)?\)$/.exec(s);
    if (parenMatch) {
      s = parenMatch[1];
    }
    return s.trim();
  }

  function cleanRawInput(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim();
    s = s.replace(/^`+|`+$/g, '').replace(/^['"]+|['"]+$/g, '').trim();
    const md = /^\[[^\]]*\]\((.+)\)$/.exec(s);
    if (md) s = md[1].trim().replace(/^<|>$/g, '');
    return s;
  }

  function getExtension(filePath) {
    if (!filePath) return '';
    const base = filePath.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return '';
    return base.slice(dot).toLowerCase();
  }

  function isDangerousFile(filePath) {
    return DANGEROUS_EXTS.has(getExtension(filePath));
  }

  function parseLocalPathCandidate(rawInput, sourceType) {
    const cleaned = cleanRawInput(rawInput);
    if (!cleaned || cleaned.length > 1024 || /[\r\n\0]/.test(cleaned)) return null;

    const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (scheme.length === 1 && /^[a-zA-Z]:[\\/]/.test(cleaned)) {
        // Windows drive letter
      } else if (scheme === 'file' || scheme === 'vscode-remote') {
        const stripped = stripLineAndColSuffix(cleaned);
        const winPath = uriToWinPath(stripped);
        if (!winPath || !/^(?:[a-zA-Z]:\\|\\\\)/.test(winPath)) return null;
        return {
          kind: 'file-uri',
          rawPath: cleaned,
          normalizedPath: winPath,
          isAbsolute: true
        };
      } else if (NON_FILE_SCHEMES.has(scheme) || cleaned.includes('://')) {
        return null;
      }
    }

    const stripped = stripLineAndColSuffix(cleaned);
    if (!stripped) return null;

    // 1. Windows Absolute Path
    if (/^[a-zA-Z]:[\\/]/.test(stripped)) {
      const afterDrive = stripped.slice(2);
      if (/[<>:"|?*]/.test(afterDrive)) return null;
      return {
        kind: 'win-abs',
        rawPath: stripped,
        normalizedPath: normalizeWinPath(stripped),
        isAbsolute: true
      };
    }

    // 2. UNC path
    if (/^\\\\[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+/.test(stripped)) {
      return {
        kind: 'win-abs',
        rawPath: stripped,
        normalizedPath: normalizeWinPath(stripped),
        isAbsolute: true
      };
    }

    if (sourceType === 'plain-text') {
      return null;
    }

    if (/[<>:"|?*]/.test(stripped)) return null;
    if (CODE_FALSE_POSITIVES.has(stripped.toLowerCase())) return null;

    // 3. Relative path containing directory separator
    if (/[\\/]/.test(stripped) && !stripped.startsWith('//')) {
      if (/\s[\\/]\s/.test(stripped) || /^\/[a-zA-Z0-9_-]+$/.test(stripped)) return null;
      const segments = stripped.split(/[\\/]+/).filter(Boolean);
      if (segments.length === 0) return null;
      const lastSeg = segments[segments.length - 1];
      const ext = getExtension(lastSeg);
      const isExplicitRel = stripped.startsWith('./') || stripped.startsWith('.\\') || stripped.startsWith('../') || stripped.startsWith('..\\');
      if (isExplicitRel || COMMON_FILE_EXTS.has(ext) || KNOWN_BARE_FILENAMES.has(lastSeg.toLowerCase()) || sourceType === 'data-uri' || sourceType === 'anchor') {
        const hints = getWindowWorkspaceHints();
        const fallbackAbs = hints.length > 0 ? normalizeWinPath(hints[0] + '\\' + stripped) : stripped;
        return {
          kind: 'rel-path',
          rawPath: stripped,
          normalizedPath: fallbackAbs,
          isAbsolute: false
        };
      }
    }

    // 4. Bare filename
    if (!/\s/.test(stripped) && /^[\w\u4e00-\u9fa5.@()-]+$/.test(stripped)) {
      const ext = getExtension(stripped);
      const lower = stripped.toLowerCase();
      if (/^v?\d+(?:\.\d+)+$/i.test(stripped)) return null;
      if (COMMON_FILE_EXTS.has(ext) || KNOWN_BARE_FILENAMES.has(lower)) {
        const hints = getWindowWorkspaceHints();
        const fallbackAbs = hints.length > 0 ? normalizeWinPath(hints[0] + '\\' + stripped) : stripped;
        return {
          kind: 'bare-file',
          rawPath: stripped,
          normalizedPath: fallbackAbs,
          isAbsolute: false
        };
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // 3. Antigravity Desktop Chat Surface Detection & DOM Target Extraction
  // ---------------------------------------------------------------------------
  function isInAgentChatArea(target) {
    if (!target || typeof target.closest !== 'function') return false;

    if (target.closest('#afa-context-menu, #afa-confirm-modal, #afa-toast-container')) return false;
    if (target.closest('.monaco-editor, .cm-editor, .xterm')) return false;

    if (target.closest('input, textarea, [contenteditable="true"]') && !target.closest('[data-uri]')) {
      return false;
    }

    return true;
  }

  function extractPathAtPoint(clientX, clientY) {
    if (typeof document.caretRangeFromPoint !== 'function') return null;
    let range;
    try {
      range = document.caretRangeFromPoint(clientX, clientY);
    } catch (_) {
      return null;
    }
    if (!range || range.startContainer.nodeType !== 3) return null;
    const textNode = range.startContainer;
    const text = textNode.textContent || '';
    const offset = range.startOffset;
    if (!text.trim()) return null;

    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);
    const rects = Array.from(nodeRange.getClientRects());
    const insideRect = rects.some(r =>
      clientX >= r.left - 4 && clientX <= r.right + 4 &&
      clientY >= r.top - 4 && clientY <= r.bottom + 4
    );
    if (!insideRect) return null;

    const patterns = [
      /file:\/\/\/[^\s"'<>()`]+/gi,
      /[a-zA-Z]:[\\/][^\s"'<>|?*`]+/g
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        let matched = m[0];
        matched = matched.replace(/[.,;，。、！）\]>]+$/, '');
        const end = start + matched.length;
        if (offset >= start && offset <= end) {
          return parseLocalPathCandidate(matched, 'plain-text');
        }
      }
    }
    return null;
  }

  function findFileTargetFromEvent(event) {
    const rawTarget = event.target;
    const target = rawTarget && typeof rawTarget.closest === 'function'
      ? rawTarget
      : (rawTarget && rawTarget.parentElement && typeof rawTarget.parentElement.closest === 'function'
        ? rawTarget.parentElement
        : null);
    if (!target) return null;
    if (!isInAgentChatArea(target)) return null;

    // 1. Check Antigravity FilePill ([data-uri])
    const pill = target.closest('[data-uri]');
    if (pill) {
      const dataUri = pill.getAttribute('data-uri') || '';
      const titleAttr = pill.getAttribute('title') || '';
      const parsedUri = parseLocalPathCandidate(dataUri, 'data-uri');
      if (parsedUri) return { ...parsedUri, element: pill };
      const parsedTitle = parseLocalPathCandidate(titleAttr, 'data-uri');
      if (parsedTitle) return { ...parsedTitle, element: pill };
      return null;
    }

    // 2. Check standard <a href="...">
    const anchor = target.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      const parsedHref = parseLocalPathCandidate(href, 'anchor');
      if (parsedHref) return { ...parsedHref, element: anchor };
      const textCand = parseLocalPathCandidate(anchor.textContent || '', 'anchor');
      if (textCand && textCand.isAbsolute) return { ...textCand, element: anchor };
      return null;
    }

    // 3. Check inline <code> (or single-line <pre><code>)
    const codeEl = target.closest('code');
    if (codeEl) {
      if (codeEl.dataset.afaExists === 'false') return null;
      if (codeEl.dataset.afaResolvedPath && codeEl.dataset.afaExists === 'true') {
        return {
          kind: 'cached-code',
          rawPath: (codeEl.textContent || '').trim(),
          normalizedPath: codeEl.dataset.afaResolvedPath,
          isAbsolute: true,
          element: codeEl
        };
      }
      const inPre = Boolean(codeEl.closest('pre'));
      const rawCode = (codeEl.textContent || '').trim();
      if (!inPre || !rawCode.includes('\n')) {
        const parsedCode = parseLocalPathCandidate(rawCode, 'code');
        if (parsedCode) {
          if (!parsedCode.isAbsolute) {
            const syncRes = resolveViaIpcSync(parsedCode.rawPath);
            if (syncRes && syncRes.ok) {
              if (!syncRes.exists && parsedCode.kind === 'bare-file') {
                codeEl.dataset.afaExists = 'false';
                return null;
              }
              if (syncRes.resolvedPath) {
                parsedCode.normalizedPath = syncRes.resolvedPath;
              }
            }
          }
          return { ...parsedCode, element: codeEl };
        }
      }
      const pointCand = extractPathAtPoint(event.clientX, event.clientY);
      if (pointCand) return { ...pointCand, element: codeEl };
      return null;
    }

    // 4. Check active text selection if it is a file path
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const selText = sel.toString().trim();
      const parsedSel = parseLocalPathCandidate(selText, 'plain-text');
      if (parsedSel) return { ...parsedSel, element: target };
    }

    // 5. Check plain text node directly under cursor inside chat / markdown output
    if (target.closest('[data-markdown-root], .md-divider-spacing, article, main, [class*="markdown"], [class*="prose"]')) {
      const pointCand = extractPathAtPoint(event.clientX, event.clientY);
      if (pointCand) return { ...pointCand, element: target };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // 4. Electron IPC Communication
  // ---------------------------------------------------------------------------
  function resolveViaIpcSync(rawPath) {
    try {
      return ipcRenderer.sendSync('afa:resolve-sync', {
        rawPath,
        workspaceHints: getWindowWorkspaceHints()
      });
    } catch (_) {
      return null;
    }
  }

  async function callIpcAsync(channel, payload) {
    try {
      return await ipcRenderer.invoke(channel, {
        ...payload,
        workspaceHints: getWindowWorkspaceHints()
      });
    } catch (_) {
      return null;
    }
  }

  // Hover pre-resolution on inline <code> inside AI chat
  window.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const codeEl = target.closest('code:not(pre code)');
    if (!codeEl || codeEl.dataset.afaChecked === 'true') return;
    if (codeEl.closest('.monaco-editor, .cm-editor, .xterm')) return;
    codeEl.dataset.afaChecked = 'true';

    const rawText = (codeEl.textContent || '').trim();
    const cand = parseLocalPathCandidate(rawText, 'code');
    if (!cand) {
      codeEl.dataset.afaExists = 'false';
      return;
    }
    if (cand.isAbsolute) {
      codeEl.dataset.afaResolvedPath = cand.normalizedPath;
      codeEl.dataset.afaExists = 'true';
      codeEl.dataset.afaFileLink = 'true';
    }
    callIpcAsync('afa:resolve', { rawPath: cand.rawPath }).then((res) => {
      if (!res || !res.ok) return;
      if (res.resolvedPath) {
        codeEl.dataset.afaResolvedPath = res.resolvedPath;
      }
      if (cand.isAbsolute || res.exists) {
        codeEl.dataset.afaExists = 'true';
        codeEl.dataset.afaFileLink = 'true';
      } else {
        codeEl.dataset.afaExists = 'false';
        delete codeEl.dataset.afaFileLink;
      }
    });
  }, true);

  // ---------------------------------------------------------------------------
  // 5. Styles, Toast, Confirmation Modal & Context Menu UI (Trusted-Types Safe)
  // ---------------------------------------------------------------------------
  function ensureStyles() {
    if (document.getElementById('afa-injected-styles')) return;
    const style = document.createElement('style');
    style.id = 'afa-injected-styles';
    style.textContent = `
      code[data-afa-file-link="true"] {
        cursor: pointer;
        text-decoration: underline;
        text-decoration-color: rgba(120, 160, 255, 0.45);
        text-underline-offset: 3px;
        transition: background-color 120ms ease, text-decoration-color 120ms ease;
      }
      code[data-afa-file-link="true"]:hover {
        text-decoration-color: rgba(120, 160, 255, 0.9);
      }
      #afa-context-menu {
        position: fixed;
        z-index: 2147483640;
        min-width: 224px;
        max-width: 340px;
        padding: 4px;
        border-radius: 10px;
        background: var(--card, var(--popover, #1e1e22));
        color: var(--foreground, var(--popover-foreground, #e4e4e7));
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.25);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
        backdrop-filter: blur(12px);
        animation: afaMenuFadeIn 110ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      @media (prefers-color-scheme: light) {
        #afa-context-menu, .afa-toast, .afa-modal-card {
          background: var(--card, var(--popover, #ffffff));
          color: var(--foreground, var(--popover-foreground, #18181b));
          border-color: var(--border, rgba(0, 0, 0, 0.12));
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
        }
      }
      @keyframes afaMenuFadeIn {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
      .afa-menu-header {
        padding: 5px 10px 4px;
        font-size: 11px;
        color: var(--muted-foreground, #8e8e93);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        margin-bottom: 3px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      }
      .afa-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        background: transparent;
        color: inherit;
        font-size: 13px;
        text-align: left;
        border-radius: 6px;
        cursor: pointer;
        outline: none;
        box-sizing: border-box;
        transition: background-color 80ms ease, color 80ms ease;
      }
      .afa-menu-item:hover,
      .afa-menu-item:focus,
      .afa-menu-item.afa-active {
        background: var(--secondary, var(--accent, rgba(128, 128, 128, 0.16)));
        color: var(--foreground, inherit);
      }
      .afa-menu-icon {
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        opacity: 0.85;
      }
      .afa-menu-sep {
        height: 1px;
        margin: 3px 4px;
        background: var(--border, rgba(128, 128, 128, 0.18));
      }
      #afa-toast-container {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483645;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .afa-toast {
        pointer-events: auto;
        max-width: 380px;
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--card, #252529);
        color: var(--foreground, #f2f2f7);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        font-size: 12.5px;
        line-height: 1.4;
        word-break: break-all;
        animation: afaMenuFadeIn 140ms ease-out;
      }
      .afa-toast-error {
        border-color: rgba(239, 68, 68, 0.55);
      }
      #afa-confirm-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .afa-modal-card {
        width: 100%;
        max-width: 400px;
        padding: 16px;
        border-radius: 12px;
        background: var(--card, #1e1e22);
        color: var(--foreground, #e4e4e7);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
        font-size: 13px;
      }
      .afa-modal-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
      }
      .afa-modal-desc {
        color: var(--muted-foreground, #a1a1aa);
        line-height: 1.5;
        word-break: break-all;
        white-space: pre-wrap;
        margin-bottom: 14px;
      }
      .afa-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .afa-btn {
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12.5px;
        cursor: pointer;
        border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
        background: transparent;
        color: inherit;
      }
      .afa-btn-danger {
        background: #dc2626;
        border-color: #dc2626;
        color: #ffffff;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createSvgIcon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'afa-menu-icon');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function showToast(message, isError) {
    ensureStyles();
    let container = document.getElementById('afa-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'afa-toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'afa-toast' + (isError ? ' afa-toast-error' : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 2800);
  }

  function showDangerousFileConfirm(filePath) {
    ensureStyles();
    return new Promise((resolve) => {
      const existing = document.getElementById('afa-confirm-modal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'afa-confirm-modal';

      const card = document.createElement('div');
      card.className = 'afa-modal-card';

      const title = document.createElement('div');
      title.className = 'afa-modal-title';
      title.textContent = '安全确认：可执行文件或脚本';

      const fileName = filePath.split(/[\\/]/).pop() || filePath;
      const desc = document.createElement('div');
      desc.className = 'afa-modal-desc';
      desc.textContent = `打开 "${fileName}" 可能会直接运行程序或脚本。\n路径：${filePath}\n确定要继续使用系统默认程序打开吗？`;

      const actions = document.createElement('div');
      actions.className = 'afa-modal-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'afa-btn';
      cancelBtn.textContent = '取消';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'afa-btn afa-btn-danger';
      confirmBtn.textContent = '继续打开';

      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => cleanup(false));
      confirmBtn.addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(false);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      cancelBtn.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Action Execution
  // ---------------------------------------------------------------------------
  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { }
    ta.remove();
    return ok;
  }

  async function executeFileAction(action, targetInfo) {
    let resolvedPath = targetInfo.normalizedPath || targetInfo.rawPath;
    const res = await callIpcAsync('afa:resolve', { rawPath: targetInfo.rawPath });
    if (res && res.ok && res.resolvedPath) {
      resolvedPath = res.resolvedPath;
    }

    if (action === 'copyPath') {
      await copyTextToClipboard(resolvedPath);
      await callIpcAsync('afa:action', { action: 'copyPath', rawPath: resolvedPath });
      showToast(`已复制绝对路径：${resolvedPath}`, false);
      return;
    }

    let confirmed = false;
    if (action === 'open' && isDangerousFile(resolvedPath)) {
      confirmed = await showDangerousFileConfirm(resolvedPath);
      if (!confirmed) return;
    }

    const actionRes = await callIpcAsync('afa:action', {
      action,
      rawPath: targetInfo.rawPath,
      resolvedPath,
      confirmed
    });

    if (!actionRes || !actionRes.ok) {
      if (actionRes && actionRes.cancelled) return;
      showToast((actionRes && actionRes.error) || `操作失败：${resolvedPath}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Context Menu Lifecycle
  // ---------------------------------------------------------------------------
  let currentMenu = null;

  function closeContextMenu() {
    if (currentMenu) {
      currentMenu.remove();
      currentMenu = null;
    }
  }

  function showFileContextMenu(x, y, targetInfo) {
    ensureStyles();
    closeContextMenu();

    const menu = document.createElement('div');
    menu.id = 'afa-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-afa-target-path', targetInfo.normalizedPath || targetInfo.rawPath);
    for (const evtName of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'contextmenu']) {
      menu.addEventListener(evtName, (e) => {
        if (evtName === 'contextmenu') e.preventDefault();
        e.stopPropagation();
      });
    }

    const displayPath = targetInfo.normalizedPath || targetInfo.rawPath;
    const fileName = displayPath.split(/[\\/]/).pop() || displayPath;
    const header = document.createElement('div');
    header.className = 'afa-menu-header';
    header.textContent = fileName;
    header.title = displayPath;
    menu.appendChild(header);

    const itemsConfig = [
      {
        id: 'open',
        label: '使用系统默认程序打开',
        iconPaths: ['M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9', 'M10 2h4v4', 'M14 2 7.5 8.5']
      },
      {
        id: 'reveal',
        label: '在 Windows 资源管理器中显示',
        iconPaths: ['M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8Z']
      },
      { type: 'separator' },
      {
        id: 'copyPath',
        label: '复制文件绝对路径',
        iconPaths: ['M5.5 5.5h7a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 13V7a1.5 1.5 0 0 1 1.5-1.5Z', 'M3 10.5H2.5A1.5 1.5 0 0 1 1 9V3a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 10 3v.5']
      }
    ];

    for (const item of itemsConfig) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'afa-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'afa-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-afa-action', item.id);
      btn.appendChild(createSvgIcon(item.iconPaths));

      const span = document.createElement('span');
      span.textContent = item.label;
      btn.appendChild(span);

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        executeFileAction(item.id, targetInfo);
      });

      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    currentMenu = menu;

    const rect = menu.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.min(Math.max(8, x), maxX)}px`;
    menu.style.top = `${Math.min(Math.max(8, y), maxY)}px`;

    if (!targetInfo.isAbsolute) {
      callIpcAsync('afa:resolve', { rawPath: targetInfo.rawPath }).then((res) => {
        if (res && res.ok && res.resolvedPath) {
          targetInfo.normalizedPath = res.resolvedPath;
          header.title = res.resolvedPath;
          menu.setAttribute('data-afa-target-path', res.resolvedPath);
        }
      });
    }
  }

  window.addEventListener('contextmenu', (event) => {
    const targetInfo = findFileTargetFromEvent(event);
    if (!targetInfo) {
      closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showFileContextMenu(event.clientX, event.clientY, targetInfo);
    callIpcAsync('afa:ping', {
      event: 'contextmenu',
      kind: targetInfo.kind,
      rawPath: targetInfo.rawPath,
      normalizedPath: targetInfo.normalizedPath
    });
  }, true);

  callIpcAsync('afa:ping', { event: 'boot' });

  window.addEventListener('mousedown', (event) => {
    if (currentMenu && !currentMenu.contains(event.target)) {
      closeContextMenu();
    }
  }, true);

  window.addEventListener('keydown', (event) => {
    if (!currentMenu) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
    }
  }, true);

  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installAfaDesktopRenderer };
}
