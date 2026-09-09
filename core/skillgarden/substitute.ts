/** Replaces `$ARGUMENTS` with the raw args string, and `$1`/`$2`/... with
 * whitespace-split positional args — the same placeholder convention
 * skill authors already expect from Claude Code's own Skill tool. */
export function substituteArguments(body: string, args?: string): string {
  const argString = args ?? ''
  let result = body.replaceAll('$ARGUMENTS', argString)

  const positional = argString.split(/\s+/).filter(Boolean)
  result = result.replace(/\$(\d+)/g, (_match, indexStr: string) => {
    const index = Number(indexStr)
    return positional[index - 1] ?? ''
  })

  return result
}
