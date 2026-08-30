// The email channel's *receiving* side — turning a clicked link (or a
// submitted form) back into a `POST /pending-approvals/:id/resolve`/
// `POST /pending-questions/:id/answer` call. The *sending* side needs no
// example anymore: `AgentConfig.httpNotifier`'s `channel: 'email'`
// already builds it for you (`core/http-notifier.ts` constructs
// `core/http-notify-triggers/email.ts`'s `EmailNotifier` — one
// instance implementing both `DurableApprover` and `DurableQuestionHandler`,
// sending a signed, expiring magic-link token per approval/question),
// from one `{to, sendEmail, resolveBaseUrl, answerBaseUrl, signingSecret}`.
// Import `EmailNotifier` directly instead, only if you need it as
// a `RunAgentOptions.approver`/`questionHandler` value rather than
// through `AgentConfig`.
//
// This file imports `verifyMagicLink` from
// `core/http-notify-triggers/email.ts` rather than reimplementing it —
// unlike Slack/Lark (where the platform itself signs the callback, so
// sending and receiving genuinely don't share any crypto), email's
// magic link is signed by *our own* sending code and must be verified
// with the exact same algorithm and secret; two independently-written
// copies could silently drift apart, so there's exactly one
// implementation, imported here rather than copy-pasted.
//
// The one thing that makes email a genuinely different integration than
// Slack/Lark, not just "a different send API": a clicked email link is a
// plain browser GET request — there's no interactivity payload, no
// signature header a chat platform would attach, nothing stopping a
// copied or forwarded link from being replayed — see
// core/http-notify-triggers/email.ts's own header comment for the full
// reasoning behind the signed, expiring token this verifies.
//
// What this file is for, and the one thing that genuinely IS still yours
// to deploy: the GET/POST routes the magic links point at — an HTTP
// endpoint (and, for questions, a tiny HTML form) only the host can
// deploy, same "sending built for you, receiving you deploy" split every
// other channel here has. The two concerns need genuinely different
// receiving shapes, unlike Slack/Lark's single dispatcher: an approval
// resolves in one hop (click the link, done), but a free-text answer
// can't be captured by a link click alone (a GET request carries no
// body) — Slack solved this with a modal, Lark with a form card; email's
// own equivalent is a tiny HTML form page, needing a second hop (a GET
// renders the form, a POST from that form actually submits the typed
// answer). Suggested options (if the model gave any) still work as
// one-click links — each link's own signed token already carries the
// answer, so clicking it resolves immediately with no extra page.
import { verifyMagicLink } from '#core/http-notify-triggers/email.js'
import type { SendEmail } from '#core/agent-config.js'

