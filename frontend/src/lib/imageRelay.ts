export const RELAY_URL = (import.meta.env.VITE_IMAGE_RELAY_URL ?? 'https://frameronin-api.emssion.com').replace(/\/+$/, '')
export const UPSTREAM_URL = 'https://new.orbitix.site/v1'

export type RelaySession = { token: string; changeRequired: boolean }
export type ImageMode = 'images' | 'chat'
type Generation = { apiKey: string; mode: ImageMode; model: string; prompt: string }

export class ImageRequestError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, status?: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

export function imageRequestErrorText(error: unknown, t: (key: string) => string) {
  if (!(error instanceof ImageRequestError)) return t('relayError_generic')
  const key = `relayError_${error.code}`
  const translated = t(key)
  const text = translated === key ? t('relayError_generic') : translated
  return error.status ? `${text} (HTTP ${error.status})` : text
}

async function jsonRequest(url: string, body: object, auth?: string, throughRelay = false): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${auth}` }) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new ImageRequestError(throughRelay ? 'relay_unavailable' : 'direct_unavailable')
  }
  if (response.status === 204) return null
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ImageRequestError(throughRelay && typeof data?.error === 'string' ? data.error : 'upstream_error',
      throughRelay ? data?.upstreamStatus : response.status)
  }
  return data
}

export async function relayRequest(path: string, body: object, token?: string) {
  if (!RELAY_URL) throw new ImageRequestError('relay_unavailable')
  return jsonRequest(`${RELAY_URL}${path}`, body, token, true)
}

export async function signIn(username: string, password: string, setupCode: string): Promise<RelaySession> {
  const result = await relayRequest('/login', { username, password, setupCode }) as Partial<RelaySession> | null
  if (typeof result?.token !== 'string' || typeof result.changeRequired !== 'boolean') {
    throw new ImageRequestError('relay_unavailable')
  }
  return { token: result.token, changeRequired: result.changeRequired }
}

function imageSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=\s]+$/i.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch { /* The response may contain text or image markup instead of a URL. */ }
  return undefined
}

function unpackImage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const result = data as {
    data?: Array<{ b64_json?: string; url?: string }>
    choices?: Array<{ message?: { content?: unknown; images?: unknown } }>
  }
  for (const item of Array.isArray(result.data) ? result.data : []) {
    const source = imageSource(item?.url) || (item?.b64_json && imageSource(`data:image/png;base64,${item.b64_json}`))
    if (source) return source
  }
  for (const choice of Array.isArray(result.choices) ? result.choices : []) {
    const message = choice?.message
    const parts = [...(Array.isArray(message?.images) ? message.images : []), ...(Array.isArray(message?.content) ? message.content : [])]
    for (const part of parts) {
      const source = imageSource(part?.image_url?.url ?? part?.image_url ?? part?.url)
      if (source) return source
    }
    if (typeof message?.content === 'string') {
      const source = imageSource(message.content.trim()) || imageSource(message.content.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1])
      if (source) return source
    }
  }
  return undefined
}

export async function generateImage(generation: Generation, host: string, token?: string) {
  const { apiKey, mode, model, prompt } = generation
  let response: unknown
  if (token) {
    response = await relayRequest('/generate', generation, token)
  } else {
    let address: URL
    try {
      address = new URL(host)
    } catch {
      throw new ImageRequestError('invalid_host')
    }
    if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) {
      throw new ImageRequestError('invalid_host')
    }
    const base = address.href.replace(/\/+$/, '')
    response = mode === 'images'
      ? await jsonRequest(`${base}/images/generations`, { model, prompt, n: 1 }, apiKey)
      : await jsonRequest(`${base}/chat/completions`, { model, messages: [{ role: 'user', content: prompt }], stream: false }, apiKey)
  }
  const image = unpackImage(response)
  if (!image) throw new ImageRequestError('no_image')
  return image
}
