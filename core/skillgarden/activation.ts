/** Same matching semantics used in ActAuth's scope patterns: '*' matches
 * any run of characters, '?' matches exactly one. Kept independent of any
 * glob library on purpose — this is the whole matcher this module needs. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${withWildcards}$`)
}

/** A skill with no `paths` restriction is always eligible. One with a
 * restriction only activates once a touched file matches one of its
 * glob patterns — mirrors Claude Code's conditional-activation skills. */
export function matchesActivationPaths(paths: string[] | undefined, touchedPath: string): boolean {
  if (!paths || paths.length === 0) return true
  return paths.some((pattern) => globToRegExp(pattern).test(touchedPath))
}