async function callLoopengine(
  path: string,
  body: Record<string, unknown>,
  options: { loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<{ alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }> {
  const authHeader: Record<string, string> = options.loopengineAdminAuth
    ? { authorization: `Basic ${Buffer.from(options.loopengineAdminAuth).toString('base64')}` }
    : {}
  const res = await fetch(`${options.loopengineBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  })
  const resBody = (await res.json()) as { alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }
  if (!res.ok) throw new Error(`email notifier-handler: ${path} failed: ${resBody.error ?? res.status}`)
  return resBody
}

/** Call this from the GET route you pointed `resolveBaseUrl` at (the
 * `EmailNotifier` constructor option) — NOT loopengine's own
 * address; a browser follows a clicked link with a plain GET and no
 * request body, so it can't hit `POST /pending-approvals/:id/resolve`
 * directly even if pointed there. This verifies the token, then makes
 * that POST *for* the human, server-side, and returns a small HTML
 * confirmation page for your route to serve back. */
export async function handleEmailApprovalClick(
  token: string,
  options: { signingSecret: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<string> {
  const payload = verifyMagicLink(token, options.signingSecret)
  if (!payload?.decision) return renderPage('Link expired or invalid', 'This approval link is no longer valid — it may have already been used, or it’s expired.')

  let body: { alreadyResolved?: boolean; resolved?: boolean; text?: string }
  try {
    body = await callLoopengine(`/pending-approvals/${encodeURIComponent(payload.pendingId)}/resolve`, { decision: payload.decision }, options)
  } catch (err) {
    return renderPage('Something went wrong', err instanceof Error ? err.message : String(err))
  }

  if (body.alreadyResolved) return renderPage('Already resolved', 'Someone already decided this one.')
  const verb = payload.decision === 'approve' ? 'Approved' : 'Denied'
  return renderPage(verb, body.resolved ? 'Recorded — the turn is still waiting on other pending items.' : `Recorded — the turn resumed: ${body.text ?? ''}`)
}

async function submitAnswer(
  pendingId: string,
  answer: string,
  options: { loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<{ ok: true; text?: string; resolved?: boolean } | { ok: false; error: string }> {
  try {
    const body = await callLoopengine(`/pending-questions/${encodeURIComponent(pendingId)}/answer`, { answer }, options)
    return { ok: true, text: body.alreadyResolved ? 'Already answered.' : body.resolved ? undefined : body.text, resolved: body.resolved }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Call this from the GET route `answerBaseUrl` points at. Two outcomes,
 * both rendered as plain HTML for your route to serve back:
 *   - the token carries an `answer` already (a suggested-option link) →
 *     resolves immediately, same one-hop shape as
 *     handleEmailApprovalClick above.
 *   - it doesn't (the "type your own" link) → renders a small form
 *     (via renderAnswerForm below) instead; submitting it is a separate
 *     POST, handled by handleEmailQuestionAnswerSubmit below. `postUrl`
 *     is the path that POST should hit — your own route's path (typically
 *     the same one this GET request itself came in on, distinguished by
 *     method, same convention adapters/http.ts itself uses throughout),
 *     not derived from anything on the token. */
export async function handleEmailQuestionAnswerPage(
  token: string,
  postUrl: string,
  options: { signingSecret: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<string> {
  const payload = verifyMagicLink(token, options.signingSecret)
  if (!payload) return renderPage('Link expired or invalid', 'This link is no longer valid — it may have already been used, or it’s expired.')

  if (payload.answer !== undefined) {
    const result = await submitAnswer(payload.pendingId, payload.answer, options)
    return result.ok
      ? renderPage('Answer recorded', result.text ? `The turn resumed: ${result.text}` : 'The turn is still waiting on other pending items, or already continued.')
      : renderPage('Something went wrong', result.error)
  }

  return renderAnswerForm(token, postUrl)
}

/** Call this from the POST route your form (rendered by
 * handleEmailQuestionAnswerPage above) submits to — typically the same
 * path, distinguished by HTTP method. */
export async function handleEmailQuestionAnswerSubmit(
  token: string,
  answer: string,
  options: { signingSecret: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<string> {
  const payload = verifyMagicLink(token, options.signingSecret)
  if (!payload) return renderPage('Link expired or invalid', 'This link is no longer valid — it may have already been used, or it’s expired.')
  if (!answer.trim()) return renderPage('No answer given', 'Go back and type something before submitting.')

  const result = await submitAnswer(payload.pendingId, answer, options)
  return result.ok
    ? renderPage('Answer recorded', result.text ? `The turn resumed: ${result.text}` : 'The turn is still waiting on other pending items, or already continued.')
    : renderPage('Something went wrong', result.error)
}

/** This file's own confirmation pages interpolate values that ultimately
 * trace back to the model or a human (an error message, a resumed turn's
 * own reply text) — escaped before ever reaching an HTML template, same
 * as any other untrusted-input-into-HTML boundary. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`
}

/** The actual form markup handleEmailQuestionAnswerPage renders for the
 * "type your own" case. `token` is base64url-plus-`.`-separator by
 * construction (see core/http-notify-triggers/email.ts's own
 * signMagicLink), so it can't actually carry HTML-special characters —
 * escaped anyway, since that safety is incidental to the encoding, not a
 * guarantee this function should rely on. `postUrl` is this file's own
 * route path, not user input, but costs nothing to escape too. */
function renderAnswerForm(token: string, postUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">
<h1>Your answer</h1>
<form method="post" action="${escapeHtml(postUrl)}">
  <input type="hidden" name="token" value="${escapeHtml(token)}" />
  <textarea name="answer" rows="4" style="width:100%" autofocus></textarea>
  <p><button type="submit">Send</button></p>
</form>
</body></html>`
}

// --- One illustrative SendEmail, backed by Resend's plain HTTP API (no
// SDK dependency — a single fetch call). Swap for SendGrid/Postmark/SMTP
// by writing a different function of the same SendEmail shape. ---

export function createExampleResendSendEmail(apiKey: string, from: string): SendEmail {
  return async (to, subject, html) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    })
    if (!res.ok) throw new Error(`Resend send failed: HTTP ${res.status}`)
  }
}

// --- Wiring, illustrative only ---
//
// AgentConfig.httpNotifier builds the sending side — nothing to write:
//
// httpNotifier: {
//   channel: 'email',
//   config: {
//     to: 'oncall@yourcompany.com',
//     sendEmail: createExampleResendSendEmail(process.env.RESEND_API_KEY!, 'agent@yourcompany.com'),
//     resolveBaseUrl: 'https://yourapp.com/email/approvals',
//     answerBaseUrl: 'https://yourapp.com/email/questions',
//     signingSecret: process.env.EMAIL_LINK_SIGNING_SECRET!,
//   },
//   events: ['approval', 'question'],
// }
//
// import { createServer } from 'node:http'
//
// createServer(async (req, res) => {
//   const url = new URL(req.url!, 'https://yourapp.com')
//   const commonOptions = {
//     signingSecret: process.env.EMAIL_LINK_SIGNING_SECRET!,
//     loopengineBaseUrl: 'http://localhost:8787',
//     loopengineAdminAuth: process.env.LOOPENGINE_ADMIN_AUTH,
//   }
//
//   if (url.pathname === '/email/approvals') {
//     const html = await handleEmailApprovalClick(url.searchParams.get('token') ?? '', commonOptions)
//     res.writeHead(200, { 'content-type': 'text/html' }).end(html)
//     return
//   }
//
//   if (url.pathname === '/email/questions' && req.method === 'GET') {
//     const html = await handleEmailQuestionAnswerPage(url.searchParams.get('token') ?? '', url.pathname, commonOptions)
//     res.writeHead(200, { 'content-type': 'text/html' }).end(html)
//     return
//   }
//
//   if (url.pathname === '/email/questions' && req.method === 'POST') {
//     let body = ''
//     req.on('data', (chunk) => (body += chunk))
//     req.on('end', async () => {
//       const form = new URLSearchParams(body)
//       const html = await handleEmailQuestionAnswerSubmit(form.get('token') ?? '', form.get('answer') ?? '', commonOptions)
//       res.writeHead(200, { 'content-type': 'text/html' }).end(html)
//     })
//   }
// }).listen(3003)
