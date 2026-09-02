/** Shared by the HTTP-based channels, so a non-2xx reads the same everywhere. */
export async function postJson(options: {
  url: string
  payload: unknown
  headers?: Record<string, string>
  signal: AbortSignal
  timeoutMs: number
  /** Prefix of the error message, e.g. 'telegram'. */
  label: string
}): Promise<void> {
  const response = await fetch(options.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(options.payload),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
  })
  await assertOk(response, options.label)
}

/**
 * How a non-2xx reads, wherever a channel does its own fetch: the status and the
 * first 300 characters the other side said, because that is usually the whole
 * explanation. A success body is released rather than read, since nothing
 * consumes it and holding it holds the socket.
 */
export async function assertOk(response: Response, label: string): Promise<void> {
  if (response.ok) {
    await response.body?.cancel().catch(() => {})
    return
  }
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  throw new Error(`${label} responded ${response.status}: ${detail}`)
}
