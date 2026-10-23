/**
 * Real `.nb` codec (CONTRACT.md §4).
 *
 * Cells are serialized to genuine Wolfram notebook files with
 * `Export[path, Notebook[{...}]]` and parsed back with `Import[path, "NB"]`.
 * All conversion happens inside the kernel so the unevaluated code never leaks
 * into an evaluated expression:
 *
 *   save:   held = ToExpression[code, InputForm, HoldComplete];
 *           boxes = held /. HoldComplete[...] :> ToBoxes[Defer[...], StandardForm]
 *   load:   held = ToExpression[BoxData, StandardForm, HoldComplete];
 *           str  = held /. HoldComplete[e_] :> ToString[HoldForm[e], InputForm];
 *           code = StringTake[str, {10, -2}]   (* strips "HoldForm[" *)
 *
 * Multi-statement cells are common (`a = 1;\nb = 2`) and the kernel then
 * returns a multi-argument `HoldComplete[e1, ..., en]`; the single-expression
 * recipe above only matches `HoldComplete[e_]`. The codec therefore formats
 * each held statement separately with a `HoldAllComplete` function (verified
 * side-effect free on the real kernel), combines the row boxes with newlines
 * on save, and joins the per-statement InputForm strings with `";\n"` on load.
 *
 * Cells are `code | text`. Anything that does not map exactly to one of those
 * (foreign cell styles, unparseable input cells) is imported as a text cell
 * with `exact: false`, which makes the store mark the document `readOnly`
 * while still displaying its content (CONTRACT.md §2 open).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wlStringLiteral } from '../kernel/kernel.js';
import { ErrorCodes, PluginError, invalidPayload } from './errors.js';

/** Cell styles stored/edited as Wolfram code. */
export const CODE_CELL_STYLES = Object.freeze(['Input', 'Code']);
/** Cell styles stored/edited as plain text. */
export const TEXT_CELL_STYLES = Object.freeze(['Text']);
/** Cell styles that are display output and are never round-tripped in v1. */
export const OUTPUT_CELL_STYLES = Object.freeze(['Output', 'Print', 'Message', 'Echo']);

/** Default maximum `.nb` size the codec will read (bytes). */
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Hard cap on the number of cells a single notebook may contain. */
const MAX_CELLS = 5000;

/** WL helper that renders one held expression's boxes without evaluating it. */
function boxesFunctionDefinition() {
  return 'fmt = Function[Null, ToBoxes[Defer[#], StandardForm], HoldAllComplete];';
}

/** WL helper that renders one held expression's InputForm string without evaluating it. */
function codeFunctionDefinition() {
  return 'fmt = Function[Null, With[{s = ToString[HoldForm[#], InputForm]}, StringTake[s, {10, -2}]], HoldAllComplete];';
}

/**
 * Build the Wolfram program that writes `cells` to a real `.nb` file.
 *
 * The cell list travels through a temporary JSON file, so arbitrary code text
 * (quotes, backslashes, Unicode, newlines) never needs WL string escaping.
 *
 * @param {string} cellsJsonPath
 * @param {string} notebookPath
 * @returns {string}
 */
export function buildWriteProgram(cellsJsonPath, notebookPath) {
  const inputLiteral = wlStringLiteral(cellsJsonPath);
  const outputLiteral = wlStringLiteral(notebookPath);
  return [
    'Module[{data, cells, build, fmt, status},',
    `  ${boxesFunctionDefinition()}`,
    '  build[item_] := Module[{kind = item["kind"], code = item["code"], held, boxList, boxes},',
    '    If[kind =!= "code", Return[Cell[code, "Text"]]];',
    '    If[StringTrim[code] === "", Return[Cell[BoxData[""], "Input"]]];',
    '    held = ToExpression[code, InputForm, HoldComplete];',
    '    If[Head[held] =!= HoldComplete, Return[Cell[code, "Input"]]];',
    '    boxList = Apply[List, Map[fmt, held]];',
    '    boxes = Which[boxList === {}, "", Length[boxList] === 1, First[boxList], True, RowBox[Riffle[boxList, "\\n"]]];',
    '    Cell[BoxData[boxes], "Input"]];',
    `  data = Quiet[Check[Import[${inputLiteral}, "RawJSON"], $Failed]];`,
    '  cells = If[data === $Failed, {}, Map[build, data]];',
    '  status = Quiet[Check[',
    `    Export[${outputLiteral}, Notebook[cells], "NB"];`,
    `    TrueQ[Head[Quiet[Import[${outputLiteral}, "NB"]]] === Notebook],`,
    '    $Failed]];',
    '  If[TrueQ[status], 1, 2]',
    ']',
  ].join('\n');
}

