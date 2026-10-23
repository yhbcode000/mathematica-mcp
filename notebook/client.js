/**
 * dsh-mathematica-notebook — browser half.
 *
 * The right-sidebar Mathematica notebook: a dock tab type + guide entry (page
 * kind) and a file-resource type for `*.nb` addresses, both rendered by the
 * same notebook view. The view calls the plugin's authenticated Host RPC
 * channel (`/mathematica-notebook`) through `ctx.connection.rpc.call`; the wire
 * contract lives in ./CONTRACT.md.
 *
 * This file is a hand-written browser bundle in the shape the DSH client module
 * system expects: `window.__ModuleLoader__.load({ id, factory })`, the platform
 * `react` module only, no JSX, and every registration owned by a `ctx.effect`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mathematica-notebook',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /** Locale namespace of every visible string in this bundle. */
    const NS = 'dshMathematicaNotebook';
    /** Page tab type: opened by kind from the guide card. */
    const PAGE_ID = 'dsh-mathematica-notebook/page';
    const PAGE_KIND = 'mathematica-notebook';
    /** File tab type: claims `.nb` resources in the right sidebar. */
    const FILE_ID = 'dsh-mathematica-notebook/file';
    const FILE_KIND = 'mathematica-notebook-file';
    /** Authenticated generic-RPC channel mounted by the Host half. */
    const CHANNEL = '/mathematica-notebook';
    /** Auto-save debounce while editing (CONTRACT §3). */
    const SAVE_DEBOUNCE_MS = 1500;
    /** Revision poll interval while the tab is visible (CONTRACT §3). */
    const POLL_MS = 2000;
    /** Our own mutations bump the revision without a payload revision; adopt it silently inside this window. */
    const SELF_MUTATION_WINDOW_MS = 8000;
    /** The `dsh-resource://file/…` address grammar (CONTRACT §7). */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    /** Editor grows to this height before it starts scrolling. */
    const MAX_EDITOR_HEIGHT = 520;

    // ---------------------------------------------------------------------
    // Locale dictionaries
    // ---------------------------------------------------------------------

    /** English dictionary (key-set source of truth). */
    const en = {
      'tab.title': 'Mathematica notebook',
      'guide.title': 'New Mathematica notebook',
      'guide.description': 'Open an interactive Wolfram notebook in the right sidebar',

      'toolbar.runAll': 'Run all',
      'toolbar.save': 'Save',
      'toolbar.restartKernel': 'Restart kernel',
      'toolbar.openInMathematica': 'Open in Mathematica',
      'toolbar.addCode': 'Code cell',
      'toolbar.saveCopy': 'Save a copy',
      'toolbar.retry': 'Retry',
      'toolbar.web': 'Web notebook',
      'toolbar.webHint': 'Full-fidelity WLJS frontend on the local Wolfram kernel',

      'web.starting': 'Starting the web notebook…',
      'web.opened': 'Opened the WLJS web notebook in the browser tab.',
      'web.failed': 'Web notebook unavailable: {message}',

      'status.dirty': 'Unsaved',
      'status.saving': 'Saving…',
      'status.saved': 'Saved',
      'status.readOnly': 'Read-only',
      'status.readOnlyHint':
        'This imported notebook contains elements the editor cannot round-trip. Editing and evaluation are disabled; save a copy to edit it.',
      'status.launched': 'Asked Mathematica to open this notebook.',
      'status.savedAs': 'Saved a copy as {name}.',
      'status.kernelRestarted': 'Wolfram kernel restarted.',
      'status.cellCount': '{count} cells',

      'kernel.label': 'Kernel',
      'kernel.stopped': 'Stopped',
      'kernel.starting': 'Starting',
      'kernel.running': 'Running',
      'kernel.busy': 'Busy',
      'kernel.unavailable': 'Unavailable',
      'kernel.version': 'version {version}',
      'kernel.hint':
        'No Wolfram kernel was detected. Install Mathematica or the Wolfram Engine, then restart the kernel.',

      'state.creating': 'Creating notebook…',
      'state.opening': 'Opening notebook…',
      'state.loadFailed': 'Could not open this notebook',
      'state.retry': 'Retry',
      'state.noAddress': 'This tab has no notebook address.',
      'state.noSession': 'The owning session is unknown. Reopen the notebook tab.',
      'state.crashed': 'The notebook view hit an unexpected error.',
      'state.tryAgain': 'Try again',
      'state.empty': 'No cells yet. Add a code cell to start.',

      'banner.conflictTitle': 'The agent updated this notebook (revision {revision}).',
      'banner.conflictHint': 'Reload to use the hosted version, or keep your local edits and save again.',
      'banner.reload': 'Reload',
      'banner.keepLocal': 'Keep local & save',
      'banner.dismiss': 'Dismiss',
      'banner.saveFailed': 'Saving failed.',
      'banner.retrySave': 'Retry save',

      'saveAs.title': 'Save as a new .nb file',
      'saveAs.namePlaceholder': 'File name (default {name})',
      'saveAs.confirm': 'Save copy',
      'saveAs.cancel': 'Cancel',
      'saveAs.invalid': 'Enter a file name.',

      'cell.run': 'Run this cell (Shift+Enter)',
      'cell.running': 'Running…',
      'cell.moveUp': 'Move cell up',
      'cell.moveDown': 'Move cell down',
      'cell.delete': 'Delete cell',
      'cell.placeholderCode': 'Enter Wolfram Language code…',
      'cell.placeholderText': 'Enter text…',
      'cell.text': 'Text cell',
      'cell.warning': 'Warning',
      'cell.pretty': 'Pretty',
      'cell.raw': 'Raw',
      'cell.outputMode': 'Output view',
      'cell.noText': '(no text form)',
      'cell.svgUnavailable': '(typeset output unavailable)',
      'cell.svgAlt': 'Typeset Wolfram Language output',
      'cell.durationMs': '{ms} ms',
      'cell.durationSec': '{s} s',
      'cell.noCode': 'There are no code cells to run.',

      'footer.shortcuts': 'Shift+Enter run · Ctrl+Enter run · Alt+↑/↓ move between cells',

      'error.pathDenied': 'Access to that path was denied. Notebooks must live in the session working directory or the notebook directory.',
      'error.kernelUnavailable': 'The Wolfram kernel is unavailable. Install Mathematica or the Wolfram Engine, or restart the kernel.',
      'error.kernelTimeout': 'Evaluation timed out.',
      'error.syntaxError': 'Syntax error.',
      'error.evaluationFailed': 'Evaluation failed.',
      'error.launchFailed': 'Could not launch Mathematica.',
      'error.conflict': 'Save conflict: the notebook changed elsewhere.',
      'error.invalidPayload': 'The request was rejected as invalid.',
      'error.unknownEndpoint': 'The plugin halves are out of sync (unknown endpoint).',
      'error.forbidden': 'The request was not authorized.',
      'error.internalError': 'The plugin hit an internal error.',
      'error.transport': 'Could not reach the Host: {message}',
      'error.generic': 'The operation failed.',
      'error.genericWithMessage': 'The operation failed: {message}',
      'error.aborted': 'The operation was cancelled.',
    };

    /** Chinese dictionary, checked complete against the English key set. */
    const zh = {
      'tab.title': 'Mathematica 笔记本',
      'guide.title': '新建 Mathematica 笔记本',
      'guide.description': '在右侧边栏打开一个可交互的 Wolfram 笔记本',

      'toolbar.runAll': '全部运行',
      'toolbar.save': '保存',
      'toolbar.restartKernel': '重启内核',
      'toolbar.openInMathematica': '在 Mathematica 中打开',
      'toolbar.addCode': '代码单元格',
      'toolbar.saveCopy': '另存副本',
      'toolbar.retry': '重试',
      'toolbar.web': '网页笔记本',
      'toolbar.webHint': '完整渲染的 WLJS 前端，运行在本地 Wolfram 内核上',

      'web.starting': '正在启动网页笔记本…',
      'web.opened': '已在右侧浏览器标签页中打开 WLJS 网页笔记本。',
      'web.failed': '网页笔记本不可用：{message}',

      'status.dirty': '未保存',
      'status.saving': '保存中…',
      'status.saved': '已保存',
      'status.readOnly': '只读',
      'status.readOnlyHint': '此导入的笔记本包含编辑器无法无损往返的元素，编辑与计算已停用；可另存副本后再编辑。',
      'status.launched': '已请求在 Mathematica 中打开此笔记本。',
      'status.savedAs': '已另存为 {name}。',
      'status.kernelRestarted': 'Wolfram 内核已重启。',
      'status.cellCount': '{count} 个单元格',

      'kernel.label': '内核',
      'kernel.stopped': '已停止',
      'kernel.starting': '启动中',
      'kernel.running': '运行中',
      'kernel.busy': '计算中',
      'kernel.unavailable': '不可用',
      'kernel.version': '版本 {version}',
      'kernel.hint': '未检测到 Wolfram 内核。请安装 Mathematica 或 Wolfram Engine，然后重启内核。',

      'state.creating': '正在创建笔记本…',
      'state.opening': '正在打开笔记本…',
      'state.loadFailed': '无法打开此笔记本',
      'state.retry': '重试',
      'state.noAddress': '此标签页没有可用的笔记本地址。',
      'state.noSession': '无法确定所属会话，请重新打开笔记本标签页。',
      'state.crashed': '笔记本界面发生了意外错误。',
      'state.tryAgain': '再试一次',
      'state.empty': '还没有单元格。添加一个代码单元格开始。',

      'banner.conflictTitle': '智能体更新了这个笔记本（版本 {revision}）。',
      'banner.conflictHint': '重新加载以使用托管版本，或保留本地修改后再次保存。',
      'banner.reload': '重新加载',
      'banner.keepLocal': '保留本地并保存',
      'banner.dismiss': '忽略',
      'banner.saveFailed': '保存失败。',
      'banner.retrySave': '重试保存',

      'saveAs.title': '另存为新的 .nb 文件',
      'saveAs.namePlaceholder': '文件名（默认 {name}）',
      'saveAs.confirm': '另存',
      'saveAs.cancel': '取消',
      'saveAs.invalid': '请输入文件名。',

      'cell.run': '运行此单元格（Shift+Enter）',
      'cell.running': '运行中…',
      'cell.moveUp': '上移单元格',
      'cell.moveDown': '下移单元格',
      'cell.delete': '删除单元格',
      'cell.placeholderCode': '输入 Wolfram Language 代码…',
      'cell.placeholderText': '输入文本…',
      'cell.text': '文本单元格',
      'cell.warning': '警告',
      'cell.pretty': '排版',
      'cell.raw': '原始',
      'cell.outputMode': '输出视图',
      'cell.noText': '（无文本形式）',
      'cell.svgUnavailable': '（排版输出不可用）',
      'cell.svgAlt': 'Wolfram Language 排版输出',
      'cell.durationMs': '{ms} 毫秒',
      'cell.durationSec': '{s} 秒',
      'cell.noCode': '没有可运行的代码单元格。',

      'footer.shortcuts': 'Shift+Enter 运行 · Ctrl+Enter 运行 · Alt+↑/↓ 切换单元格',

      'error.pathDenied': '路径被拒绝。笔记本必须位于会话工作目录或笔记本目录内。',
      'error.kernelUnavailable': 'Wolfram 内核不可用。请安装 Mathematica 或 Wolfram Engine，或重启内核。',
      'error.kernelTimeout': '计算超时。',
      'error.syntaxError': '语法错误。',
      'error.evaluationFailed': '计算失败。',
      'error.launchFailed': '无法启动 Mathematica。',
      'error.conflict': '保存冲突：笔记本已在别处更新。',
      'error.invalidPayload': '请求内容无效，已被拒绝。',
      'error.unknownEndpoint': '插件两半版本不一致（未知端点）。',
      'error.forbidden': '请求未获授权。',
      'error.internalError': '插件内部错误。',
      'error.transport': '无法连接 Host：{message}',
      'error.generic': '操作失败。',
      'error.genericWithMessage': '操作失败：{message}',
      'error.aborted': '操作已取消。',
    };

    /**
     * Fill `{name}` placeholders. Mirror of the framework's translation seat so
     * the fallback translator (used only before the locale service is ready)
     * behaves the same.
     */
    function interpolate(template, vars) {
      if (vars === undefined || vars === null) return String(template);
      return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
      });
    }

    /** English-only fallback translator for the defensive paths. */
    function fallbackTranslate(key, vars) {
      const template = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : String(key);
      return interpolate(template, vars);
    }

    /** Resolve the slot-provided `t` seat, falling back to the English dictionary. */
    function resolveT(t) {
      return typeof t === 'function' ? t : fallbackTranslate;
    }

    // ---------------------------------------------------------------------
    // Generic helpers
    // ---------------------------------------------------------------------

    function toMessage(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      try {
        return JSON.stringify(error);
      } catch (_error) {
        return String(error);
      }
    }

    /** Normalize an RPC failure (business error or transport rejection) to `{code, message, details}`. */
    function normalizeRpcError(value) {
      if (value && typeof value === 'object') {
        return {
          code: typeof value.code === 'string' ? value.code : 'internal_error',
          message: typeof value.message === 'string' ? value.message : '',
          details: value.details,
        };
      }
      return { code: 'internal_error', message: '' };
    }

    /** Map an arbitrary rejection from the connection to the wire error shape. */
    function rpcFailure(error) {
      if (error && typeof error === 'object' && error.isDSHRemoteError === true && typeof error.code === 'string') {
        return normalizeRpcError(error);
      }
      if (error && typeof error === 'object' && error.name === 'AbortError') {
        return { code: 'aborted', message: toMessage(error) };
      }
      return { code: 'transport_error', message: toMessage(error) };
    }

    /** Localized error line for a contract error code. */
    function errorText(t, error) {
      if (!error || typeof error !== 'object') return t('error.generic');
      switch (error.code) {
        case 'path_denied':
          return t('error.pathDenied');
        case 'kernel_unavailable':
          return t('error.kernelUnavailable');
        case 'kernel_timeout':
          return t('error.kernelTimeout');
        case 'syntax_error':
          return t('error.syntaxError');
        case 'evaluation_failed':
          return t('error.evaluationFailed');
        case 'launch_failed':
          return t('error.launchFailed');
        case 'conflict':
          return t('error.conflict');
        case 'invalid_payload':
          return t('error.invalidPayload');
        case 'unknown_endpoint':
          return t('error.unknownEndpoint');
        case 'forbidden':
          return t('error.forbidden');
        case 'internal_error':
        case 'unavailable':
          return t('error.internalError');
        case 'aborted':
          return t('error.aborted');
        case 'transport_error':
          return t('error.transport', { message: error.message || '' });
        default:
          if (typeof error.message === 'string' && error.message !== '') {
            return t('error.genericWithMessage', { message: error.message });
          }
          return t('error.generic');
      }
    }

    /** The raw diagnostic under a localized error line (empty when there is none). */
    function errorDetail(error) {
      if (!error || typeof error.message !== 'string') return '';
      const message = error.message.trim();
      return message === '' ? '' : message;
    }

    /** `{ ms? }` duration label, or null when unknown. */
    function formatDuration(t, durationMs) {
      if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) return null;
      if (durationMs < 1000) return t('cell.durationMs', { ms: String(Math.round(durationMs)) });
      return t('cell.durationSec', { s: String(Math.round(durationMs / 100) / 10) });
    }

    /** Normalize a Host cell's stored `outputs` array for read-only rendering. */
    function normalizeStoredOutputs(outputs) {
      if (!Array.isArray(outputs)) return [];
      const result = [];
      for (const output of outputs) {
        if (!output || typeof output !== 'object') continue;
        result.push({
          type: typeof output.type === 'string' ? output.type : 'text',
          text: typeof output.text === 'string' ? output.text : null,
        });
      }
      return result;
    }

    /** Normalize Host cells into the local editable shape. */
    function normalizeCells(hostCells) {
      const list = Array.isArray(hostCells) ? hostCells : [];
      return list.map(function (cell) {
        const normalized = {
          id: cell && typeof cell.id === 'string' && cell.id !== '' ? cell.id : nextCellId(list),
          kind: cell && cell.kind === 'text' ? 'text' : 'code',
          code: cell && typeof cell.code === 'string' ? cell.code : '',
          outputs: normalizeStoredOutputs(cell && cell.outputs),
          running: false,
          error: null,
          durationMs: null,
          text: null,
          messages: [],
          svgBytes: null,
        };
        return normalized;
      });
    }

    /** Mint a cell id in the Host's own `c<n>` style, unique within the document. */
    function nextCellId(cells) {
      const used = new Set();
      let max = 0;
      for (const cell of Array.isArray(cells) ? cells : []) {
        if (!cell || typeof cell.id !== 'string') continue;
        used.add(cell.id);
        const match = /^c(\d+)$/.exec(cell.id);
        if (match !== null) max = Math.max(max, Number(match[1]));
      }
      let candidate = 'c' + (max + 1);
      while (used.has(candidate)) {
        max += 1;
        candidate = 'c' + (max + 1);
      }
      return candidate;
    }

    /** The cells payload every save/saveAs call sends (code and text cells only). */
    function serializeCells(cells) {
      return (Array.isArray(cells) ? cells : []).map(function (cell) {
        return {
          id: cell.id,
          kind: cell.kind === 'text' ? 'text' : 'code',
          code: typeof cell.code === 'string' ? cell.code : '',
        };
      });
    }

    /** Normalize evaluate message entries to display strings. */
    function normalizeMessages(messages) {
      if (!Array.isArray(messages)) return [];
      const result = [];
      for (const message of messages) {
        if (typeof message === 'string') {
          if (message !== '') result.push(message);
          continue;
        }
        if (message && typeof message === 'object') {
          if (typeof message.text === 'string' && message.text !== '') result.push(message.text);
          else if (typeof message.message === 'string' && message.message !== '') result.push(message.message);
        }
      }
      return result;
    }

    /**
     * Pull typeset SVG bytes out of one evaluate result cell. The connection's
     * multipart parser replaces the placeholder with a `Uint8Array`; a JSON-only
     * response leaves it null.
     */
    function extractSvgBytes(resultCell) {
      if (!resultCell || typeof resultCell !== 'object') return null;
      const candidates = [resultCell.svg, resultCell.svgBytes];
      for (const candidate of candidates) {
        if (candidate === null || candidate === undefined) continue;
        if (candidate instanceof Uint8Array) return candidate;
        if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate);
        if (ArrayBuffer.isView(candidate)) return new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength);
        if (Array.isArray(candidate) && candidate.length > 8) {
          let numeric = true;
          for (const item of candidate) {
            if (typeof item !== 'number') {
              numeric = false;
              break;
            }
          }
          if (numeric) return Uint8Array.from(candidate);
        }
      }
      if (typeof resultCell.svg === 'string' && /^\s*<svg[\s>]/i.test(resultCell.svg)) {
        try {
          return new TextEncoder().encode(resultCell.svg);
        } catch (_error) {
          return null;
        }
      }
      return null;
    }

    /**
     * Sniff the wire MIME type of one rendered-output attachment. The Host
     * returns typeset SVG for 2D/symbolic results and PNG for 3D Graphics3D
     * results, and both travel as raw bytes with no MIME metadata; the image
     * element must be created with the right type.
     *
     * @param bytes - attachment bytes (a Uint8Array from the connection parser).
     * @returns 'image/png', 'image/svg+xml', or null when the bytes are not a
     *   recognizable image (the caller keeps the text/raw placeholder path).
     */
    function sniffImageMime(bytes) {
      if (bytes === null || bytes === undefined) return null;
      let length = 0;
      try {
        length = bytes.length;
      } catch (_error) {
        return null;
      }
      if (typeof length !== 'number' || length < 4) return null;
      // PNG signature: 0x89 'P' 'N' 'G' followed by CR LF SUB LF.
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
      // Markup sniff: skip an optional BOM and leading ASCII whitespace, then a
      // leading '<' (covers '<svg' and '<?xml'). Fall back to finding '<svg'
      // in the head of the payload for documents with a prolog or comments.
      const limit = Math.min(length, 4096);
      let start = 0;
      while (start < limit) {
        if (bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf) {
          start += 3;
          continue;
        }
        if (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d) {
          start += 1;
          continue;
        }
        break;
      }
      if (start < limit && bytes[start] === 0x3c) return 'image/svg+xml';
      for (let index = 0; index <= limit - 4; index += 1) {
        if (bytes[index] === 0x3c && bytes[index + 1] === 0x73 && bytes[index + 2] === 0x76 && bytes[index + 3] === 0x67) {
          return 'image/svg+xml';
        }
      }
      return null;
    }

    /** Decode one address segment, tolerating hand-edited/legacy addresses. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment);
      } catch (_error) {
        return segment;
      }
    }

    /**
     * Parse a `dsh-resource://file/…` address into `{ scope, sessionId, path }`.
     * Query and fragment suffixes are ignored; returns null for anything else.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return null;
      const cut = address.search(/[?#]/);
      const body = cut === -1 ? address.slice(FILE_ADDRESS_PREFIX.length) : address.slice(FILE_ADDRESS_PREFIX.length, cut);
      if (body === '') return null;
      const parts = body.split('/');
      const scope = parts.shift();
      if (scope === 'session') {
        const rawId = parts.shift();
        if (typeof rawId !== 'string' || rawId === '' || parts.length === 0) return null;
        return { scope: scope, sessionId: decodeSegment(rawId), path: parts.map(decodeSegment).join('/') };
      }
      if (scope === 'absolute') {
        const segments = parts.map(decodeSegment);
        if (segments.length === 0 || segments[0] === '') return null;
        const first = segments[0];
        const path = /^[A-Za-z]:$/.test(first) ? segments.join('/') : '/' + segments.join('/');
        return { scope: scope, sessionId: null, path: path };
      }
      return null;
    }

    /** Decoded last path segment of an address or path; `notebook.nb` when there is none. */
    function basenameOf(address) {
      if (typeof address !== 'string' || address === '') return 'notebook.nb';
      const cut = address.search(/[?#]/);
      const clean = cut === -1 ? address : address.slice(0, cut);
      const name = clean.slice(clean.lastIndexOf('/') + 1);
      if (name === '') return 'notebook.nb';
      return decodeSegment(name);
    }

    /** `name.nb` without its extension. */
    function stemOf(name) {
      return String(name).replace(/\.nb$/i, '');
    }

    /** Whether the pane body is allowed to drive the Host right now. */
    function isContractState(state) {
      return state === 'stopped' || state === 'starting' || state === 'running' || state === 'busy' || state === 'unavailable';
    }

    // ---------------------------------------------------------------------
    // Inline SVG icons (no external asset or icon library)
    // ---------------------------------------------------------------------

    function strokePath(d) {
      return {
        tag: 'path',
        props: {
          d: d,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
      };
    }

    function solidPath(d) {
      return { tag: 'path', props: { d: d, fill: 'currentColor', stroke: 'none' } };
    }

    const ICON_DEFINITIONS = {
      play: [solidPath('M5 3.4 12.2 8 5 12.6Z')],
      save: [
        strokePath('M3 2.8h7.6L12.8 5v8.2H3z'),
        strokePath('M5.4 2.8v3.4h4.4V2.8'),
        strokePath('M5.2 13.2V9.4h5.6v3.8'),
      ],
      restart: [
        strokePath('M3.2 8a4.8 4.8 0 1 0 1.5-3.5'),
        strokePath('M3.2 2.9v3.4h3.4'),
      ],
      external: [
        strokePath('M9.2 3h3.8v3.8'),
        strokePath('M13 3 7.6 8.4'),
        strokePath('M11.2 9.2v3.6H3.2V4.8h3.6'),
      ],
      plus: [strokePath('M8 3.2v9.6'), strokePath('M3.2 8h9.6')],
      chevronUp: [strokePath('M4 10.2 8 6.2 12 10.2')],
      chevronDown: [strokePath('M4 5.8 8 9.8 12 5.8')],
      trash: [
        strokePath('M3 4.4h10'),
        strokePath('M6.2 4.4V2.9h3.6v1.5'),
        strokePath('M4.8 4.4 5.4 13.2h5.2l.6-8.8'),
      ],
      warning: [
        strokePath('M8 2.2 14.4 13.4H1.6Z'),
        strokePath('M8 6.1v3.5'),
        strokePath('M8 11.6h.01'),
      ],
      check: [strokePath('M3.2 8.4 6.4 11.6 12.8 4.6')],
      close: [strokePath('M4 4 12 12'), strokePath('M12 4 4 12')],
      sigma: [strokePath('M4 3.2h8L7.4 8l4.6 4.8H4')],
      globe: [
        strokePath('M8 1.8a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4'),
        strokePath('M1.8 8h12.4'),
        strokePath('M8 1.8c1.8 1.9 2.7 4 2.7 6.2S9.8 12.3 8 14.2C6.2 12.3 5.3 10.2 5.3 8S6.2 3.7 8 1.8'),
      ],
    };

    /** Tiny stroke/fill icon set rendered inline. */
    function SvgIcon(props) {
      const definition = ICON_DEFINITIONS[props.name] || ICON_DEFINITIONS.sigma;
      const size = typeof props.size === 'number' ? props.size : 14;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          className: 'dmn-icon' + (props.className ? ' ' + props.className : ''),
          'aria-hidden': 'true',
          focusable: 'false',
        },
        definition.map(function (shape, index) {
          return h(shape.tag, Object.assign({ key: index }, shape.props));
        }),
      );
    }

    // ---------------------------------------------------------------------
    // Small presentation components
    // ---------------------------------------------------------------------

    const KERNEL_STATES = {
      stopped: 'kernel.stopped',
      starting: 'kernel.starting',
      running: 'kernel.running',
      busy: 'kernel.busy',
      unavailable: 'kernel.unavailable',
    };

    /** Kernel dot + localized state; tooltip carries the detected executable path. */
    function KernelBadge(props) {
      const kernel = props.kernel;
      if (!kernel || typeof kernel !== 'object' || !isContractState(kernel.state)) return null;
      const state = kernel.state;
      const label = props.t(KERNEL_STATES[state]);
      const tooltipParts = [props.t('kernel.label') + ': ' + label];
      if (typeof kernel.path === 'string' && kernel.path !== '') tooltipParts.push(kernel.path);
      if (typeof kernel.version === 'string' && kernel.version !== '') {
        tooltipParts.push(props.t('kernel.version', { version: kernel.version }));
      }
      return h(
        'span',
        {
          className: 'dmn-kernel',
          title: tooltipParts.join(' · '),
          'data-dmn-kernel-state': state,
        },
        h('span', { className: 'dmn-dot dmn-dot--' + state, 'aria-hidden': 'true' }),
        h('span', { className: 'dmn-kernelLabel' }, label),
      );
    }

    /** One action/conflict/note banner above the cells. */
    function BannerView(props) {
      const banner = props.banner;
      const t = props.t;
      if (!banner || typeof banner !== 'object') return null;
      if (banner.kind === 'conflict') {
        const revision = typeof banner.revision === 'number' ? String(banner.revision) : '?';
        return h(
          'div',
          {
            className: 'dmn-banner dmn-banner--conflict',
            role: 'status',
            'data-dmn-banner': 'conflict',
          },
          h(
            'div',
            { className: 'dmn-bannerText' },
            h('div', { className: 'dmn-bannerTitle' }, t('banner.conflictTitle', { revision: revision })),
            h('div', { className: 'dmn-bannerSub' }, t('banner.conflictHint')),
          ),
          h(
            'div',
            { className: 'dmn-bannerActions' },
            h(
              'button',
              { type: 'button', className: 'dmn-btn dmn-btn--primary', onClick: props.onReload, 'data-dmn-banner-action': 'reload' },
              t('banner.reload'),
            ),
            h(
              'button',
              { type: 'button', className: 'dmn-btn', onClick: props.onKeepLocal, 'data-dmn-banner-action': 'keep-local' },
              t('banner.keepLocal'),
            ),
          ),
        );
      }
      if (banner.kind === 'error') {
        const detail = errorDetail(banner.error);
        return h(
          'div',
          {
            className: 'dmn-banner dmn-banner--error',
            role: 'alert',
            'data-dmn-banner': 'error',
          },
          h(
            'div',
            { className: 'dmn-bannerText' },
            h('div', { className: 'dmn-bannerTitle' }, errorText(t, banner.error)),
            detail !== '' ? h('div', { className: 'dmn-bannerDetail' }, detail) : null,
          ),
          h(
            'div',
            { className: 'dmn-bannerActions' },
            banner.saveFailed === true
              ? h(
                  'button',
                  { type: 'button', className: 'dmn-btn dmn-btn--primary', onClick: props.onRetrySave, 'data-dmn-banner-action': 'retry-save' },
                  t('banner.retrySave'),
                )
              : null,
            h(
              'button',
              { type: 'button', className: 'dmn-btn', onClick: props.onDismiss, 'data-dmn-banner-action': 'dismiss' },
              t('banner.dismiss'),
            ),
          ),
        );
      }
      if (banner.kind === 'note') {
        return h(
          'div',
          {
            className: 'dmn-banner dmn-banner--info',
            role: 'status',
            'data-dmn-banner': 'note',
          },
          h('div', { className: 'dmn-bannerText' }, h('div', { className: 'dmn-bannerTitle' }, t(banner.textKey, banner.vars))),
          h(
            'div',
            { className: 'dmn-bannerActions' },
            h(
              'button',
              { type: 'button', className: 'dmn-iconBtn', title: t('banner.dismiss'), 'aria-label': t('banner.dismiss'), onClick: props.onDismiss },
              h(SvgIcon, { name: 'close', size: 12 }),
            ),
          ),
        );
      }
      return null;
    }

    /** Fatal render fallback used by the slot error boundary. */
    function CrashedState(props) {
      const t = props.t;
      return h(
        'div',
        { className: 'dmn-root', 'data-dsh-mathematica-notebook': 'crashed', 'data-dmn-state': 'crashed' },
        h(
          'div',
          { className: 'dmn-state dmn-state--error', role: 'alert' },
          h(SvgIcon, { name: 'warning', size: 22, className: 'dmn-stateIcon' }),
          h('div', { className: 'dmn-stateTitle' }, t('state.crashed')),
          h(
            'button',
            { type: 'button', className: 'dmn-btn', onClick: props.onRetry, 'data-dmn-action': 'retry-crash' },
            t('state.tryAgain'),
          ),
        ),
      );
    }

    /**
     * React error boundary: a thrown render (bad tab data, unexpected Host
     * payload) shows the localized fallback instead of blanking the pane slot.
     */
    class SlotErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = this.retry.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error: error || new Error('unknown render error') };
      }

      componentDidCatch(error, info) {
        try {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[dsh-mathematica-notebook] render failure', error, info);
          }
        } catch (_error) {
          // Logging must never mask the fallback.
        }
      }

      retry() {
        this.setState({ error: null });
      }

      render() {
        if (this.state.error !== null) return h(CrashedState, { t: this.props.t, onRetry: this.retry });
        return this.props.children;
      }
    }

    /** The component registered under both pane-body keys; every crash lands in the boundary. */
    function NotebookSlotBody(props) {
      const t = resolveT(props.t);
      return h(SlotErrorBoundary, { t: t }, h(NotebookView, Object.assign({}, props, { t: t })));
    }

    // ---------------------------------------------------------------------
    // Cell editor + cell row
    // ---------------------------------------------------------------------

    /** Auto-growing monospace textarea. */
    function CellEditor(props) {
      const textareaRef = React.useRef(null);

      function resize() {
        const element = textareaRef.current;
        if (element === null) return;
        try {
          element.style.height = 'auto';
          const next = Math.min(Math.max(element.scrollHeight, 30), MAX_EDITOR_HEIGHT);
          element.style.height = String(next) + 'px';
        } catch (_error) {
          // Measuring is best-effort; the browser default height remains usable.
        }
      }

      React.useEffect(resize, [props.value]);

      return h('textarea', {
        ref: function (element) {
          textareaRef.current = element;
          props.registerEditor(element);
        },
        className: 'dmn-editor' + (props.text === true ? ' dmn-editor--text' : ''),
        value: props.value,
        readOnly: props.readOnly === true,
        placeholder: props.placeholder,
        spellCheck: false,
        autoCapitalize: 'off',
        autoCorrect: 'off',
        rows: 1,
        'data-dmn-editor': props.cellId,
        onChange: function (event) {
          props.onChange(event.target.value);
        },
        onKeyDown: props.onKeyDown,
      });
    }

    /** Inline error block for one evaluated cell. */
    function CellErrorBlock(props) {
      const detail = errorDetail(props.error);
      return h(
        'div',
        { className: 'dmn-cellError', role: 'alert', 'data-dmn-cell-error': props.error && props.error.code ? props.error.code : 'unknown' },
        h(
          'div',
          { className: 'dmn-cellErrorHead' },
          h(SvgIcon, { name: 'warning', size: 13, className: 'dmn-cellErrorIcon' }),
          h('span', null, errorText(props.t, props.error)),
        ),
        detail !== '' ? h('pre', { className: 'dmn-errorDetail' }, detail) : null,
      );
    }

    /** One cell row: gutter (index + run), editor, hover controls, output. */
    function CellView(props) {
      const cell = props.cell;
      const t = props.t;
      const runnable = cell.kind === 'code';
      const modeIsPretty = props.mode !== 'raw';

      const outputNodes = [];
      if (cell.running === true) {
        outputNodes.push(
          h(
            'div',
            { className: 'dmn-running', key: 'running', role: 'status' },
            h('span', { className: 'dmn-spinner' }),
            h('span', null, t('cell.running')),
          ),
        );
      } else if (cell.error !== null) {
        outputNodes.push(h(CellErrorBlock, { key: 'error', error: cell.error, t: t }));
      } else if (cell.outputs.length > 0) {
        outputNodes.push(
          h(
            'div',
            { className: 'dmn-outputs', key: 'stored' },
            cell.outputs.map(function (output, index) {
              const text = typeof output.text === 'string' ? output.text : '';
              if (output.type === 'msg') {
                return h(
                  'div',
                  { className: 'dmn-msg', key: 'stored-' + index },
                  h(SvgIcon, { name: 'warning', size: 12, className: 'dmn-msgIcon' }),
                  h('span', null, text),
                );
              }
              return h('pre', { className: 'dmn-pre', key: 'stored-' + index, tabIndex: 0 }, text);
            }),
          ),
        );
      } else if (cell.text !== null || cell.messages.length > 0 || cell.svgBytes !== null) {
        const head = [];
        const duration = formatDuration(t, cell.durationMs);
        if (duration !== null) head.push(h('span', { className: 'dmn-outputMeta', key: 'duration' }, duration));
        if (cell.svgBytes !== null) {
          head.push(
            h(
              'div',
              { className: 'dmn-seg', key: 'mode', role: 'group', 'aria-label': t('cell.outputMode') },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmn-segBtn',
                  'aria-pressed': modeIsPretty,
                  'data-dmn-output-mode': 'pretty',
                  onClick: function () {
                    props.onToggleMode(cell.id, 'pretty');
                  },
                },
                t('cell.pretty'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dmn-segBtn',
                  'aria-pressed': !modeIsPretty,
                  'data-dmn-output-mode': 'raw',
                  onClick: function () {
                    props.onToggleMode(cell.id, 'raw');
                  },
                },
                t('cell.raw'),
              ),
            ),
          );
        }

        const body = [];
        if (modeIsPretty) {
          const image = props.image;
          if (image && typeof image.url === 'string' && image.url !== '') {
            body.push(
              h(
                'div',
                {
                  className: 'dmn-svg',
                  key: 'image',
                  'data-dmn-output-svg': cell.id,
                  'data-dmn-output-mime': image.mime,
                },
                h('img', {
                  src: image.url,
                  alt: t('cell.svgAlt'),
                  draggable: false,
                  'data-dmn-output-img': cell.id,
                  'data-dmn-output-mime': image.mime,
                }),
              ),
            );
          } else if (cell.text !== null) {
            body.push(h('pre', { className: 'dmn-pre', key: 'text', tabIndex: 0 }, cell.text));
          } else if (cell.svgBytes !== null) {
            body.push(h('div', { className: 'dmn-outputEmpty', key: 'empty' }, t('cell.svgUnavailable')));
          }
        } else {
          body.push(h('pre', { className: 'dmn-pre', key: 'raw', tabIndex: 0 }, cell.text === null ? t('cell.noText') : cell.text));
        }
        outputNodes.push(
          h(
            'div',
            { className: 'dmn-outputs', key: 'evaluation' },
            head.length > 0 ? h('div', { className: 'dmn-outputHead' }, head) : null,
            body,
          ),
        );
        if (cell.messages.length > 0) {
          outputNodes.push(
            h(
              'div',
              { className: 'dmn-messages', key: 'messages' },
              cell.messages.map(function (message, index) {
                return h(
                  'div',
                  { className: 'dmn-msg', key: 'msg-' + index },
                  h(SvgIcon, { name: 'warning', size: 12, className: 'dmn-msgIcon' }),
                  h('span', null, message),
                );
              }),
            ),
          );
        }
      }

      const tools = [];
      if (props.readOnly !== true) {
        tools.push(
          h(
            'button',
            {
              type: 'button',
              className: 'dmn-iconBtn',
              title: t('cell.moveUp'),
              'aria-label': t('cell.moveUp'),
              'data-dmn-cell-tool': 'up',
              disabled: props.isFirst,
              onClick: function () {
                props.onMove(cell.id, -1);
              },
            },
            h(SvgIcon, { name: 'chevronUp', size: 12 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dmn-iconBtn',
              title: t('cell.moveDown'),
              'aria-label': t('cell.moveDown'),
              'data-dmn-cell-tool': 'down',
              disabled: props.isLast,
              onClick: function () {
                props.onMove(cell.id, 1);
              },
            },
            h(SvgIcon, { name: 'chevronDown', size: 12 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dmn-iconBtn dmn-iconBtn--danger',
              title: t('cell.delete'),
              'aria-label': t('cell.delete'),
              'data-dmn-cell-tool': 'delete',
              onClick: function () {
                props.onDelete(cell.id);
              },
            },
            h(SvgIcon, { name: 'trash', size: 12 }),
          ),
        );
      }

      return h(
        'div',
        {
          className: 'dmn-cell' + (cell.running === true ? ' dmn-cell--running' : ''),
          'data-dmn-cell': cell.id,
          'data-dmn-cell-kind': cell.kind,
        },
        h(
          'div',
          { className: 'dmn-gutter' },
          h('span', { className: 'dmn-cellIndex' }, String(props.index + 1)),
          runnable
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dmn-runBtn',
                  title: props.readOnly === true ? t('status.readOnlyHint') : t('cell.run'),
                  'aria-label': t('cell.run'),
                  'data-dmn-run': cell.id,
                  disabled: props.readOnly === true || cell.running === true,
                  onClick: function () {
                    props.onRun(cell.id);
                  },
                },
                cell.running === true ? h('span', { className: 'dmn-spinner' }) : h(SvgIcon, { name: 'play', size: 11 }),
              )
            : h('span', { className: 'dmn-textMark', title: t('cell.text'), 'aria-hidden': 'true' }, 'T'),
        ),
        h(
          'div',
          { className: 'dmn-cellBody' },
          h(
            'div',
            { className: 'dmn-editorWrap' },
            h(CellEditor, {
              cellId: cell.id,
              value: cell.code,
              readOnly: props.readOnly === true,
              text: cell.kind === 'text',
              placeholder: cell.kind === 'text' ? t('cell.placeholderText') : t('cell.placeholderCode'),
              registerEditor: props.registerEditor,
              onChange: function (value) {
                props.onCodeChange(cell.id, value);
              },
              onKeyDown: function (event) {
                props.onEditorKeyDown(event, cell);
              },
            }),
            tools.length > 0 ? h('div', { className: 'dmn-cellTools' }, tools) : null,
          ),
          outputNodes,
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Notebook view
    // ---------------------------------------------------------------------

    /**
     * The interactive notebook. Mounted as both pane-body keys; `props.variant`
     * selects create-on-mount (page tab) or open-an-address (file tab).
     */
    function NotebookView(rawProps) {
      const props = rawProps || {};
      const t = resolveT(props.t);
      const variant = props.variant === 'file' ? 'file' : 'page';

      // --- Tab identity -------------------------------------------------
      // The framework injects `useTabInfo`; a missing hook must degrade to the
      // localized fallback instead of throwing out of the slot.
      let tabInfo = null;
      try {
        tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      } catch (_error) {
        tabInfo = null;
      }
      const tab = tabInfo && tabInfo.tab ? tabInfo.tab : null;
      const address = tab && tab.navigation && typeof tab.navigation.address === 'string' ? tab.navigation.address : '';
      const parsedAddress = variant === 'file' ? parseFileAddress(address) : null;
      const slotSessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null;
      const sessionId = parsedAddress !== null && parsedAddress.sessionId !== null ? parsedAddress.sessionId : slotSessionId;
      const filePath = parsedAddress !== null ? parsedAddress.path : null;
      const targetErrorKey =
        variant === 'file'
          ? parsedAddress === null
            ? 'noAddress'
            : sessionId === null
              ? 'noSession'
              : null
          : sessionId === null
            ? 'noSession'
            : null;
      const visible = tab === null || tab.visible !== false;

      // --- React state --------------------------------------------------
      const [phase, setPhase] = React.useState(targetErrorKey === null ? 'loading' : 'error');
      const [loadError, setLoadError] = React.useState(targetErrorKey === null ? null : { code: targetErrorKey, message: '' });
      const [retryNonce, setRetryNonce] = React.useState(0);
      const [doc, setDoc] = React.useState(null);
      const [docPath, setDocPath] = React.useState(filePath);
      const [cells, setCells] = React.useState([]);
      const [revision, setRevision] = React.useState(null);
      const [readOnly, setReadOnly] = React.useState(false);
      const [dirty, setDirty] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [evaluating, setEvaluating] = React.useState(false);
      const [restarting, setRestarting] = React.useState(false);
      const [openingExternal, setOpeningExternal] = React.useState(false);
      const [kernel, setKernel] = React.useState(null);
      const [banner, setBanner] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [viewModes, setViewModes] = React.useState({});
      const [saveAsOpen, setSaveAsOpen] = React.useState(false);
      const [saveAsName, setSaveAsName] = React.useState('');
      const [saveAsBusy, setSaveAsBusy] = React.useState(false);
      const [pendingFocusId, setPendingFocusId] = React.useState(null);
      const [webBusy, setWebBusy] = React.useState(false);

      // --- Mutable mirrors the long-lived effect/handler closures read ---
      const mountedRef = React.useRef(true);
      const cellsRef = React.useRef(cells);
      const revisionRef = React.useRef(revision);
      const dirtyRef = React.useRef(dirty);
      const savingRef = React.useRef(false);
      const phaseRef = React.useRef(phase);
      const readOnlyRef = React.useRef(readOnly);
      const evaluatingRef = React.useRef(false);
      const docPathRef = React.useRef(filePath);
      const sessionIdRef = React.useRef(sessionId);
      const visibleRef = React.useRef(visible);
      const callRef = React.useRef(props.call);
      const saveTimerRef = React.useRef(null);
      const pollTimerRef = React.useRef(null);
      const pollInFlightRef = React.useRef(false);
      const savePromiseRef = React.useRef(null);
      const saveTicketRef = React.useRef(null);
      const saveFailedRef = React.useRef(false);
      const saveAfterEvaluationRef = React.useRef(false);
      const selfMutationAtRef = React.useRef(0);
      const conflictBlockedRef = React.useRef(false);
      const conflictRevisionRef = React.useRef(null);
      const blobUrlsRef = React.useRef(new Map());
      const textareaRefs = React.useRef(new Map());
      const noteTimerRef = React.useRef(null);
      const reloadFromHostRef = React.useRef(null);
      const missingNotebookPollsRef = React.useRef(0);
      const reopenAttemptedRef = React.useRef(false);

      // Refresh the mirrors before anything below can observe them.
      cellsRef.current = cells;
      revisionRef.current = revision;
      dirtyRef.current = dirty;
      phaseRef.current = phase;
      readOnlyRef.current = readOnly;
      docPathRef.current = docPath;
      sessionIdRef.current = sessionId;
      visibleRef.current = visible;
      callRef.current = props.call;

      // --- RPC helper ---------------------------------------------------
      function callApi(endpoint, payload, signal) {
        const call = callRef.current;
        if (typeof call !== 'function') {
          return Promise.resolve({ ok: false, error: { code: 'transport_error', message: 'notebook RPC is unavailable' } });
        }
        let pending;
        try {
          pending = Promise.resolve(call(endpoint, payload, signal));
        } catch (error) {
          return Promise.resolve({ ok: false, error: rpcFailure(error) });
        }
        return pending.then(
          function (result) {
            if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
            return { ok: false, error: { code: 'internal_error', message: 'invalid RPC result' } };
          },
          function (error) {
            return { ok: false, error: rpcFailure(error) };
          },
        );
      }

      // --- Blob URL bookkeeping -----------------------------------------
      function revokeAllBlobUrls() {
        try {
          blobUrlsRef.current.forEach(function (entry) {
            if (entry && typeof entry.url === 'string') URL.revokeObjectURL(entry.url);
          });
        } catch (_error) {
          // URL/Blob support is required; failure only leaks one URL.
        }
        blobUrlsRef.current.clear();
      }

      function revokeCellBlobUrl(cellId) {
        const entry = blobUrlsRef.current.get(cellId);
        if (!entry) return;
        try {
          URL.revokeObjectURL(entry.url);
        } catch (_error) {
          // Best-effort cleanup.
        }
        blobUrlsRef.current.delete(cellId);
      }

      /**
       * Cache one object URL per cell output bytes identity, keyed by the bytes
       * themselves, and revoke the previous one. The MIME type is sniffed once
       * from the bytes (SVG for 2D/symbolic, PNG for 3D Graphics3D); bytes that
       * are neither produce no URL, so no broken image is rendered.
       *
       * @returns `{ url, mime }` for a renderable image, or null.
       */
      function imageInfoOf(cell) {
        const bytes = cell.svgBytes;
        if (bytes === null || bytes === undefined) {
          // The cell's output was cleared or replaced with a text-only result.
          revokeCellBlobUrl(cell.id);
          return null;
        }
        const entry = blobUrlsRef.current.get(cell.id);
        if (entry && entry.bytes === bytes) return entry.info;
        if (entry) {
          if (typeof entry.url === 'string') {
            try {
              URL.revokeObjectURL(entry.url);
            } catch (_error) {
              // Best-effort cleanup.
            }
          }
          blobUrlsRef.current.delete(cell.id);
        }
        const mime = sniffImageMime(bytes);
        if (mime === null) return null;
        let url = null;
        try {
          url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        } catch (_error) {
          url = null;
        }
        const info = { url: url, mime: mime };
        blobUrlsRef.current.set(cell.id, { bytes: bytes, url: url, info: info });
        return info;
      }

      // --- State appliers ----------------------------------------------
      function applyNotebook(notebook) {
        if (!notebook || typeof notebook !== 'object') return;
        const normalized = normalizeCells(notebook.cells);
        const nextPath = typeof notebook.path === 'string' && notebook.path !== '' ? notebook.path : docPathRef.current;
        revokeAllBlobUrls();
        cellsRef.current = normalized;
        revisionRef.current = typeof notebook.revision === 'number' ? notebook.revision : null;
        dirtyRef.current = false;
        readOnlyRef.current = notebook.readOnly === true;
        docPathRef.current = nextPath;
        conflictBlockedRef.current = false;
        conflictRevisionRef.current = null;
        setDoc(notebook);
        setCells(normalized);
        setDocPath(nextPath);
        setRevision(revisionRef.current);
        setReadOnly(readOnlyRef.current);
        setDirty(false);
        setViewModes({});
        setBanner(null);
        setNote(null);
        setSaveAsOpen(false);
        setPhase('ready');
        phaseRef.current = 'ready';
      }

      function showNote(textKey, vars) {
        setNote({ kind: 'note', textKey: textKey, vars: vars });
      }

      function markEdited() {
        if (readOnlyRef.current) return;
        dirtyRef.current = true;
        setDirty(true);
        scheduleSave(SAVE_DEBOUNCE_MS);
      }

      // --- Timers -------------------------------------------------------
      function clearSaveTimer() {
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      }

      function scheduleSave(delay) {
        if (readOnlyRef.current) return;
        if (evaluatingRef.current) {
          // A save mid-evaluation would race the Host's revision bump; the run
          // path flushes it once the evaluate response has been adopted.
          saveAfterEvaluationRef.current = true;
          return;
        }
        clearSaveTimer();
        const wait = typeof delay === 'number' ? delay : SAVE_DEBOUNCE_MS;
        saveTimerRef.current = setTimeout(function () {
          saveTimerRef.current = null;
          void saveNow({ reason: 'auto' });
        }, wait);
      }

      // --- Saving -------------------------------------------------------
      /**
       * Persist the current cells. Always resolves to an outcome object; the
       * auto-save path and the conflict banner both drive it.
       */
      function saveNow(options) {
        const opts = options || {};
        if (savePromiseRef.current !== null) return savePromiseRef.current;
        if (!mountedRef.current || readOnlyRef.current || phaseRef.current !== 'ready') {
          return Promise.resolve({ ok: false, reason: 'not-ready' });
        }
        const session = sessionIdRef.current;
        const path = docPathRef.current;
        if (session === null || path === null) return Promise.resolve({ ok: false, reason: 'no-target' });
        if (conflictBlockedRef.current && opts.force !== true) return Promise.resolve({ ok: false, reason: 'conflict' });
        if (evaluatingRef.current && opts.reason !== 'pre-evaluate') return Promise.resolve({ ok: false, reason: 'evaluating' });
        if (opts.force === true) saveFailedRef.current = false;
        clearSaveTimer();
        savingRef.current = true;
        setSaving(true);
        const cellsPayload = serializeCells(cellsRef.current);
        const payloadText = JSON.stringify(cellsPayload);
        const baseRevision = typeof opts.baseRevision === 'number' ? opts.baseRevision : revisionRef.current;
        const ticket = {};
        saveTicketRef.current = ticket;

        const promise = (async function () {
          try {
            const result = await callApi('save', {
              sessionId: session,
              path: path,
              cells: cellsPayload,
              baseRevision: baseRevision,
            });
            if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
            if (result.ok === true) {
              const value = result.value || {};
              if (typeof value.revision === 'number') {
                revisionRef.current = value.revision;
                setRevision(value.revision);
              }
              if (typeof value.path === 'string' && value.path !== path) {
                docPathRef.current = value.path;
                setDocPath(value.path);
              }
              conflictBlockedRef.current = false;
              conflictRevisionRef.current = null;
              saveFailedRef.current = false;
              selfMutationAtRef.current = Date.now();
              const latestText = JSON.stringify(serializeCells(cellsRef.current));
              const clean = latestText === payloadText;
              dirtyRef.current = !clean;
              setDirty(!clean);
              setBanner(function (current) {
                if (current === null) return null;
                if (current.kind === 'conflict') return null;
                if (current.kind === 'error' && current.saveFailed === true) return null;
                return current;
              });
              if (!clean) scheduleSave(SAVE_DEBOUNCE_MS);
              return { ok: true, revision: value.revision };
            }
            const error = normalizeRpcError(result.error);
            if (error.code === 'conflict') {
              const remoteRevision = error.details && typeof error.details.revision === 'number' ? error.details.revision : null;
              conflictBlockedRef.current = true;
              conflictRevisionRef.current = remoteRevision;
              setBanner({ kind: 'conflict', revision: remoteRevision });
              return { ok: false, reason: 'conflict', error: error };
            }
            setBanner({ kind: 'error', error: error, saveFailed: true });
            saveFailedRef.current = true;
            return { ok: false, reason: 'error', error: error };
          } catch (error) {
            const failure = rpcFailure(error);
            if (mountedRef.current) setBanner({ kind: 'error', error: failure, saveFailed: true });
            saveFailedRef.current = true;
            return { ok: false, reason: 'error', error: failure };
          } finally {
            savingRef.current = false;
            if (mountedRef.current) setSaving(false);
            if (saveTicketRef.current === ticket) {
              savePromiseRef.current = null;
              saveTicketRef.current = null;
            }
            if (
              mountedRef.current &&
              dirtyRef.current &&
              conflictBlockedRef.current !== true &&
              saveFailedRef.current !== true
            ) {
              scheduleSave(SAVE_DEBOUNCE_MS);
            }
          }
        })();
        savePromiseRef.current = promise;
        return promise;
      }

      // --- Evaluation ---------------------------------------------------
      function setRunningFor(ids, running) {
        setCells(function (current) {
          return current.map(function (cell) {
            if (!ids.has(cell.id)) return cell;
            if (running) return Object.assign({}, cell, { running: true, error: null });
            return Object.assign({}, cell, { running: false });
          });
        });
      }

      function applyEvaluationResults(resultCells, ids) {
        const byId = new Map();
        for (const resultCell of Array.isArray(resultCells) ? resultCells : []) {
          if (resultCell && typeof resultCell.id === 'string') byId.set(resultCell.id, resultCell);
        }
        setCells(function (current) {
          return current.map(function (cell) {
            if (!ids.has(cell.id)) return cell;
            const resultCell = byId.get(cell.id);
            if (resultCell === undefined) {
              return Object.assign({}, cell, { running: false, error: { code: 'evaluation_failed', message: '' } });
            }
            if (resultCell.ok === false) {
              return Object.assign({}, cell, {
                running: false,
                error: normalizeRpcError(resultCell.error),
                durationMs: typeof resultCell.durationMs === 'number' ? resultCell.durationMs : null,
                text: null,
                messages: [],
                svgBytes: null,
                outputs: [],
              });
            }
            return Object.assign({}, cell, {
              running: false,
              error: null,
              durationMs: typeof resultCell.durationMs === 'number' ? resultCell.durationMs : null,
              text: typeof resultCell.text === 'string' ? resultCell.text : null,
              messages: normalizeMessages(resultCell.messages),
              svgBytes: extractSvgBytes(resultCell),
              outputs: [],
            });
          });
        });
      }

      function applyRunFailure(ids, error) {
        const failure = normalizeRpcError(error);
        setCells(function (current) {
          return current.map(function (cell) {
            if (!ids.has(cell.id)) return cell;
            return Object.assign({}, cell, { running: false, error: failure });
          });
        });
        if (failure.code === 'kernel_unavailable') void refreshKernelStatus();
      }

      async function refreshKernelStatus() {
        const session = sessionIdRef.current;
        if (session === null) return;
        const path = docPathRef.current;
        const result = await callApi('status', path ? { sessionId: session, path: path } : { sessionId: session });
        if (!mountedRef.current || result.ok !== true) return;
        const value = result.value || {};
        if (value.kernel && typeof value.kernel === 'object') setKernel(value.kernel);
      }

      /**
       * Adopt the Host revision our own evaluation/agent-independent mutation
       * produced, so a following save does not use a stale baseRevision. The
       * 2 s status poll would otherwise report a conflict we caused ourselves.
       */
      async function syncRevisionFromHost() {
        const session = sessionIdRef.current;
        const path = docPathRef.current;
        if (session === null || path === null) return;
        const result = await callApi('status', { sessionId: session, path: path });
        if (!mountedRef.current || result.ok !== true) return;
        const value = result.value || {};
        if (value.kernel && typeof value.kernel === 'object') setKernel(value.kernel);
        const notebook = value.notebook;
        if (!notebook || typeof notebook !== 'object' || notebook.path !== path) return;
        if (typeof notebook.revision === 'number' && notebook.revision !== revisionRef.current) {
          revisionRef.current = notebook.revision;
          selfMutationAtRef.current = Date.now();
          setRevision(notebook.revision);
        }
      }

      async function runCells(targets) {
        const list = Array.isArray(targets) ? targets.filter(function (cell) { return cell && cell.kind === 'code'; }) : [];
        if (list.length === 0 || readOnlyRef.current || phaseRef.current !== 'ready' || evaluatingRef.current) return;
        const ids = new Set(list.map(function (cell) { return cell.id; }));
        evaluatingRef.current = true;
        setEvaluating(true);
        setRunningFor(ids, true);
        try {
          if (dirtyRef.current || savingRef.current) {
            const saved = await saveNow({ reason: 'pre-evaluate' });
            if (!saved || saved.ok !== true) {
              setRunningFor(ids, false);
              return;
            }
          }
          const session = sessionIdRef.current;
          const path = docPathRef.current;
          if (session === null || path === null) {
            applyRunFailure(ids, { code: 'internal_error', message: 'notebook target is missing' });
            return;
          }
          // The Host keeps cell ids stable; resend the exact code we render so the
          // stored document and the evaluated cells cannot diverge.
          const payloadCells = list.map(function (cell) {
            return { id: cell.id, code: cell.code };
          });
          const result = await callApi('evaluate', { sessionId: session, path: path, cells: payloadCells });
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            applyRunFailure(ids, result.error);
            return;
          }
          const value = result.value || {};
          if (value.ok === false) {
            applyRunFailure(ids, value.error || { code: 'evaluation_failed', message: '' });
            return;
          }
          applyEvaluationResults(value.cells, ids);
          // Our own evaluation bumped the Host revision; adopt it immediately so
          // a save right after the run does not use a stale baseRevision.
          selfMutationAtRef.current = Date.now();
          await syncRevisionFromHost();
        } catch (error) {
          applyRunFailure(ids, rpcFailure(error));
        } finally {
          evaluatingRef.current = false;
          if (mountedRef.current) setEvaluating(false);
          if (mountedRef.current && saveAfterEvaluationRef.current) {
            saveAfterEvaluationRef.current = false;
            if (dirtyRef.current) scheduleSave(SAVE_DEBOUNCE_MS);
          }
        }
      }

      // --- Cell editing -------------------------------------------------
      function updateCellCode(cellId, code) {
        if (readOnlyRef.current) return;
        // A changed input invalidates its displayed output (the Host marks the
        // same cell stale); drop it so old results cannot be mistaken for new.
        revokeCellBlobUrl(cellId);
        setCells(function (current) {
          return current.map(function (cell) {
            if (cell.id !== cellId || cell.code === code) return cell;
            return Object.assign({}, cell, {
              code: code,
              outputs: [],
              error: null,
              durationMs: null,
              text: null,
              messages: [],
              svgBytes: null,
            });
          });
        });
        markEdited();
      }

      function addCodeCell(afterId) {
        if (readOnlyRef.current) return;
        const current = cellsRef.current;
        const newCell = {
          id: nextCellId(current),
          kind: 'code',
          code: '',
          outputs: [],
          running: false,
          error: null,
          durationMs: null,
          text: null,
          messages: [],
          svgBytes: null,
        };
        let index = -1;
        if (typeof afterId === 'string') {
          for (let i = 0; i < current.length; i += 1) {
            if (current[i].id === afterId) {
              index = i;
              break;
            }
          }
        }
        const next = current.slice();
        next.splice(index === -1 ? next.length : index + 1, 0, newCell);
        cellsRef.current = next;
        setCells(next);
        markEdited();
        setPendingFocusId(newCell.id);
      }

      function deleteCell(cellId) {
        if (readOnlyRef.current) return;
        revokeCellBlobUrl(cellId);
        textareaRefs.current.delete(cellId);
        const next = cellsRef.current.filter(function (cell) { return cell.id !== cellId; });
        cellsRef.current = next;
        setCells(next);
        markEdited();
      }

      function moveCell(cellId, delta) {
        if (readOnlyRef.current) return;
        const current = cellsRef.current;
        const index = current.findIndex(function (cell) { return cell.id === cellId; });
        if (index === -1) return;
        const target = index + delta;
        if (target < 0 || target >= current.length) return;
        const next = current.slice();
        const moved = next.splice(index, 1)[0];
        next.splice(target, 0, moved);
        cellsRef.current = next;
        setCells(next);
        markEdited();
      }

      function focusCell(cellId) {
        const element = textareaRefs.current.get(cellId);
        if (!element) return;
        try {
          element.focus();
          const end = element.value.length;
          element.setSelectionRange(end, end);
        } catch (_error) {
          // Focusing a detached textarea is harmless to skip.
        }
      }

      function focusSibling(cellId, delta) {
        const list = cellsRef.current;
        const index = list.findIndex(function (cell) { return cell.id === cellId; });
        if (index === -1) return;
        const sibling = list[index + delta];
        if (sibling) focusCell(sibling.id);
      }

      function runSingleCell(cellId) {
        const cell = cellsRef.current.find(function (item) { return item.id === cellId; });
        if (!cell || cell.kind !== 'code') return;
        void runCells([cell]);
      }

      function runAndAdvance(cell) {
        if (readOnlyRef.current || !cell) return;
        const list = cellsRef.current;
        const index = list.findIndex(function (item) { return item.id === cell.id; });
        const next = index === -1 ? undefined : list[index + 1];
        void runCells([cell]);
        if (next) setPendingFocusId(next.id);
        else addCodeCell(cell.id);
      }

      function toggleOutputMode(cellId, mode) {
        setViewModes(function (current) {
          const next = Object.assign({}, current);
          next[cellId] = mode;
          return next;
        });
      }

      function handleEditorKeyDown(event, cell) {
        if (event === null || typeof event !== 'object') return;
        if (event.isComposing === true) return;
        const key = event.key;
        if (key === 'Enter' && event.shiftKey === true) {
          event.preventDefault();
          runAndAdvance(cell);
          return;
        }
        if (key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
          event.preventDefault();
          runSingleCell(cell.id);
          return;
        }
        if (key === 'ArrowUp' && event.altKey === true) {
          event.preventDefault();
          focusSibling(cell.id, -1);
          return;
        }
        if (key === 'ArrowDown' && event.altKey === true) {
          event.preventDefault();
          focusSibling(cell.id, 1);
          return;
        }
        if (key === 'Tab' && event.shiftKey !== true && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true) {
          event.preventDefault();
          const element = event.target;
          let start = cell.code.length;
          let end = cell.code.length;
          try {
            start = element.selectionStart;
            end = element.selectionEnd;
          } catch (_error) {
            start = cell.code.length;
            end = cell.code.length;
          }
          const nextCode = cell.code.slice(0, start) + '  ' + cell.code.slice(end);
          updateCellCode(cell.id, nextCode);
          const focusPosition = start + 2;
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
              try {
                element.setSelectionRange(focusPosition, focusPosition);
              } catch (_error) {
                // The element may have been re-rendered; focus is retained.
              }
            });
          }
          return;
        }
        if (key === 'Escape') {
          try {
            event.target.blur();
          } catch (_error) {
            // No-op.
          }
        }
      }

      // --- Toolbar actions ---------------------------------------------
      async function restartKernel() {
        if (restarting) return;
        setRestarting(true);
        try {
          const result = await callApi('restartKernel', {});
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            setBanner({ kind: 'error', error: normalizeRpcError(result.error) });
            return;
          }
          const value = result.value || {};
          if (value.kernel && typeof value.kernel === 'object') setKernel(value.kernel);
          showNote('status.kernelRestarted');
        } catch (error) {
          if (mountedRef.current) setBanner({ kind: 'error', error: rpcFailure(error) });
        } finally {
          if (mountedRef.current) setRestarting(false);
        }
      }

      async function openInMathematica() {
        if (openingExternal) return;
        const session = sessionIdRef.current;
        const path = docPathRef.current;
        if (session === null || path === null) return;
        setOpeningExternal(true);
        try {
          const result = await callApi('openInMathematica', { sessionId: session, path: path });
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            setBanner({ kind: 'error', error: normalizeRpcError(result.error) });
            return;
          }
          showNote('status.launched');
        } catch (error) {
          if (mountedRef.current) setBanner({ kind: 'error', error: rpcFailure(error) });
        } finally {
          if (mountedRef.current) setOpeningExternal(false);
        }
      }

      /**
       * Open the local WLJS web notebook (a full-fidelity Wolfram frontend that
       * renders every output kind) in a right-sidebar Browser tab. The Host
       * starts the WLJS server on demand; the tab embeds it natively, so nothing
       * is re-implemented in this plugin's own renderer.
       */
      async function openWebNotebook() {
        if (webBusy) return;
        setWebBusy(true);
        try {
          const result = await callApi('webOpen', { sessionId: sessionIdRef.current, fresh: false });
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            setBanner({ kind: 'error', error: normalizeRpcError(result.error) });
            return;
          }
          const value = result.value || {};
          if (typeof value.url !== 'string' || value.url === '') {
            setBanner({ kind: 'error', error: { code: 'internal_error', message: 'missing web notebook url' } });
            return;
          }
          if (typeof props.openBrowserTab !== 'function') {
            setBanner({ kind: 'error', error: { code: 'transport_error', message: 'browser tab carrier is unavailable' } });
            return;
          }
          props.openBrowserTab(value.url);
          showNote('web.opened');
          // A newly created notebook gets a short intro/sample set once the
          // Browser tab has attached to it; seeding is best-effort.
          if (value.created === true && typeof value.notebookId === 'string') {
            const notebookId = value.notebookId;
            setTimeout(function () {
              void callApi('webSeed', { sessionId: sessionIdRef.current, notebook: notebookId });
            }, 2500);
          }
        } catch (error) {
          if (mountedRef.current) setBanner({ kind: 'error', error: rpcFailure(error) });
        } finally {
          if (mountedRef.current) setWebBusy(false);
        }
      }

      function defaultCopyName() {
        const path = docPathRef.current || filePath || 'notebook.nb';
        return stemOf(basenameOf(path)) + '-copy.nb';
      }

      function toggleSaveAs() {
        setSaveAsOpen(function (open) {
          if (!open) setSaveAsName(defaultCopyName());
          return !open;
        });
      }

      async function submitSaveAs() {
        if (saveAsBusy) return;
        const session = sessionIdRef.current;
        const path = docPathRef.current;
        const rawName = saveAsName.trim();
        if (session === null || path === null) return;
        if (rawName === '') {
          showNote('saveAs.invalid');
          return;
        }
        const name = /\.nb$/i.test(rawName) ? rawName : rawName + '.nb';
        setSaveAsBusy(true);
        try {
          const result = await callApi('saveAs', {
            sessionId: session,
            path: path,
            name: name,
            cells: serializeCells(cellsRef.current),
          });
          if (!mountedRef.current) return;
          if (result.ok !== true) {
            setBanner({ kind: 'error', error: normalizeRpcError(result.error) });
            return;
          }
          const notebook = result.value && result.value.notebook;
          if (!notebook || typeof notebook !== 'object') {
            setBanner({ kind: 'error', error: { code: 'internal_error', message: 'missing notebook' } });
            return;
          }
          applyNotebook(notebook);
          showNote('status.savedAs', { name: name });
        } catch (error) {
          if (mountedRef.current) setBanner({ kind: 'error', error: rpcFailure(error) });
        } finally {
          if (mountedRef.current) setSaveAsBusy(false);
        }
      }

      function dismissBanner() {
        setBanner(null);
      }

      function keepLocalAndSave() {
        const remoteRevision = conflictRevisionRef.current;
        void saveNow({ force: true, baseRevision: typeof remoteRevision === 'number' ? remoteRevision : undefined });
      }

      function retryLoad() {
        if (targetErrorKey !== null) return;
        setRetryNonce(function (value) { return value + 1; });
      }

      // --- Effects ------------------------------------------------------
      // Mount lifetime: blob URLs and the Host store entry are released exactly
      // once, however the body unmounts (tab close, plugin unload, HMR).
      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          revokeAllBlobUrls();
          if (saveTimerRef.current !== null) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
          }
          if (noteTimerRef.current !== null) {
            clearTimeout(noteTimerRef.current);
            noteTimerRef.current = null;
          }
          if (pollTimerRef.current !== null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          const session = sessionIdRef.current;
          const path = docPathRef.current;
          if (session === null || path === null) return;
          const call = callRef.current;
          if (typeof call !== 'function') return;
          const release = function () {
            try {
              Promise.resolve(call('close', { sessionId: session, path: path })).catch(function () {});
            } catch (_error) {
              // The Host also flushes on its own disposal; nothing else to do.
            }
          };
          if (dirtyRef.current) {
            let payloadCells;
            try {
              payloadCells = serializeCells(cellsRef.current);
            } catch (_error) {
              payloadCells = null;
            }
            if (payloadCells !== null) {
              try {
                Promise.resolve(
                  call('save', {
                    sessionId: session,
                    path: path,
                    cells: payloadCells,
                    baseRevision: revisionRef.current,
                  }),
                ).then(release, release);
              } catch (_error) {
                release();
              }
              return;
            }
          }
          release();
        };
      }, []);

      // Target lifetime: load (create/open) and poll status while visible.
      React.useEffect(
        function () {
          if (targetErrorKey !== null || sessionId === null) {
            setPhase('error');
            setLoadError({ code: targetErrorKey || 'noSession', message: '' });
            return undefined;
          }
          let cancelled = false;
          const controller = new AbortController();
          let pollTimer = null;

          function startPolling() {
            if (pollTimer !== null) return;
            pollTimer = setInterval(function () {
              void poll();
            }, POLL_MS);
            pollTimerRef.current = pollTimer;
          }

          async function reloadFromHost() {
            const path = docPathRef.current;
            if (cancelled || !mountedRef.current || path === null) return;
            const result = await callApi('open', { sessionId: sessionIdRef.current, path: path }, controller.signal);
            if (cancelled || !mountedRef.current) return;
            if (result.ok !== true) {
              setBanner({ kind: 'error', error: normalizeRpcError(result.error) });
              return;
            }
            const notebook = result.value && result.value.notebook;
            if (notebook && typeof notebook === 'object') applyNotebook(notebook);
          }

          reloadFromHostRef.current = reloadFromHost;

          async function poll() {
            if (cancelled || !mountedRef.current || phaseRef.current !== 'ready') return;
            if (pollInFlightRef.current || !visibleRef.current) return;
            const session = sessionIdRef.current;
            if (session === null) return;
            pollInFlightRef.current = true;
            try {
              const path = docPathRef.current;
              const result = await callApi('status', path ? { sessionId: session, path: path } : { sessionId: session }, controller.signal);
              if (cancelled || !mountedRef.current || result.ok !== true) return;
              const value = result.value || {};
              if (value.kernel && typeof value.kernel === 'object') setKernel(value.kernel);
              if (phaseRef.current !== 'ready') return;
              const currentPath = docPathRef.current;
              const notebook = value.notebook;
              if (!notebook || typeof notebook !== 'object') {
                // The Host released its store entry (restart / eviction): reopen
                // the same path from disk once per mount so the tab recovers.
                if (currentPath !== null) {
                  missingNotebookPollsRef.current += 1;
                  if (missingNotebookPollsRef.current >= 2 && reopenAttemptedRef.current !== true) {
                    reopenAttemptedRef.current = true;
                    await reloadFromHost();
                  }
                }
                return;
              }
              missingNotebookPollsRef.current = 0;
              if (currentPath === null || notebook.path !== currentPath) return;
              const remoteRevision = typeof notebook.revision === 'number' ? notebook.revision : null;
              const localRevision = revisionRef.current;
              if (remoteRevision === null || localRevision === null || remoteRevision === localRevision) return;
              const selfMutation = Date.now() - selfMutationAtRef.current < SELF_MUTATION_WINDOW_MS;
              if (!dirtyRef.current && !savingRef.current) {
                if (selfMutation) {
                  revisionRef.current = remoteRevision;
                  setRevision(remoteRevision);
                } else {
                  await reloadFromHost();
                }
                return;
              }
              if (conflictBlockedRef.current) return;
              conflictBlockedRef.current = true;
              conflictRevisionRef.current = remoteRevision;
              setBanner({ kind: 'conflict', revision: remoteRevision });
            } catch (_error) {
              // Polling is best-effort: the next tick retries.
            } finally {
              pollInFlightRef.current = false;
            }
          }

          async function load() {
            setPhase('loading');
            setLoadError(null);
            setBanner(null);
            const endpoint = variant === 'page' ? 'create' : 'open';
            const payload = variant === 'page' ? { sessionId: sessionId } : { sessionId: sessionId, path: filePath };
            const result = await callApi(endpoint, payload, controller.signal);
            if (cancelled || !mountedRef.current) return;
            if (result.ok !== true) {
              setPhase('error');
              setLoadError(normalizeRpcError(result.error));
              return;
            }
            const notebook = result.value && result.value.notebook;
            if (!notebook || typeof notebook !== 'object') {
              setPhase('error');
              setLoadError({ code: 'internal_error', message: 'missing notebook' });
              return;
            }
            applyNotebook(notebook);
            startPolling();
            void refreshKernelStatus();
          }

          void load();

          return function () {
            cancelled = true;
            if (reloadFromHostRef.current === reloadFromHost) reloadFromHostRef.current = null;
            controller.abort();
            if (pollTimer !== null) {
              clearInterval(pollTimer);
              pollTimer = null;
            }
            if (pollTimerRef.current === pollTimer) pollTimerRef.current = null;
          };
        },
        [variant, sessionId, filePath, retryNonce, targetErrorKey],
      );

      // Focus handoff after inserting a cell / advancing with Shift+Enter.
      React.useEffect(
        function () {
          if (pendingFocusId === null) return;
          focusCell(pendingFocusId);
          setPendingFocusId(null);
        },
        [pendingFocusId, cells],
      );

      // Transient success/info note auto-dismiss.
      React.useEffect(
        function () {
          if (note === null) return undefined;
          if (noteTimerRef.current !== null) clearTimeout(noteTimerRef.current);
          noteTimerRef.current = setTimeout(function () {
            noteTimerRef.current = null;
            if (mountedRef.current) setNote(null);
          }, 5000);
          return function () {
            if (noteTimerRef.current !== null) {
              clearTimeout(noteTimerRef.current);
              noteTimerRef.current = null;
            }
          };
        },
        [note],
      );

      // --- Render helpers ----------------------------------------------
      const title = (function () {
        if (doc && typeof doc.title === 'string' && doc.title !== '') return doc.title;
        if (docPath !== null && docPath !== '') return basenameOf(docPath);
        if (filePath !== null && filePath !== '') return basenameOf(filePath);
        return t('tab.title');
      })();
      const displayPath = docPath || filePath || '';
      const hasCodeCells = cells.some(function (cell) { return cell.kind === 'code'; });
      const anyRunning = cells.some(function (cell) { return cell.running === true; });
      const kernelUnavailable = kernel !== null && typeof kernel === 'object' && kernel.state === 'unavailable';
      const saveState = saving === true ? 'saving' : dirty === true ? 'dirty' : 'saved';
      const canEdit = readOnly !== true && phase === 'ready';
      const runAllDisabled = !canEdit || !hasCodeCells || anyRunning || evaluating === true || restarting === true;
      const saveDisabled = !canEdit || dirty !== true || saving === true || evaluating === true;

      function renderHeader() {
        const buttons = [];
        buttons.push(
          h(
            'button',
            {
              key: 'run-all',
              type: 'button',
              className: 'dmn-btn dmn-btn--primary',
              'data-dmn-action': 'run-all',
              title: t('toolbar.runAll'),
              disabled: runAllDisabled,
              onClick: function () {
                const codeCells = cellsRef.current.filter(function (cell) { return cell.kind === 'code'; });
                void runCells(codeCells);
              },
            },
            h(SvgIcon, { name: 'play', size: 12 }),
            h('span', null, t('toolbar.runAll')),
          ),
        );
        if (readOnly === true) {
          buttons.push(
            h(
              'button',
              {
                key: 'save-copy',
                type: 'button',
                className: 'dmn-btn',
                'data-dmn-action': 'save-copy',
                title: t('toolbar.saveCopy'),
                onClick: toggleSaveAs,
              },
              h(SvgIcon, { name: 'save', size: 12 }),
              h('span', null, t('toolbar.saveCopy')),
            ),
          );
        } else {
          buttons.push(
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                className: 'dmn-btn',
                'data-dmn-action': 'save',
                title: t('toolbar.save'),
                disabled: saveDisabled,
                onClick: function () {
                  void saveNow({ force: true });
                },
              },
              h(SvgIcon, { name: 'save', size: 12 }),
              h('span', null, t('toolbar.save')),
            ),
          );
        }
        buttons.push(
          h(
            'button',
            {
              key: 'restart',
              type: 'button',
              className: 'dmn-btn',
              'data-dmn-action': 'restart-kernel',
              title: t('toolbar.restartKernel'),
              disabled: restarting === true || phase !== 'ready',
              onClick: function () {
                void restartKernel();
              },
            },
            restarting === true ? h('span', { className: 'dmn-spinner' }) : h(SvgIcon, { name: 'restart', size: 12 }),
            h('span', null, t('toolbar.restartKernel')),
          ),
          h(
            'button',
            {
              key: 'external',
              type: 'button',
              className: 'dmn-btn',
              'data-dmn-action': 'open-in-mathematica',
              title: t('toolbar.openInMathematica'),
              disabled: openingExternal === true || displayPath === '',
              onClick: function () {
                void openInMathematica();
              },
            },
            openingExternal === true ? h('span', { className: 'dmn-spinner' }) : h(SvgIcon, { name: 'external', size: 12 }),
            h('span', null, t('toolbar.openInMathematica')),
          ),
          h(
            'button',
            {
              key: 'add-cell',
              type: 'button',
              className: 'dmn-btn',
              'data-dmn-action': 'add-code-cell',
              title: t('toolbar.addCode'),
              disabled: canEdit !== true,
              onClick: function () {
                addCodeCell();
              },
            },
            h(SvgIcon, { name: 'plus', size: 12 }),
            h('span', null, t('toolbar.addCode')),
          ),
          h(
            'button',
            {
              key: 'web-notebook',
              type: 'button',
              className: 'dmn-btn dmn-btn--accent',
              'data-dmn-action': 'open-web-notebook',
              title: t('toolbar.webHint'),
              disabled: webBusy === true,
              onClick: function () {
                void openWebNotebook();
              },
            },
            webBusy === true ? h('span', { className: 'dmn-spinner' }) : h(SvgIcon, { name: 'globe', size: 12 }),
            h('span', null, webBusy === true ? t('web.starting') : t('toolbar.web')),
          ),
        );

        return h(
          'div',
          { className: 'dmn-header', 'data-dmn-toolbar': 'true' },
          h(
            'div',
            { className: 'dmn-titleRow' },
            h('span', { className: 'dmn-brandIcon', 'aria-hidden': 'true' }, h(SvgIcon, { name: 'sigma', size: 14 })),
            h(
              'div',
              { className: 'dmn-titleBlock' },
              h('div', { className: 'dmn-title', title: title }, title),
              displayPath !== '' ? h('div', { className: 'dmn-path', title: displayPath }, displayPath) : null,
            ),
            h(
              'div',
              { className: 'dmn-statusGroup' },
              readOnly === true
                ? h('span', { className: 'dmn-badge dmn-badge--readonly', 'data-dmn-readonly': 'true' }, t('status.readOnly'))
                : null,
              h(
                'span',
                { className: 'dmn-saveFlag', 'data-dmn-save-state': saveState },
                saveState === 'saving'
                  ? h('span', { className: 'dmn-spinner' })
                  : saveState === 'dirty'
                    ? h('span', { className: 'dmn-dirtyDot', 'aria-hidden': 'true' })
                    : h(SvgIcon, { name: 'check', size: 11 }),
                h(
                  'span',
                  null,
                  saveState === 'saving' ? t('status.saving') : saveState === 'dirty' ? t('status.dirty') : t('status.saved'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dmn-actions' },
            h(KernelBadge, { kernel: kernel, t: t }),
            h('div', { className: 'dmn-actionButtons' }, buttons),
          ),
        );
      }

      function renderReadOnlyNotice() {
        return h(
          'div',
          { className: 'dmn-notice', 'data-dmn-notice': 'readonly' },
          h(SvgIcon, { name: 'warning', size: 13, className: 'dmn-noticeIcon' }),
          h('div', { className: 'dmn-noticeBody' }, h('div', { className: 'dmn-noticeText' }, t('status.readOnlyHint'))),
        );
      }

      function renderSaveAsForm() {
        return h(
          'form',
          {
            className: 'dmn-saveAsForm',
            'data-dmn-form': 'save-as',
            onSubmit: function (event) {
              event.preventDefault();
              void submitSaveAs();
            },
          },
          h('div', { className: 'dmn-saveAsTitle' }, t('saveAs.title')),
          h(
            'div',
            { className: 'dmn-saveAsRow' },
            h('input', {
              className: 'dmn-input',
              value: saveAsName,
              placeholder: t('saveAs.namePlaceholder', { name: defaultCopyName() }),
              spellCheck: false,
              autoFocus: true,
              'aria-label': t('saveAs.title'),
              onChange: function (event) {
                setSaveAsName(event.target.value);
              },
            }),
            h(
              'button',
              { type: 'submit', className: 'dmn-btn dmn-btn--primary', disabled: saveAsBusy === true, 'data-dmn-action': 'confirm-save-as' },
              saveAsBusy === true ? h('span', { className: 'dmn-spinner' }) : null,
              h('span', null, t('saveAs.confirm')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dmn-btn',
                onClick: function () {
                  setSaveAsOpen(false);
                },
              },
              h('span', null, t('saveAs.cancel')),
            ),
          ),
        );
      }

      function renderLoadingState() {
        return h(
          'div',
          { className: 'dmn-state', role: 'status', 'data-dmn-state': 'loading' },
          h('span', { className: 'dmn-spinner dmn-spinner--large' }),
          h('div', { className: 'dmn-stateTitle' }, variant === 'file' ? t('state.opening') : t('state.creating')),
        );
      }

      function renderErrorState() {
        const localCode = loadError && typeof loadError.code === 'string' ? loadError.code : '';
        let detailLine = '';
        let heading = t('state.loadFailed');
        if (localCode === 'noAddress') {
          heading = t('state.noAddress');
        } else if (localCode === 'noSession') {
          heading = t('state.noSession');
        } else if (loadError) {
          detailLine = errorDetail(loadError);
        }
        const retryable = targetErrorKey === null;
        return h(
          'div',
          { className: 'dmn-state dmn-state--error', role: 'alert', 'data-dmn-state': 'error' },
          h(SvgIcon, { name: 'warning', size: 22, className: 'dmn-stateIcon' }),
          h('div', { className: 'dmn-stateTitle' }, heading),
          detailLine !== '' ? h('div', { className: 'dmn-stateDetail' }, detailLine) : null,
          retryable
            ? h(
                'button',
                { type: 'button', className: 'dmn-btn', 'data-dmn-action': 'retry-load', onClick: retryLoad },
                h(SvgIcon, { name: 'restart', size: 12 }),
                h('span', null, t('state.retry')),
              )
            : null,
        );
      }

      function renderEmptyState() {
        return h(
          'div',
          { className: 'dmn-empty', 'data-dmn-state': 'empty' },
          h(SvgIcon, { name: 'sigma', size: 22 }),
          h('div', null, t('state.empty')),
          h(
            'button',
            { type: 'button', className: 'dmn-btn', 'data-dmn-action': 'add-first-cell', onClick: function () { addCodeCell(); } },
            h(SvgIcon, { name: 'plus', size: 12 }),
            h('span', null, t('toolbar.addCode')),
          ),
        );
      }

      function renderCells() {
        if (cells.length === 0) return renderEmptyState();
        return cells.map(function (cell, index) {
          return h(CellView, {
            key: cell.id,
            cell: cell,
            index: index,
            readOnly: readOnly === true,
            isFirst: index === 0,
            isLast: index === cells.length - 1,
            t: t,
            mode: viewModes[cell.id] === 'raw' ? 'raw' : 'pretty',
            image: imageInfoOf(cell),
            registerEditor: function (element) {
              if (element) textareaRefs.current.set(cell.id, element);
              else textareaRefs.current.delete(cell.id);
            },
            onCodeChange: updateCellCode,
            onRun: runSingleCell,
            onMove: moveCell,
            onDelete: deleteCell,
            onEditorKeyDown: handleEditorKeyDown,
            onToggleMode: toggleOutputMode,
          });
        });
      }

      const bannerNode = h(BannerView, {
        banner: banner,
        t: t,
        onReload: function () {
          const reload = reloadFromHostRef.current;
          if (typeof reload === 'function') void reload();
        },
        onKeepLocal: keepLocalAndSave,
        onRetrySave: function () {
          void saveNow({ force: true });
        },
        onDismiss: dismissBanner,
      });

      const noteNode =
        note === null
          ? null
          : h(
              'div',
              { className: 'dmn-banner dmn-banner--info', role: 'status', 'data-dmn-banner': 'note' },
              h('div', { className: 'dmn-bannerText' }, h('div', { className: 'dmn-bannerTitle' }, t(note.textKey, note.vars))),
              h(
                'div',
                { className: 'dmn-bannerActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dmn-iconBtn',
                    title: t('banner.dismiss'),
                    'aria-label': t('banner.dismiss'),
                    onClick: function () {
                      setNote(null);
                    },
                  },
                  h(SvgIcon, { name: 'close', size: 12 }),
                ),
              ),
            );

      return h(
        'div',
        {
          className: 'dmn-root',
          'data-dsh-mathematica-notebook': variant,
          'data-dmn-phase': phase,
          onKeyDown: function (event) {
            if ((event.ctrlKey === true || event.metaKey === true) && event.key === 's') {
              event.preventDefault();
              void saveNow({ force: true });
            }
          },
        },
        renderHeader(),
        bannerNode,
        noteNode,
        readOnly === true ? renderReadOnlyNotice() : null,
        saveAsOpen === true ? renderSaveAsForm() : null,
        kernelUnavailable === true && phase === 'ready'
          ? h(
              'div',
              { className: 'dmn-notice dmn-notice--warn', role: 'status', 'data-dmn-notice': 'kernel-unavailable' },
              h(SvgIcon, { name: 'warning', size: 13, className: 'dmn-noticeIcon' }),
              h('div', { className: 'dmn-noticeBody' }, h('div', { className: 'dmn-noticeText' }, t('kernel.hint'))),
            )
          : null,
        phase === 'ready'
          ? h(
              'div',
              { className: 'dmn-scroll', 'data-dmn-scroll': 'true' },
              h('div', { className: 'dmn-cells' }, renderCells()),
            )
          : phase === 'loading'
            ? renderLoadingState()
            : renderErrorState(),
        phase === 'ready'
          ? h(
              'div',
              { className: 'dmn-footer' },
              h('span', { className: 'dmn-footerHint' }, t('footer.shortcuts')),
              h('span', { className: 'dmn-footerCount', 'data-dmn-cell-count': String(cells.length) }, t('status.cellCount', { count: String(cells.length) })),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /** One hand-written stylesheet; every colour/font comes from theme tokens. */
    const STYLES = `
.dmn-root {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: 1.5;
}
.dmn-root *,
.dmn-root *::before,
.dmn-root *::after { box-sizing: border-box; }
.dmn-icon { display: block; flex: none; }
.dmn-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  display: inline-block;
  border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.3));
  border-top-color: var(--dsw-alias-state-business-primary, #4176e6);
  animation: dmn-spin 0.8s linear infinite;
}
.dmn-spinner--large { width: 22px; height: 22px; border-width: 2px; }
@keyframes dmn-spin { to { transform: rotate(360deg); } }

/* ---- header ---------------------------------------------------------- */
.dmn-header {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
}
.dmn-titleRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dmn-brandIcon { color: var(--dsw-alias-label-tertiary, inherit); display: inline-flex; flex: none; }
.dmn-titleBlock { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.dmn-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dmn-path {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dmn-statusGroup { display: flex; align-items: center; gap: 8px; flex: none; }
.dmn-saveFlag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dmn-dirtyDot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #d89614);
}
.dmn-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dmn-badge--readonly {
  border-color: var(--dsw-alias-state-warn-primary, #d89614);
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #d89614));
  background: var(--dsw-alias-state-warn-tertiary, transparent);
}
.dmn-kernel {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  margin-right: auto;
}
.dmn-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #8f8f8f); }
.dmn-dot--running { background: var(--dsw-alias-state-success-primary, #2ea44f); }
.dmn-dot--busy { background: var(--dsw-alias-state-business-primary, #4176e6); }
.dmn-dot--starting { background: var(--dsw-alias-state-warn-primary, #d89614); }
.dmn-dot--stopped { background: var(--dsw-alias-state-idle-primary, #8f8f8f); }
.dmn-dot--unavailable { background: var(--dsw-alias-state-error-primary, #d13438); }
.dmn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dmn-actionButtons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

/* ---- buttons / inputs ------------------------------------------------ */
.dmn-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  margin: 0;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-button-floating-fill, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.12s;
}
.dmn-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.dmn-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 1px;
}
.dmn-btn:disabled { opacity: 0.5; cursor: default; }
.dmn-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4176e6);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dmn-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #2f5fd0); }
.dmn-btn--accent {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 45%, transparent);
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
.dmn-btn--accent:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent);
}
.dmn-iconBtn {
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  padding: 0;
  margin: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
.dmn-iconBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); color: var(--dsw-alias-label-primary, inherit); }
.dmn-iconBtn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 0;
}
.dmn-iconBtn:disabled { opacity: 0.35; cursor: default; }
.dmn-iconBtn--danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, #d13438); }
.dmn-input {
  box-sizing: border-box;
  flex: 1 1 140px;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  outline: none;
}
.dmn-input:focus { border-color: var(--dsw-alias-state-business-primary, #4176e6); }

/* ---- banners / notices ---------------------------------------------- */
.dmn-banner {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-2, transparent);
  font-size: 12px;
  line-height: 18px;
}
.dmn-banner--conflict { border-color: var(--dsw-alias-state-warn-primary, #d89614); background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2, transparent)); }
.dmn-banner--error { border-color: var(--dsw-alias-state-error-primary, #d13438); }
.dmn-banner--info { color: var(--dsw-alias-label-secondary, inherit); }
.dmn-bannerText { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.dmn-bannerTitle { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dmn-bannerSub { color: var(--dsw-alias-label-secondary, inherit); }
.dmn-bannerDetail {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dmn-bannerActions { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.dmn-notice {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
}
.dmn-notice--warn { border-color: var(--dsw-alias-state-warn-primary, #d89614); }
.dmn-noticeIcon { margin-top: 2px; color: var(--dsw-alias-state-warn-primary, #d89614); }
.dmn-noticeBody { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dmn-noticeText { color: var(--dsw-alias-label-secondary, inherit); }
.dmn-noticeActions { display: flex; gap: 6px; flex-wrap: wrap; }
.dmn-saveAsForm {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 10px);
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dmn-saveAsTitle { color: var(--dsw-alias-label-primary, inherit); font-size: 12px; font-weight: 500; line-height: 18px; }
.dmn-saveAsRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

/* ---- cells ---------------------------------------------------------- */
.dmn-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  scrollbar-gutter: stable;
}
.dmn-cells { display: flex; flex-direction: column; gap: 2px; padding: 10px 8px 72px; }
.dmn-cell {
  position: relative;
  display: flex;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 10px;
  border: 0.5px solid transparent;
  transition: background-color 0.12s, border-color 0.12s;
}
.dmn-cell:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.1)); }
.dmn-cell:focus-within {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.1));
  border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
}
.dmn-gutter {
  flex: none;
  width: 34px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding-top: 6px;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.dmn-cellIndex { opacity: 0.75; }
.dmn-runBtn {
  box-sizing: border-box;
  width: 22px;
  height: 22px;
  padding: 0;
  margin: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
.dmn-runBtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16)); color: var(--dsw-alias-label-primary, inherit); }
.dmn-runBtn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 0;
}
.dmn-runBtn:disabled { opacity: 0.4; cursor: default; }
.dmn-textMark { font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-tertiary, inherit); padding-top: 1px; }
.dmn-cellBody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 2px 0 4px; }
.dmn-editorWrap { position: relative; }
.dmn-editor {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 30px;
  margin: 0;
  padding: 5px 34px 5px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: hidden;
  resize: none;
  outline: none;
}
.dmn-editor--text {
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 21px;
}
.dmn-editor:focus { background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.06)); }
.dmn-editor[readonly] { cursor: default; opacity: 0.92; }
.dmn-editor::placeholder { color: var(--dsw-alias-label-tertiary, inherit); opacity: 0.8; }
.dmn-cellTools {
  position: absolute;
  top: 0;
  right: 2px;
  display: flex;
  gap: 1px;
  padding: 1px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: var(--dsw-shadow-lv1, 0 1px 3px rgba(0, 0, 0, 0.12));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}
.dmn-cell:hover .dmn-cellTools,
.dmn-cell:focus-within .dmn-cellTools { opacity: 1; pointer-events: auto; }

/* ---- outputs -------------------------------------------------------- */
.dmn-running {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
}
.dmn-outputs { display: flex; flex-direction: column; gap: 4px; padding: 2px 0 2px; }
.dmn-outputHead { display: flex; align-items: center; gap: 8px; justify-content: space-between; min-height: 18px; }
.dmn-outputMeta {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 10px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  padding-left: 8px;
}
.dmn-seg {
  display: inline-flex;
  align-items: center;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  border-radius: 7px;
  overflow: hidden;
  flex: none;
}
.dmn-segBtn {
  margin: 0;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, inherit);
  font: inherit;
  font-size: 10px;
  line-height: 16px;
  cursor: pointer;
  white-space: nowrap;
}
.dmn-segBtn:hover { color: var(--dsw-alias-label-primary, inherit); }
.dmn-segBtn[aria-pressed="true"] {
  background: var(--dsw-alias-button-ghost-active-fill, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, inherit);
}
.dmn-segBtn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: -2px;
}
.dmn-pre {
  box-sizing: border-box;
  margin: 0;
  padding: 7px 10px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.06));
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-markdown-code-block-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: auto;
  max-height: 420px;
  outline: none;
}
.dmn-pre:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));
  outline-offset: 1px;
}
.dmn-svg {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 8px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.06));
  overflow: auto;
  max-height: 480px;
}
.dmn-svg img { display: block; max-width: 100%; height: auto; background: transparent; }
.dmn-outputEmpty { padding: 4px 8px; color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; line-height: 18px; }
.dmn-messages { display: flex; flex-direction: column; gap: 4px; padding: 2px 0; }
.dmn-msg {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 2px;
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #d89614));
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dmn-msgIcon { margin-top: 3px; }
.dmn-cellError {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 2px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-state-error-primary, #d13438);
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.06));
}
.dmn-cellErrorHead {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--dsw-alias-state-error-primary, #d13438);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.dmn-cellErrorIcon { margin-top: 3px; }
.dmn-errorDetail {
  box-sizing: border-box;
  margin: 0;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}

/* ---- full-pane states ---------------------------------------------- */
.dmn-state {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 13px;
  line-height: 20px;
}
.dmn-stateTitle { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; max-width: 100%; overflow-wrap: anywhere; }
.dmn-stateIcon { color: var(--dsw-alias-label-tertiary, inherit); }
.dmn-state--error .dmn-stateIcon { color: var(--dsw-alias-state-error-primary, #d13438); }
.dmn-stateDetail {
  max-width: 100%;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dmn-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 12px;
  line-height: 18px;
}

/* ---- footer --------------------------------------------------------- */
.dmn-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
}
.dmn-footerHint { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.dmn-footerCount { flex: none; font-variant-numeric: tabular-nums; }
`;

    /**
     * Insert the plugin stylesheet through the framework styles seat when one is
     * available (dynamic client halves receive a `styles` symbol), and otherwise
     * own a `<style>` element like the shipped static bundles do. The returned
     * disposer removes exactly the tag this instance created.
     */
    function insertStyles(ctx, css) {
      let service = null;
      try {
        // `styles` is a free symbol for dynamic halves only; typeof keeps this
        // safe in a static bundle's factory scope.
        if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') service = styles;
      } catch (_error) {
        service = null;
      }
      if (service === null) {
        try {
          if (ctx && ctx.styles && typeof ctx.styles.insert === 'function') service = ctx.styles;
        } catch (_error) {
          service = null;
        }
      }
      if (service !== null) return service.insert(css);
      if (typeof document === 'undefined' || document.head === null) return function () {};
      const tag = document.createElement('style');
      tag.dataset.dshPluginCss = 'dsh-mathematica-notebook';
      tag.textContent = css;
      document.head.appendChild(tag);
      return function () {
        try {
          if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
        } catch (_error) {
          // Removal may race a full document teardown; nothing else to clean.
        }
      };
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    /** Client services this bundle needs (CONTRACT §7). */
    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'connection'];

    /** Build the per-key body injection: the authenticated channel caller + variant. */
    function bodyInject(ctx, variant) {
      return function () {
        return {
          variant: variant,
          call: function (endpoint, payload, signal) {
            return ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);
          },
          // Open a URL in a right-sidebar Browser tab (the DSH-native carrier,
          // an Electron <webview> on Desktop). This is how the compatibility
          // web notebook is embedded instead of re-rendering WL output here.
          openBrowserTab: function (url) {
            return ctx.sidebarRight.openTab('browser', { params: { url: url } });
          },
        };
      };
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'mathematica-notebook: dictionaries');

      ctx.effect(function () {
        return insertStyles(ctx, STYLES);
      }, 'mathematica-notebook: styles');

      // Type A — the page tab opened by the guide card. `multiple` lets a
      // session hold several independent notebooks; `keepMounted` preserves
      // cell state while the tab is docked or backgrounded.
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: PAGE_ID,
          kind: PAGE_KIND,
          keepMounted: true,
          multiple: true,
          title: function () {
            return t('tab.title');
          },
          guide: [
            {
              id: 'new',
              title: function () {
                return t('guide.title');
              },
              description: function () {
                return t('guide.description');
              },
            },
          ],
        });
      }, 'mathematica-notebook: page tab type');

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: PAGE_ID,
              locale: NS,
              inject: bodyInject(ctx, 'page'),
            },
            NotebookSlotBody,
          );
        });
      }, 'mathematica-notebook: page tab body');

      // Type B — `.nb` file resources opened from the Files tree, file links, or
      // the agent tool. The `extension` band beats the generic text preview.
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: FILE_ID,
          kind: FILE_KIND,
          patterns: ['*.nb'],
          priority: 'extension',
          canOpen: function (address) {
            return (
              typeof address === 'string' &&
              /^dsh-resource:\/\/file\//.test(address) &&
              /\.nb([?#]|$)/i.test(address)
            );
          },
          title: function (address) {
            return basenameOf(address);
          },
        });
      }, 'mathematica-notebook: file tab type');

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: FILE_ID,
              locale: NS,
              inject: bodyInject(ctx, 'file'),
            },
            NotebookSlotBody,
          );
        });
      }, 'mathematica-notebook: file tab body');

      // Diagnostic handshake retained from the spike: the agent tool's `debug`
      // action reports whether the authenticated client -> Host path works.
      ctx.effect(function () {
        let disposed = false;
        let attempt = 0;
        let timer = null;
        const hello = function () {
          if (disposed) return;
          attempt += 1;
          try {
            Promise.resolve(
              ctx.connection.rpc.call(CHANNEL, 'hello', {
                client: 'dsh-mathematica-notebook',
                probe: true,
                attempt: attempt,
              }),
            ).catch(function () {
              if (!disposed && attempt < 3) timer = setTimeout(hello, 1500);
            });
          } catch (_error) {
            if (!disposed && attempt < 3) timer = setTimeout(hello, 1500);
          }
        };
        hello();
        return function () {
          disposed = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
      }, 'mathematica-notebook: rpc probe');
    }

    return { inject: inject, apply: apply };
  },
});
