// main.ts is mend, one patch tool for every AI edit format, as SPEC.md specifies.
// It implements all of SPEC.md: the command line, output and exit codes, safe paths,
// format detection, the three-tier line matching of section 5, unified diffs (6),
// SEARCH/REPLACE blocks (7), V4A patches (8), JSON edits (9) and the all-or-nothing
// write of section 10. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, for the `R old -> new` output line (section 10). */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: three-tier line matching.
// ---------------------------------------------------------------------------

/** A file's text as lines, with its own line break and whether it ends with one. */
interface FileState {
  lines: string[];
  brk: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', final: false };
  const nl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(brk);
  const final = text.endsWith(brk);
  if (final) lines.pop();
  return { lines, brk, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.brk) + (s.final ? s.brk : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function eqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** All 0-based positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqAt(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..maxTier) with an occurrence at or after `from`; end-of-file chunks only count occurrences ending at the file's last line. */
function firstTier(
  lines: string[],
  O: string[],
  from: number,
  maxTier: number,
  eofOnly: boolean,
): { tier: number; pos: number[] } | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    let pos = occurrences(lines, O, tier, from);
    if (eofOnly) pos = pos.filter((p) => p + O.length === lines.length);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of N: `text`, plus the index in O when it is a context line (null for a `+` line). */
interface NLine {
  text: string;
  ctx: number | null;
}

type BodyKind = 'ctx' | 'old' | 'new';
interface BodyItem {
  kind: BodyKind;
  text: string;
}

/** Split body items into old lines O and new lines N (with context-line links). */
function toON(items: BodyItem[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push({ text: it.text, ctx: O.length - 1 });
    } else if (it.kind === 'old') O.push(it.text);
    else N.push({ text: it.text, ctx: null });
  }
  return { O, N };
}

/**
 * Build the replacement lines for an occurrence at `pos`: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line of N is re-indented
 * (F = leading whitespace of the file's first matched line, P = that of O's first line).
 */
function buildN(O: string[], N: NLine[], file: FileState, pos: number, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && O.length > 0) {
    const F = leadWs(file.lines[pos]!);
    const P = leadWs(O[0]!);
    for (const n of N) {
      if (n.ctx !== null) {
        out.push(file.lines[pos + n.ctx]!);
        continue;
      }
      const t = n.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) out.push(F + t.slice(P.length));
      else out.push(t);
    }
  } else {
    for (const n of N) {
      if (n.ctx !== null) out.push(file.lines[pos + n.ctx]!);
      else out.push(n.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

/** A hunk body item; `bs` is a `\` line (e.g. `\ No newline at end of file`). */
type HunkItem =
  | { kind: 'ctx' | 'old' | 'new'; text: string; empty: boolean }
  | { kind: 'bs' };

interface Hunk {
  /** Old-file start line (1-based) from the hunk header. */
  A: number;
  items: HunkItem[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  lastCtxOrPlusBs: boolean;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const A = Number(m[1]);
  const items: HunkItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', empty: true });
      j++;
    } else if (l[0] === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), empty: false });
      j++;
    } else if (l[0] === '-') {
      items.push({ kind: 'old', text: l.slice(1), empty: false });
      j++;
    } else if (l[0] === '+') {
      items.push({ kind: 'new', text: l.slice(1), empty: false });
      j++;
    } else if (l[0] === '\\') {
      items.push({ kind: 'bs' });
      j++;
    } else break;
  }
  // Trailing empty lines are not part of the hunk body.
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.empty) items.pop();
    else break;
  }
  let lastCtxOrPlusBs = false;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') lastCtxOrPlusBs = items[k + 1]?.kind === 'bs';
  }
  return { hunk: { A, items, lastCtxOrPlusBs }, next: j };
}

/** Header path: text after 4 chars, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Apply a section's hunks to a file's text; throws Fail('no-match', path) on a bad hunk. */
function applyHunks(path: string, before: string, hunks: Hunk[], maxTier: number): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const body: BodyItem[] = [];
    for (const it of h.items) {
      if (it.kind === 'bs') continue;
      body.push({ kind: it.kind, text: it.text });
    }
    const { O, N } = toON(body);
    if (O.length === 0) {
      const pos = Math.min(h.A + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...N.map((n) => n.text));
      d += N.length;
      if (atEnd) f.final = !h.lastCtxOrPlusBs;
      continue;
    }
    const found = firstTier(f.lines, O, 0, maxTier, false);
    if (!found) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const runsToEnd = pos + O.length === f.lines.length;
    const replacement = buildN(O, N, f, pos, found.tier);
    f.lines.splice(pos, O.length, ...replacement);
    d += N.length - O.length;
    if (runsToEnd) f.final = !h.lastCtxOrPlusBs;
  }
  return joinFile(f);
}

