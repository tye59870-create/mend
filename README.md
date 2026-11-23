# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tye59870-create/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tye59870-create/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. Give it a patch — a unified diff, a
SEARCH/REPLACE block, a V4A patch, or a JSON edit list — and it applies it to the tree of
text files in the current directory, creating, changing, moving and deleting files as the
patch says. It matches lines fuzzily the way a human would (exact, then trailing
whitespace, then indentation), keeps CRLF files CRLF, and either applies the whole patch
or writes nothing at all.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a path relative to the working directory, or stdin when it is absent or `-`.
Node 22, standard library only; there is nothing to install.

## Formats

`--format` picks one format, or `auto` (the default) detects it per patch:

| Format | Looks like |
| --- | --- |
| `unified` | `diff --git a/x b/x` / `--- a/x` + `+++ b/x`, `@@ -A,B +C,D @@` hunks |
| `search-replace` | a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines, `>>>>>>> REPLACE` |
| `v4a` | `*** Begin Patch` … `*** Add File:` / `*** Delete File:` / `*** Update File:` … `*** End Patch` |
| `json` | one JSON edit object per line, or a JSON array of edit objects |

## Options

- `--check`: report what would change and exit the same way, but write nothing.
- `--strict`: exact line matching only (tier 0); without it, a line also matches after
  removing trailing spaces/tabs (tier 1) and after removing leading and trailing
  spaces/tabs (tier 2), with new lines re-indented to the file's own indentation.
- `--` ends the options, so a patch file whose name starts with `-` can be named.

## Output and exit codes

- Exit 0: one line per changed path in byte order (`A`, `D`, `M`, or `R <old> -> <new>`
  for a move), then `ok: <n> files` (or `ok: 1 file`). A file whose bytes did not change
  is not listed; a patch that changes nothing prints only `ok: 0 files`.
- Exit 1: one `error: <code> <path>` line per failed edit in patch order, then
  `failed: <k> of <n> edits`. Codes are `no-match`, `ambiguous`, `missing`, `exists`
  and `unsafe`. When any edit fails, no file is written, but later edits still run so
  every failure is reported.
- Exit 2, one line: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` (1-based patch line).

Paths must be safe: non-empty, no leading `/`, no `\`, no empty, `.` or `..` segment.
Directories are created as needed. A file keeps its own line break (CRLF or LF) and
whether it ended with one, unless the patch says otherwise.

## Test it

The kit's practice set (100 checks) is graded locally with:

```sh
node check.ts <practice.json>
```

It prints the mismatches, if any, and the practice score. This build passes all 100
checks (practice score 1000).

## License

MIT. See [LICENSE](LICENSE).
