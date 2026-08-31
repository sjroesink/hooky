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
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new Error(`${options.label} responded ${response.status}: ${detail}`)
  }
}