/**
 * Build the Wolfram program that imports a `.nb` file and exports the extracted
 * cell list as JSON to a temporary file.
 *
 * @param {string} notebookPath
 * @param {string} cellsJsonPath
 * @returns {string}
 */
export function buildReadProgram(notebookPath, cellsJsonPath) {
  const inputLiteral = wlStringLiteral(notebookPath);
  const outputLiteral = wlStringLiteral(cellsJsonPath);
  return [
    'Module[{nb, items, out, build, fmt, flattenStrings},',
    `  ${codeFunctionDefinition()}`,
    '  flattenStrings[e_] := If[Head[e] === String, e, StringJoin @@ Cases[e, _String, Infinity]];',
    '  build[cell_] := Module[{style, content, kind, code, exact, held, raw, valid},',
    '    style = If[Length[cell] >= 2 && Head[cell[[2]]] === String, cell[[2]], ""];',
    '    content = If[Length[cell] >= 1, cell[[1]], ""];',
    '    kind = Which[',
    '      MemberQ[{"Input", "Code"}, style], "code",',
    '      MemberQ[{"Text"}, style], "text",',
    '      MemberQ[{"Output", "Print", "Message", "Echo"}, style], "output",',
    '      True, "foreign"];',
    '    code = ""; exact = False;',
    '    If[kind === "code",',
    '      If[Head[content] === BoxData && First[content] === "",',
    '        code = ""; exact = True,',
    '        held = Quiet[Check[ToExpression[content, StandardForm, HoldComplete], $Failed]];',
    '        If[Head[held] === HoldComplete && Length[held] >= 1,',
    '          raw = Apply[List, Map[fmt, held]];',
    '          raw = DeleteCases[raw, "Null"];',
    '          code = If[raw === {}, "", If[Length[raw] === 1, First[raw], StringRiffle[raw, ";\\n"]]];',
    '          valid = Quiet[Check[Head[ToExpression[code, InputForm, HoldComplete]] === HoldComplete, False]];',
    '          exact = TrueQ[valid]];',
    '        If[!TrueQ[exact], code = If[Head[content] === String, content, flattenStrings[content]]]],',
    '      code = If[Head[content] === String, content, flattenStrings[content]];',
    '      exact = kind === "text"];',
    '    <|"style" -> style, "kind" -> kind, "code" -> code, "exact" -> TrueQ[exact]|>];',
    `  nb = Quiet[Check[Import[${inputLiteral}, "NB"], $Failed]];`,
    '  items = If[Head[nb] === Notebook && Length[nb] >= 1 && Head[First[nb]] === List, First[nb], {}];',
    '  out = Map[build, items];',
    `  Quiet[Check[Export[${outputLiteral}, <|"ok" -> (Head[nb] === Notebook), "cells" -> out|>, "JSON"], $Failed]];`,
    '  1',
    ']',
  ].join('\n');
}

/** Normalize a codec input cell list, rejecting malformed entries early. */
export function normalizeCellsForWrite(cells) {
  if (!Array.isArray(cells)) throw invalidPayload('"cells" must be an array', { field: 'cells' });
  if (cells.length > MAX_CELLS) throw invalidPayload(`"cells" must contain at most ${MAX_CELLS} cells`, { field: 'cells' });
  return cells.map((cell, index) => {
    if (!cell || typeof cell !== 'object') throw invalidPayload(`cells[${index}] must be an object`, { field: `cells[${index}]` });
    const kind = cell.kind === undefined ? 'code' : cell.kind;
    if (kind !== 'code' && kind !== 'text') throw invalidPayload(`cells[${index}].kind must be "code" or "text"`, { field: `cells[${index}].kind` });
    if (typeof cell.code !== 'string') throw invalidPayload(`cells[${index}].code must be a string`, { field: `cells[${index}].code` });
    return { kind, code: cell.code };
  });
}

/**
 * Cells <-> real `.nb` codec backed by the kernel manager.
 */
