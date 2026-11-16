import { extname } from 'node:path'
import type { Protocol, Session } from 'electron'
import { byteRange, fileResponse } from '@ludens/core/server/file-response'
import { mimeTypeForPath, serveStaticFile } from '@ludens/core/server/static-files'
import {
  APP_RPC_ERROR_CODES,
  type MediaResolveParams,
  type MediaResolveResult,
} from '@ludens/protocol/app-rpc'

export const LUDENS_APP_SCHEME = 'ludens-app'
export const LUDENS_MEDIA_SCHEME = 'ludens-media'
export const LUDENS_APP_HOST = 'console'
export const LUDENS_MEDIA_HOST = 'local'
export const LUDENS_APP_ORIGIN = `${LUDENS_APP_SCHEME}://${LUDENS_APP_HOST}`
export const LUDENS_APP_ENTRY_URL = `${LUDENS_APP_ORIGIN}/`
export const LUDENS_MEDIA_ORIGIN = `${LUDENS_MEDIA_SCHEME}://${LUDENS_MEDIA_HOST}`

/**
 * Allows `ludens-app://console` to load local assets, play `ludens-media://local` streams,
 * and open user-configured remote `ws:` / `wss:` / `http:` / `https:` connections via `<ConnectionTargetDialog>`.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self' ludens-app: ludens-media: data: blob:",
  "script-src 'self' ludens-app: 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' ludens-app:",
  "img-src 'self' ludens-app: ludens-media: data: blob: http: https:",
  "media-src 'self' ludens-app: ludens-media: data: blob: http: https:",
  "font-src 'self' ludens-app: data:",
  "connect-src 'self' ludens-app: ludens-media: ws: wss: http: https: data: blob:",
  "worker-src 'self' ludens-app: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const MEDIA_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export type MediaResolver = (
  params: MediaResolveParams,
  signal: AbortSignal,
) => Promise<MediaResolveResult>

export interface AppProtocolHandlerOptions {
  staticDir: string
}

export interface MediaProtocolHandlerOptions {
  resolveMedia: MediaResolver
}

export interface RegisterLudensProtocolsOptions {
  staticDir: string
  resolveMedia: MediaResolver
}

class BadMediaRequestError extends Error {
  readonly status = 400
}

function badMediaRequest(message: string): BadMediaRequestError {
  return new BadMediaRequestError(message)
}

function mediaErrorResponse(status: number, message: string, code?: string): Response {
  return Response.json(
    code ? { error: message, code } : { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...MEDIA_CORS_HEADERS,
      },
    },
  )
}

function bufferMediaResponse(
  request: Request,
  base64Bytes: string,
  mediaType: string,
  cacheControl?: string,
): Response {
  const buffer = Buffer.from(base64Bytes, 'base64')
  const size = buffer.byteLength
  const headers = new Headers({
    'Content-Type': mediaType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl ?? 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...MEDIA_CORS_HEADERS,
  })

  let range: ReturnType<typeof byteRange>
  try {
    range = byteRange(request.headers.get('range'), size)
  } catch {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : Math.max(0, end - start + 1)
  headers.set('Content-Length', String(length))
  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  }

  if (request.method === 'HEAD' || size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  return new Response(range ? buffer.subarray(start, end + 1) : buffer, {
    status: range ? 206 : 200,
    headers,
  })
}

function parseMediaResolveParams(url: URL): MediaResolveParams {
  const kind = url.searchParams.get('kind')
  const project = url.searchParams.get('project')?.trim()
  const run = url.searchParams.get('run')?.trim()
  if (!project || !run) {
    throw badMediaRequest('Missing project or run parameter')
  }

  if (kind === 'asset') {
    const id = url.searchParams.get('id')?.trim()
    if (!id) throw badMediaRequest('Missing asset id parameter')
    return { kind: 'asset', project, run, id }
  }

  if (kind === 'replay') {
    const mode = url.searchParams.get('mode')
    if (mode !== 'media' && mode !== 'segment') {
      throw badMediaRequest('Replay media request requires mode=media or mode=segment')
    }
    const readNumber = (key: string): number | undefined => {
      const raw = url.searchParams.get(key)
      if (raw === null || raw === '') return undefined
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) {
        throw badMediaRequest(`Invalid numeric parameter: ${key}`)
      }
      return parsed
    }
    const epoch = url.searchParams.get('epoch') || undefined
    const id = url.searchParams.get('id') || undefined
    const record = url.searchParams.get('record') || undefined
    const asset = url.searchParams.get('asset') || undefined
    const sequence = readNumber('sequence')
    const media = readNumber('media')
    const bytes = readNumber('bytes')
    return {
      kind: 'replay',
      project,
      run,
      mode,
      ...(epoch ? { epoch } : {}),
      ...(id ? { id } : {}),
      ...(record ? { record } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(media !== undefined ? { media } : {}),
      ...(asset ? { asset } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    }
  }

  throw badMediaRequest("Media request requires kind='asset' or kind='replay'")
}

function mapMediaResolveError(error: unknown): Response {
  if (error instanceof BadMediaRequestError) {
    return mediaErrorResponse(400, error.message, 'BAD_REQUEST')
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return mediaErrorResponse(499, 'Media request aborted', 'ABORTED')
  }
  const errObj = error as { code?: unknown; data?: { status?: unknown; code?: unknown }; message?: string }
  if (typeof errObj?.data?.status === 'number') {
    return mediaErrorResponse(
      errObj.data.status,
      errObj.message ?? 'Media resolution failed',
      typeof errObj.data.code === 'string' ? errObj.data.code : undefined,
    )
  }
  if (errObj?.code === APP_RPC_ERROR_CODES.NOT_FOUND) {
    return mediaErrorResponse(404, errObj.message ?? 'Media not found', 'NOT_FOUND')
  }
  if (
    errObj?.code === APP_RPC_ERROR_CODES.INVALID_PARAMS ||
    errObj?.code === APP_RPC_ERROR_CODES.INVALID_REQUEST
  ) {
    return mediaErrorResponse(400, errObj.message ?? 'Invalid media parameters', 'BAD_REQUEST')
  }
  if (errObj?.code === APP_RPC_ERROR_CODES.UNAUTHORIZED) {
    return mediaErrorResponse(403, errObj.message ?? 'Forbidden', 'FORBIDDEN')
  }
  if (errObj?.code === 'ENOENT' || errObj?.code === 'ENOTDIR') {
    return mediaErrorResponse(404, 'Media file not found', 'NOT_FOUND')
  }
  return mediaErrorResponse(500, errObj?.message ?? 'Internal media protocol error', 'INTERNAL_ERROR')
}

export function buildLudensMediaAssetUrl(input: {
  project: string
  run: string
  id: string
}): string {
  const url = new URL('/media', LUDENS_MEDIA_ORIGIN)
  url.searchParams.set('kind', 'asset')
  url.searchParams.set('project', input.project)
  url.searchParams.set('run', input.run)
  url.searchParams.set('id', input.id)
  return url.href
}

/**
 * Registers `ludens-app` and `ludens-media` as standard, secure privileged schemes.
 * MUST be invoked synchronously before `app.whenReady()`.
 */
