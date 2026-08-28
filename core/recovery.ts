// Vendored from the reflowkit npm package (MIT license), renamed from
// Reflow to Recovery — a more generic name matching what it actually
// does rather than a package brand. Wraps a model API call with
// reactive recovery for the three cases no major SDK handles
// automatically: a request rejected as too long, a request rejected for
// oversized media, and a response cut off by hitting the output token
// limit. Generic retry/backoff (429/5xx) is deliberately out of scope —
// every SDK already does that.
export type RecoveryAction = 'prompt_too_long' | 'media_too_large' | 'truncated_retry'

export interface RecoveryResult<T> {
  value: T
  /** Ordered log of what happened, empty if the first attempt just worked. */
  recoveries: RecoveryAction[]
  /** True if the final result is still truncated after exhausting retries
   * (or if no onTruncated hook was provided at all). */
  truncated: boolean
}

export interface RecoveryOptions<TMessages> {
  /** Called when a request is rejected as too large. Return a smaller
   * message list to retry with. No default — an unhandled too-long
   * error propagates rather than being guessed at. */
  onPromptTooLong?: (messages: TMessages) => TMessages | Promise<TMessages>
  /** Called when a request is rejected for oversized media. Same
   * fail-loud default as onPromptTooLong. */
  onMediaTooLarge?: (messages: TMessages) => TMessages | Promise<TMessages>
  /** Called when a response comes back truncated. Return adjusted
   * messages to retry with, or undefined to stop and accept the
   * truncated result. */
  onTruncated?: (messages: TMessages, attempt: number) => TMessages | undefined | Promise<TMessages | undefined>
  /** Cap on truncation-recovery attempts. Default 2. */
  maxTruncationRetries?: number
  /** Cap on prompt-too-long/media-too-large recovery attempts combined —
   * a safety limit so a broken recovery hook can't loop forever burning
   * API calls. Default 3. */
  maxRecoveryAttempts?: number
  /** Override the default Anthropic/OpenAI-shaped error classifier. */
  isPromptTooLong?: (error: unknown) => boolean
  isMediaTooLarge?: (error: unknown) => boolean
  isTruncated?: (response: unknown) => boolean
}

/** Heuristic defaults covering Anthropic- and OpenAI-shaped errors and
 * responses. Deliberately not exhaustive — override via RecoveryOptions
 * for other providers or stricter matching. Duck-typed on purpose, so
 * this stays independent of either SDK's own error/response classes. */
function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message).toLowerCase()
  }
  return ''
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code).toLowerCase()
  }
  return ''
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status: unknown }).status)
    return Number.isNaN(status) ? undefined : status
  }
  return undefined
}

const TOO_LONG_PATTERNS = ['prompt is too long', 'too many tokens', 'maximum context length', 'context_length_exceeded', 'input length', 'exceeds the maximum']

export function defaultIsPromptTooLong(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== 400 && status !== 413) return false
  if (codeOf(error) === 'context_length_exceeded') return true
  const message = messageOf(error)
  return TOO_LONG_PATTERNS.some((pattern) => message.includes(pattern))
}

const MEDIA_PATTERNS = ['image', 'media', 'file size', 'attachment']
const SIZE_PATTERNS = ['too large', 'exceeds', 'size limit', 'too big']

export function defaultIsMediaTooLarge(error: unknown): boolean {
  const status = statusOf(error)
  if (status !== 400 && status !== 413) return false
  const message = messageOf(error)
  const mentionsMedia = MEDIA_PATTERNS.some((pattern) => message.includes(pattern))
  const mentionsSize = SIZE_PATTERNS.some((pattern) => message.includes(pattern))
  return mentionsMedia && mentionsSize
}

export function defaultIsTruncated(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false
  const r = response as { stop_reason?: unknown; choices?: unknown }
  if (r.stop_reason === 'max_tokens') return true // Anthropic
  const choices = r.choices
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const choice = choices[0] as { finish_reason?: unknown }
    if (choice.finish_reason === 'length') return true // OpenAI
  }
  return false
}

/** Wraps a model API call with reactive recovery — see this file's own
 * header comment for the three cases it covers. */
export class Recovery<TMessages> {
  private readonly onPromptTooLong?: (messages: TMessages) => TMessages | Promise<TMessages>
  private readonly onMediaTooLarge?: (messages: TMessages) => TMessages | Promise<TMessages>
  private readonly onTruncated?: (messages: TMessages, attempt: number) => TMessages | undefined | Promise<TMessages | undefined>
  private readonly maxTruncationRetries: number
  private readonly maxRecoveryAttempts: number
  private readonly isPromptTooLong: (error: unknown) => boolean
  private readonly isMediaTooLarge: (error: unknown) => boolean
  private readonly isTruncated: (response: unknown) => boolean

  constructor(options: RecoveryOptions<TMessages> = {}) {
    this.onPromptTooLong = options.onPromptTooLong
    this.onMediaTooLarge = options.onMediaTooLarge
    this.onTruncated = options.onTruncated
    this.maxTruncationRetries = options.maxTruncationRetries ?? 2
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3
    this.isPromptTooLong = options.isPromptTooLong ?? defaultIsPromptTooLong
    this.isMediaTooLarge = options.isMediaTooLarge ?? defaultIsMediaTooLarge
    this.isTruncated = options.isTruncated ?? defaultIsTruncated
  }

  async call<T>(fn: (messages: TMessages) => Promise<T>, messages: TMessages): Promise<RecoveryResult<T>> {
    let currentMessages = messages
    const recoveries: RecoveryAction[] = []
    let value: T

    // Stage 1: recover from prompt-too-long / media-too-large, capped so
    // a broken recovery hook can't loop forever burning API calls.
    let attempts = 0
    for (;;) {
      try {
        value = await fn(currentMessages)
        break
      } catch (error) {
        attempts++
        if (attempts > this.maxRecoveryAttempts) throw error
        if (this.isPromptTooLong(error) && this.onPromptTooLong) {
          currentMessages = await this.onPromptTooLong(currentMessages)
          recoveries.push('prompt_too_long')
          continue
        }
        if (this.isMediaTooLarge(error) && this.onMediaTooLarge) {
          currentMessages = await this.onMediaTooLarge(currentMessages)
          recoveries.push('media_too_large')
          continue
        }
        throw error
      }
    }

    // Stage 2: recover from output truncation, bounded.
    let truncated = this.isTruncated(value)
    let truncationAttempt = 0
    while (truncated && this.onTruncated && truncationAttempt < this.maxTruncationRetries) {
      const nextMessages = await this.onTruncated(currentMessages, truncationAttempt)
      if (nextMessages === undefined) break
      currentMessages = nextMessages
      value = await fn(currentMessages)
      recoveries.push('truncated_retry')
      truncated = this.isTruncated(value)
      truncationAttempt++
    }

    return { value, recoveries, truncated }
  }
}