export class NotebookCodec {
  /**
   * @param {object} options
   * @param {object} options.kernel KernelManager-like (`evaluate`)
   * @param {string} [options.tempDir]
   * @param {(message: string) => void} [options.logger]
   * @param {number} [options.maxFileBytes]
   */
  constructor({ kernel, tempDir = tmpdir(), logger = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
    if (!kernel || typeof kernel.evaluate !== 'function') throw new TypeError('NotebookCodec requires a kernel manager');
    this.kernel = kernel;
    this.tempDir = tempDir;
    this.logger = typeof logger === 'function' ? logger : null;
    this.maxFileBytes = maxFileBytes;
  }

  _tempPath(extension) {
    return join(this.tempDir, `dsh-notebook-${randomBytes(8).toString('hex')}${extension}`);
  }

  _remove(path) {
    try {
      if (path && existsSync(path)) unlinkSync(path);
    } catch {
      /* best effort */
    }
  }

  /** True when `payload.result` / `result_inputform` reported the success sentinel 1. */
  _successSentinel(payload) {
    if (payload?.result === 1) return true;
    const text = String(payload?.result_inputform ?? '').trim();
    return text === '1';
  }

  /**
   * Write cells to a real `.nb` file (creates or overwrites).
   *
   * @param {string} notebookPath absolute target path
   * @param {Array<{kind?: string, code: string}>} cells
   * @returns {Promise<void>}
   */
  async writeNotebook(notebookPath, cells) {
    if (typeof notebookPath !== 'string' || !notebookPath) throw invalidPayload('notebook path is required');
    const normalized = normalizeCellsForWrite(cells);
    const cellsJsonPath = this._tempPath('.json');
    try {
      writeFileSync(cellsJsonPath, JSON.stringify(normalized), 'utf8');
      const program = buildWriteProgram(cellsJsonPath, notebookPath);
      const result = await this.kernel.evaluate(program, { timeoutSeconds: 120, label: 'nb-write' });
      if (result.ok && this._successSentinel({ result: result.decoded, result_inputform: result.resultInputform })) {
        return;
      }
      const detail = [
        result.ok ? '' : result.error?.message,
        result.text ? result.text.slice(0, 500) : '',
        result.messages?.length ? `messages: ${result.messages.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' — ');
      throw new PluginError(ErrorCodes.EVALUATION_FAILED, `could not write the Mathematica notebook${detail ? `: ${detail}` : ''}`, {
        path: notebookPath,
      });
    } finally {
      this._remove(cellsJsonPath);
    }
  }

  /**
   * Write an empty valid notebook (CONTRACT.md §2 create).
   *
   * @param {string} notebookPath
   * @returns {Promise<void>}
   */
  async writeEmptyNotebook(notebookPath) {
    return this.writeNotebook(notebookPath, []);
  }

  /**
   * Import a real `.nb` file and map its cells.
   *
   * @param {string} notebookPath absolute path (must exist)
   * @returns {Promise<{cells: Array<{kind: 'code'|'text', code: string, exact: boolean, style: string}>,
   *   outputCount: number, foreignStyles: string[], notANotebook: boolean}>}
   */
  async readNotebook(notebookPath) {
    if (typeof notebookPath !== 'string' || !notebookPath) throw invalidPayload('notebook path is required');
    if (!existsSync(notebookPath)) throw new PluginError(ErrorCodes.NOT_FOUND, `notebook not found: ${notebookPath}`, { path: notebookPath });
    let size = 0;
    try {
      size = statSync(notebookPath).size;
    } catch {
      size = 0;
    }
    if (size > this.maxFileBytes) {
      throw new PluginError(ErrorCodes.TOO_LARGE, `notebook is larger than the ${Math.round(this.maxFileBytes / (1024 * 1024))} MiB limit`, {
        path: notebookPath,
        size,
      });
    }
    const cellsJsonPath = this._tempPath('.json');
    try {
      const program = buildReadProgram(notebookPath, cellsJsonPath);
      const result = await this.kernel.evaluate(program, { timeoutSeconds: 120, label: 'nb-read' });
      if (!result.ok) {
        throw new PluginError(ErrorCodes.EVALUATION_FAILED, `could not import the Mathematica notebook: ${result.error?.message ?? 'kernel error'}`, {
          path: notebookPath,
        });
      }
      let json;
      try {
        json = JSON.parse(readFileSync(cellsJsonPath, 'utf8'));
      } catch (error) {
        throw new PluginError(ErrorCodes.EVALUATION_FAILED, `could not parse the imported notebook cells: ${error?.message ?? error}`, {
          path: notebookPath,
        });
      }
      const rawCells = Array.isArray(json?.cells) ? json.cells : [];
      const cells = [];
      const foreignStyles = [];
      let outputCount = 0;
      for (const raw of rawCells) {
        const style = typeof raw?.style === 'string' ? raw.style : '';
        const kind = raw?.kind;
        if (kind === 'output') {
          outputCount += 1;
          continue;
        }
        if (kind === 'code') {
          cells.push({ kind: 'code', code: String(raw?.code ?? ''), exact: raw?.exact === true, style });
          continue;
        }
        if (kind === 'text') {
          cells.push({ kind: 'text', code: String(raw?.code ?? ''), exact: true, style });
          continue;
        }
        // Foreign styling: display its text but mark the import read-only.
        if (!foreignStyles.includes(style)) foreignStyles.push(style);
        cells.push({ kind: 'text', code: String(raw?.code ?? ''), exact: false, style });
      }
      return { cells, outputCount, foreignStyles, notANotebook: json?.ok !== true };
    } finally {
      this._remove(cellsJsonPath);
    }
  }
}

export { DEFAULT_MAX_FILE_BYTES, MAX_CELLS };
