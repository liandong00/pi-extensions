const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL, "\\$&");
}

/** Claude-style `*`/`**` matching with ` <star>` accepting a missing suffix. */
export function matchPermissionPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("domain:")) return matchDomain(pattern.slice(7), value);
  const normalizedPattern = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern;

  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    if (char !== "*") {
      source += escapeRegex(char);
      continue;
    }

    const double = normalizedPattern[index + 1] === "*";
    if (double) index += 1;
    const followedBySlash = double && normalizedPattern[index + 1] === "/";
    if (followedBySlash) {
      index += 1;
      source += "(?:.*/)?";
      continue;
    }
    if (index > 0 && normalizedPattern[index - (double ? 2 : 1)] === " ") {
      // Remove the already-emitted literal space and make the entire suffix optional.
      source = source.slice(0, -1);
      source += "(?: .*)?";
      continue;
    }
    source += ".*";
  }
  return new RegExp(`^${source}$`).test(value);
}

/** Gitignore-style path glob: `*` stays within one directory; `**` is recursive. */
export function matchFilePermissionPattern(pattern: string, value: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char !== "*") {
      source += escapeRegex(char);
      continue;
    }
    if (pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }
    source += "[^/]*";
  }
  return new RegExp(`^${source}$`).test(value.split("\\").join("/"));
}

function matchDomain(pattern: string, value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    hostname = value.toLowerCase();
  }
  const expected = pattern.toLowerCase();
  if (expected.startsWith("*.")) {
    const base = expected.slice(2);
    return hostname !== base && hostname.endsWith(`.${base}`);
  }
  return hostname === expected;
}
