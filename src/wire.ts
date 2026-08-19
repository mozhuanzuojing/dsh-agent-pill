/**
 * Wire helpers for the /pill JSON API: bounded body reading, response
 * writing, and the shared error envelope. Mirrors the dsh-better-sidebar
 * wire pattern (BSD-3-Clause) so every API method returns
 * `{ok: true, value}` / `{ok: false, error: {code, message}}`.
 */

/** Machine-readable error codes of the pill API. */
export type PillErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'goal-error'
  | 'subagent-error'
  | 'job-error'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class PillError extends Error {
  constructor(
    readonly code: PillErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** The request face route handlers see (structural subset of node IncomingMessage). */
export interface PillHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** The response face route handlers write to (structural subset of ServerResponse). */
export interface PillHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: PillHttpRequest): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new PillError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new PillError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response with the given status. */
export function writeJson(res: PillHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
export function writeOk(res: PillHttpResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
export function writeError(res: PillHttpResponse, error: unknown): void {
  if (error instanceof PillError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a string, else throw bad-request. */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new PillError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}