export function registerLudensPrivilegedSchemes(
  protocolApi: Pick<Protocol, 'registerSchemesAsPrivileged'>,
): void {
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: LUDENS_APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: LUDENS_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/** Serves `app/out` over `ludens-app://console/...` with MIME resolution, traversal guard, and SPA fallback. */
export function createAppProtocolHandler(
  options: AppProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return Response.json({ error: 'Invalid URL' }, { status: 400 })
    }
    if (
      url.protocol !== `${LUDENS_APP_SCHEME}:` ||
      url.username ||
      url.password ||
      url.hostname.toLowerCase() !== LUDENS_APP_HOST
    ) {
      return Response.json({ error: 'Not Found' }, { status: 404 })
    }

    const response = await serveStaticFile(request, options.staticDir)
    if (response.headers.has('Content-Security-Policy')) {
      response.headers.set('Content-Security-Policy', APP_CONTENT_SECURITY_POLICY)
    }
    if (!response.headers.get('Content-Type') && url.pathname !== '/') {
      response.headers.set('Content-Type', mimeTypeForPath(extname(url.pathname) || 'index.html'))
    }
    return response
  }
}

/** Resolves `ludens-media://local/media?...` via UDS `media/resolve` and streams with full HTTP Range support. */
export function createMediaProtocolHandler(
  options: MediaProtocolHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase()
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
          ...MEDIA_CORS_HEADERS,
        },
      })
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: {
          Allow: 'GET, HEAD, OPTIONS',
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...MEDIA_CORS_HEADERS,
        },
      })
    }

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return mediaErrorResponse(400, 'Invalid media URL', 'BAD_REQUEST')
    }

    if (
      url.protocol !== `${LUDENS_MEDIA_SCHEME}:` ||
      url.username ||
      url.password ||
      url.hostname.toLowerCase() !== LUDENS_MEDIA_HOST ||
      url.pathname !== '/media'
    ) {
      return mediaErrorResponse(404, 'Media endpoint not found', 'NOT_FOUND')
    }

    try {
      const params = parseMediaResolveParams(url)
      const resolved = await options.resolveMedia(params, request.signal)
      if ('file' in resolved && typeof resolved.file === 'string') {
        return await fileResponse(request, resolved, MEDIA_CORS_HEADERS)
      }
      if ('bytes' in resolved && typeof resolved.bytes === 'string') {
        return bufferMediaResponse(
          request,
          resolved.bytes,
          resolved.mediaType,
          resolved.cacheControl,
        )
      }
      return mediaErrorResponse(404, 'Media not found', 'NOT_FOUND')
    } catch (error) {
      return mapMediaResolveError(error)
    }
  }
}

/** Installs `ludens-app://` and `ludens-media://` handlers onto Electron's session inside `app.whenReady()`. */
export function registerLudensProtocols(
  targetSession: Pick<Session, 'protocol'>,
  options: RegisterLudensProtocolsOptions,
): void {
  const handleApp = createAppProtocolHandler({ staticDir: options.staticDir })
  const handleMedia = createMediaProtocolHandler({ resolveMedia: options.resolveMedia })
  targetSession.protocol.handle(LUDENS_APP_SCHEME, handleApp)
  targetSession.protocol.handle(LUDENS_MEDIA_SCHEME, handleMedia)
}