/** Whether a `\` line follows the last `+` line of the section (for a created file). */
function lastPlusBs(hunks: Hunk[]): boolean {
  let r = false;
  for (const h of hunks) {
    for (let k = 0; k < h.items.length; k++) {
      if (h.items[k]!.kind === 'new') r = h.items[k + 1]?.kind === 'bs';
    }
  }
  return r;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const r = parseUnifiedSection(lines, i, maxTier);
      edits.push(r.edit);
      i = r.next;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

function parseUnifiedSection(lines: string[], start: number, maxTier: number): { edit: Edit; next: number } {
  let i = start;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let create = false;
  let del = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let hasDash = false;
  if (lines[i]!.startsWith('diff --git ')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[i]!);
    if (!m || m[1]!.trim() === '' || m[2]!.trim() === '') throw new Exit2(`error: parse ${i + 1}`);
    oldPath = m[1]!;
    newPath = m[2]!;
    i++;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const o = headerPath(l);
        const n = headerPath(lines[i + 1]!);
        oldPath = o === '/dev/null' ? null : stripAB(o);
        newPath = n === '/dev/null' ? null : stripAB(n);
        hasDash = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      const n = headerPath(l);
      newPath = n === '/dev/null' ? null : stripAB(n);
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      create = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      del = true;
      i++;
      continue;
    }
    i++;
  }
  const hunks: Hunk[] = [];
  while (i < lines.length && lines[i]!.startsWith('@@')) {
    const r = parseHunk(lines, i);
    hunks.push(r.hunk);
    i = r.next;
  }
  const old = hasDash ? oldPath : (renameFrom ?? oldPath);
  const nw = hasDash ? newPath : (renameTo ?? newPath);
  const isCreate = old === null || create;
  const isDelete = nw === null || del;
  let edit: Edit;
  if (isCreate) {
    const np = nw ?? '';
    const plus: string[] = [];
    for (const h of hunks) {
      for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
    }
    const bs = lastPlusBs(hunks);
    edit = (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
    };
  } else if (isDelete) {
    const op = old ?? '';
    edit = (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  } else if (old !== nw) {
    const op = old ?? '';
    const np = nw ?? '';
    edit = (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(op, before, hunks, maxTier);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push({ old: op, new: np });
    };
  } else {
    const op = old ?? '';
    edit = (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      tree.now.set(op, applyHunks(op, before, hunks, maxTier));
    };
  }
  return { edit, next: i };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let j = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${j + 1}`);
    }
    let m = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        m = k;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${j + 1}`);
    let n = -1;
    for (let k = m + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        n = k;
        break;
      }
    }
    if (n < 0) throw new Exit2(`error: parse ${j + 1}`);
    const oldLines = lines.slice(j + 1, m);
    const newLines = lines.slice(m + 1, n);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, maxTier));
    prevPath = path;
    prevEnd = n + 1;
    i = n + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], maxTier: number): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(f.lines, oldLines, 0, maxTier, false);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const replacement = buildN(oldLines, N, f, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...replacement);
    tree.now.set(path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

function isV4aHeader(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isV4aHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
    // Section lines run to the next header or the End Patch line; trailing blanks are not part of it.
    let e = i + 1;
    while (e < last && !isV4aHeader(lines[e]!)) e++;
    let se = e;
    while (se > i + 1 && blank(lines[se - 1]!)) se--;
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      for (let k = i + 1; k < se; k++) {
        const s = lines[k]!;
        if (s.startsWith('+')) fileLines.push(s.slice(1));
        else if (s === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      if (se > i + 1) throw new Exit2(`error: parse ${i + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = l.slice('*** Update File:'.length).trim();
      let k = i + 1;
      let moveTo: string | null = null;
      if (k < se && lines[k]!.startsWith('*** Move to:')) {
        moveTo = lines[k]!.slice('*** Move to:'.length).trim();
        k++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (k < se) {
        const s = lines[k]!;
        if (s.startsWith('@@')) {
          cur = { anchor: s.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          k++;
        } else if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          cur = null;
          k++;
        } else if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (s === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (s[0] === ' ') cur.body.push({ kind: 'ctx', text: s.slice(1) });
          else if (s[0] === '-') cur.body.push({ kind: 'old', text: s.slice(1) });
          else cur.body.push({ kind: 'new', text: s.slice(1) });
          k++;
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, maxTier));
    }
    i = e;
  }
  return edits;
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], maxTier: number): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = firstTier(f.lines, [ch.anchor], cursor, maxTier, false);
        if (!a) throw new Fail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      const { O, N } = toON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...N.map((n) => n.text));
        cursor = pos + N.length;
      } else {
        const found = firstTier(f.lines, O, cursor, maxTier, ch.eof);
        if (!found) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const replacement = buildN(O, N, f, pos, found.tier);
        f.lines.splice(pos, O.length, ...replacement);
        cursor = pos + replacement.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 10: running the edits, output and exit codes.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  const rows: { key: string; line: string }[] = changed.map((c) => ({
    key: c.p,
    line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}`,
  }));
  for (const m of tree.moves) {
    const oi = rows.findIndex((r) => r.key === m.old && r.line.startsWith('D '));
    const ni = rows.findIndex((r) => r.key === m.new && r.line.startsWith('A '));
    if (oi >= 0 && ni >= 0) {
      rows.splice(Math.max(oi, ni), 1);
      rows.splice(Math.min(oi, ni), 1);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
