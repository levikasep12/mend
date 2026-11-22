// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC section 3). */
interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line normalised for a matching tier (SPEC section 5). */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions where O occurs in lines at a tier, searching from `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const n = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== n[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its occurrences. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 1 : 3;
  for (let tier = 0; tier < top; tier++) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** Old lines O and new lines N of one hunk or chunk. For each N line, whether it is a context line and, if so, which O line it is. */
interface Lines2 {
  o: string[];
  n: string[];
  nIsCtx: boolean[];
  nOIdx: number[];
}

/** The lines N writes over O at pos: context lines taken from the file, tier-2 re-indent applied (SPEC section 5). */
function applyHunk(lines: string[], pos: number, h: Lines2, tier: number): string[] {
  const out = lines.slice(0, pos);
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m ? m[0] : '';
  };
  const F = lead(lines[pos] ?? '');
  const P = h.o.length > 0 ? lead(h.o[0]!) : '';
  for (let i = 0; i < h.n.length; i++) {
    if (h.nIsCtx[i]) {
      out.push(lines[pos + h.nOIdx[i]]!);
    } else if (tier === 2 && h.o.length > 0) {
      const l = h.n[i]!;
      out.push(l !== '' && l.trim() !== '' && l.startsWith(P) ? F + l.slice(P.length) : l);
    } else {
      out.push(h.n[i]!);
    }
  }
  out.push(...lines.slice(pos + h.o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, in order: a move edit records (old, new) here so the output can print `R old -> new`. */
  readonly moves: Array<{ old: string; new: string }> = [];
  move(old: string, nw: string, text: string): void {
    this.now.set(old, null);
    this.now.set(nw, text);
    this.moves.push({ old, new: nw });
  }
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

/** One unified hunk (SPEC section 6): its lines plus its old start and its final-break flags. */
interface UniHunk extends Lines2 {
  a: number;
  noFinal: boolean;
  plus: string[];
  plusNoFinal: boolean;
}

/** The path after a `--- ` or `+++ ` line: text after the four characters, up to the first tab, trimmed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a hunk body starting at lines[i], returning the hunk and the index after it. */
function parseHunkBody(lines: string[], i: number): { hunk: UniHunk; next: number } {
  const raw: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nIsCtx: boolean[] = [];
  const nOIdx: number[] = [];
  const plus: string[] = [];
  const kinds: string[] = [];
  for (const l of raw) {
    if (l === '') {
      kinds.push(' ');
      o.push('');
      n.push('');
      nIsCtx.push(true);
      nOIdx.push(o.length - 1);
    } else if (l[0] === ' ') {
      kinds.push(' ');
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      nIsCtx.push(true);
      nOIdx.push(o.length - 1);
    } else if (l[0] === '-') {
      kinds.push('-');
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      kinds.push('+');
      n.push(l.slice(1));
      nIsCtx.push(false);
      nOIdx.push(-1);
      plus.push(l.slice(1));
    } else {
      kinds.push('\\');
    }
  }
  let noFinal = false;
  let plusNoFinal = false;
  for (let k = kinds.length - 1; k >= 0; k--) {
    if (kinds[k] === ' ' || kinds[k] === '+') {
      noFinal = kinds[k + 1] === '\\';
      break;
    }
  }
  for (let k = kinds.length - 1; k >= 0; k--) {
    if (kinds[k] === '+') {
      plusNoFinal = kinds[k + 1] === '\\';
      break;
    }
  }
  return { hunk: { o, n, nIsCtx, nOIdx, a: 0, noFinal, plus, plusNoFinal }, next: j };
}

/** One unified section's edit (SPEC section 6). */
function makeUniEdit(oldPath: string | null, newPath: string | null, create: boolean, remove: boolean, hunks: UniHunk[], strict: boolean): Edit {
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (create || oldPath === null) {
      const np = newPath;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let plusNoFinal = false;
      for (const h of hunks) {
        if (h.plus.length > 0) plusNoFinal = h.plusNoFinal;
        plus.push(...h.plus);
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (plusNoFinal ? '' : '\n'));
      return;
    }
    if (remove || newPath === null) {
      const op = oldPath;
      if (op === null) throw new Fail('unsafe', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (newPath !== op && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let f = splitFile(before);
    let d = 0;
    for (const h of hunks) {
      if (h.o.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const out = applyHunk(f.lines, at, h, 0);
        const endsAtEnd = at === f.lines.length;
        f = { br: f.br, lines: out, final: endsAtEnd ? !h.noFinal : f.final };
      } else {
        const found = findTier(f.lines, h.o, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const endsAtEnd = best + h.o.length === f.lines.length;
        const out = applyHunk(f.lines, best, h, found.tier);
        f = { br: f.br, lines: out, final: endsAtEnd ? !h.noFinal : f.final };
      }
      d += h.n.length - h.o.length;
    }
    const text = joinFile(f);
    if (newPath !== op) tree.move(op, newPath, text);
    else tree.now.set(op, text);
  };
}

/** Parse one unified section starting at lines[start]; returns the index after it. */
function parseUniSection(lines: string[], start: number, edits: Edit[], strict: boolean): number {
  let i = start;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let create = false;
  let remove = false;
  const hunks: UniHunk[] = [];
  let inHeader = true;

  if (lines[i]!.startsWith('diff --git ')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]!.trimEnd());
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    diffOld = m[1]!;
    diffNew = m[2]!;
    i++;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!inHeader || pairOld !== undefined) break;
      pairOld = headerPath(l);
      pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body = parseHunkBody(lines, i + 1);
      body.hunk.a = Number(m[1]);
      hunks.push(body.hunk);
      i = body.next;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) create = true;
      else if (l.startsWith('deleted file mode')) remove = true;
      i++;
      continue;
    }
    i++;
  }
  const oldPath = pairOld !== undefined ? pairOld : renameOld !== null ? renameOld : diffOld;
  const newPath = pairNew !== undefined ? pairNew : renameNew !== null ? renameNew : diffNew;
  edits.push(makeUniEdit(oldPath, newPath, create, remove, hunks, strict));
  return i;
}

/** Read a patch as unified diffs (SPEC section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      i = parseUniSection(lines, i, edits, strict);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** One SEARCH/REPLACE block's edit (SPEC section 7). */
function makeSrEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const out = applyHunk(f.lines, found.occ[0]!, { o: oldLines, n: newLines, nIsCtx: newLines.map(() => false), nOIdx: newLines.map(() => -1) }, found.tier);
    tree.now.set(p, joinFile({ br: f.br, lines: out, final: f.final }));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let lastEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let p: string | null = null;
    for (let j = searchLine - 1; j >= lastEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSrEdit(p, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = p;
    lastEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk (SPEC section 8). */
interface V4aChunk extends Lines2 {
  anchor: string | null;
  eof: boolean;
}

/** One V4A Add File section's edit. */
function makeV4aAdd(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section's edit. */
function makeV4aDelete(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update File section's edit. */
function makeV4aUpdate(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        const anchored = findTier(f.lines, [c.anchor], strict, cursor);
        if (anchored === null) throw new Fail('no-match', p);
        cursor = anchored.occ[0]! + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? f.lines.length : cursor;
        f = { br: f.br, lines: applyHunk(f.lines, at, c, 0), final: f.final };
        cursor = at + c.n.length;
      } else {
        const found = findTier(f.lines, c.o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let pos: number | null = null;
        if (c.eof) {
          const want = f.lines.length - c.o.length;
          if (want >= cursor && found.occ.includes(want)) pos = want;
        } else {
          pos = found.occ[0]!;
        }
        if (pos === null) throw new Fail('no-match', p);
        f = { br: f.br, lines: applyHunk(f.lines, pos, c, found.tier), final: f.final };
        cursor = pos + c.n.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) tree.move(p, moveTo, text);
    else tree.now.set(p, text);
  };
}

/** Read a patch in the V4A format (SPEC section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (s: string): boolean =>
    s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('+') || blank(s)) {
          raw.push(s);
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(makeV4aAdd(p, raw.map((s) => (s.startsWith('+') ? s.slice(1) : ''))));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (blank(s)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(makeV4aDelete(p));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      const raw: Array<{ num: number; text: string }> = [];
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        raw.push({ num: i + 1, text: s });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (let k = 0; k < raw.length; k++) {
        const { num, text: s } = raw[k]!;
        if (k === 0 && s.startsWith('*** Move to: ')) {
          moveTo = s.slice('*** Move to: '.length).trim();
          continue;
        }
        if (s.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${num}`);
        if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (s.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { o: [], n: [], nIsCtx: [], nOIdx: [], anchor: s.slice(2).trim(), eof: false };
          continue;
        }
        if (s === '' || s[0] === ' ' || s[0] === '-' || s[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
            cur = { o: [], n: [], nIsCtx: [], nOIdx: [], anchor: null, eof: false };
          }
          if (s === '') {
            cur.o.push('');
            cur.n.push('');
            cur.nIsCtx.push(true);
            cur.nOIdx.push(cur.o.length - 1);
          } else if (s[0] === ' ') {
            const t = s.slice(1);
            cur.o.push(t);
            cur.n.push(t);
            cur.nIsCtx.push(true);
            cur.nOIdx.push(cur.o.length - 1);
          } else if (s[0] === '-') {
            cur.o.push(s.slice(1));
          } else {
            cur.n.push(s.slice(1));
            cur.nIsCtx.push(false);
            cur.nOIdx.push(-1);
          }
          continue;
        }
        throw new Exit2(`error: parse ${num}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdate(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
            ? srEdits(lines, strict)
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, now);
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      changed.delete(m.old);
      changed.delete(m.new);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const [p, now] of changed) {
    const was = tree.original(p);
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
