/**
 * True when `candidatePath` is the project root or a path inside it.
 *
 * Only `/` separates a child from its parent. A previous `<root>--<suffix>`
 * clause — borrowed from Claude Code's encoded *directory names*, where `--`
 * is meaningful — leaked into real path comparison and made `.../app` match
 * the sibling directory `.../app--secret`, indexing and serving another
 * project's transcripts.
 */
export function pathMatchesProject(candidatePath: string, projectRoot: string): boolean {
  const candidate = normalizeProjectPath(candidatePath);
  const root = normalizeProjectPath(projectRoot);
  return candidate === root || candidate.startsWith(`${root}/`);
}

/**
 * Encode a project root the way Claude Code names its store directories:
 * every `.`, `:`, `\`, `/` and `_` becomes `-`. The leading separator is part
 * of that encoding on POSIX (`/Users/me/app` -> `-Users-me-app`); stripping it
 * meant the name never matched the directory on disk, so macOS and Linux
 * projects scraped nothing. Windows paths start with a drive letter and are
 * unaffected.
 *
 * `.` and `_` were missing until 2026-09-04, and their absence silently cost a
 * project its entire Claude Code history: `QueHay_Net` was looked for under
 * `...-quehay_net` while the tool had written `...-quehay-net`, so
 * `filterProjectDirs` never opened the directory and the per-record `cwd`
 * check that attributes correctly never got the chance to run. Underscores in
 * repository names are common; xtctx's own directory happens to have none,
 * which is why nothing caught this.
 *
 * The set is measured rather than inferred from the tool's source: 134
 * directories in a real `~/.claude/projects`, each compared against the `cwd`
 * recorded inside its own transcripts, differ in exactly these characters plus
 * case. Long paths are a separate case this does not handle — Claude Code
 * truncates those and appends a random suffix, which nothing can reconstruct;
 * `projectStoreDir`, taken from the hook payload, is the answer there.
 *
 * Collapsing more characters makes the encoded name less distinctive, so two
 * projects (`my_app` and `my-app`) can share one. That collision already
 * existed for `:` `\` `/` and is safe for the same reason: this name only
 * decides which directories are worth opening, and each record's own `cwd`
 * decides whose it is.
 */
export function encodePathForToolDirectory(projectRoot: string): string {
  return projectRoot.replace(/[.:\\/_]/g, "-").replace(/-+$/g, "");
}

function normalizeProjectPath(value: string): string {
  let normalized = value.trim();
  if (/^file:/i.test(normalized)) {
    normalized = fileUrlToPathLike(normalized);
  } else {
    normalized = decodePathLike(normalized);
  }

  const cleaned = normalized
    .replace(/\\/g, "/")
    .replace(/^\/([a-zA-Z]:\/)/, "$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/g, "");

  return foldCase(resolveTraversal(cleaned));
}

/**
 * Collapse `.` and `..` segments lexically.
 *
 * The candidate is a `cwd` another tool wrote into a transcript, so it is
 * untrusted: without this, `<root>/../other-client/secret.ts` starts with
 * `<root>/` and is served as this project's content. Resolution has to be
 * lexical rather than `realpath` — these paths come from a file, frequently
 * describe a machine or a directory that no longer exists, and a filesystem
 * lookup would turn a comparison into an I/O call on every record.
 *
 * A leading `..` that would climb above the root is dropped rather than kept,
 * so a path can never escape upward into a prefix that matches something else.
 */
function resolveTraversal(path: string): string {
  // A `.` or `..` segment is one that starts the path or follows a slash, so
  // that is what the fast path has to test for. It used to look for the
  // substring `./`, which a *trailing* traversal does not contain: `<root>/..`
  // went through unresolved and then matched `<root>/` by prefix, making the
  // project's parent directory read as inside it.
  //
  // `/a/b.txt` still short-circuits — its dot does not follow a slash — so the
  // common case is unchanged. `/a/.config/b` now parses and comes back
  // identical, which costs a split and is the price of being right.
  if (!path.startsWith(".") && !path.includes("/.")) {
    return path;
  }

  const leadingSlash = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return (leadingSlash ? "/" : "") + out.join("/");
}

/**
 * Case-fold only where the filesystem does.
 *
 * Windows and macOS default to case-insensitive, so `H:/App` and `H:/app` are
 * one directory and must compare equal. On a case-sensitive filesystem they
 * are two different projects, and folding them together merged their
 * transcripts — the same boundary breach from the other direction.
 */
function foldCase(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}

function fileUrlToPathLike(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") {
      return value;
    }

    const path = decodePathLike(url.pathname);
    return url.hostname ? `//${url.hostname}${path}` : path;
  } catch {
    return decodePathLike(value);
  }
}

function decodePathLike(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
