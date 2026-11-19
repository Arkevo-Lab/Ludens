import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_RPC_ERROR_CODES, type MediaResolveParams } from '@ludens/protocol/app-rpc'
import {
  APP_CONTENT_SECURITY_POLICY,
  LUDENS_APP_SCHEME,
  LUDENS_MEDIA_SCHEME,
  buildLudensMediaAssetUrl,
  createAppProtocolHandler,
  createMediaProtocolHandler,
  registerLudensPrivilegedSchemes,
  registerLudensProtocols,
} from './custom-protocols.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ludens-custom-protocols-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('custom-protocols', () => {
  it('registers ludens-app and ludens-media as standard secure streaming privileged schemes', () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerLudensPrivilegedSchemes({ registerSchemesAsPrivileged })
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
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
  })

  it('registers both scheme handlers onto Electron session.protocol.handle', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>')
    const registered = new Map<string, (req: Request) => Promise<Response>>()
    const resolveMedia = vi.fn(async () => ({
      bytes: Buffer.from('hello').toString('base64'),
      mediaType: 'text/plain',
    }))

    registerLudensProtocols(
      {
        protocol: {
          handle: (scheme, handler) => {
            registered.set(scheme, handler as (req: Request) => Promise<Response>)
          },
        } as never,
      },
      { staticDir: dir, resolveMedia },
    )

    expect(Array.from(registered.keys()).sort()).toEqual(['ludens-app', 'ludens-media'])
    const appRes = await registered.get('ludens-app')!(new Request('ludens-app://console/'))
    expect(appRes.status).toBe(200)
    const mediaRes = await registered.get('ludens-media')!(
      new Request('ludens-media://local/media?kind=asset&project=p1&run=r1&id=img-1'),
    )
    expect(mediaRes.status).toBe(200)
    expect(await mediaRes.text()).toBe('hello')
  })

  describe('ludens-app static serving & SPA fallback', () => {
    it('serves static assets with MIME types, SPA fallback, and open connect-src CSP', async () => {
      const outDir = makeTempDir()
      mkdirSync(join(outDir, 'assets'), { recursive: true })
      mkdirSync(join(outDir, 'fonts'), { recursive: true })
      writeFileSync(join(outDir, 'index.html'), '<!doctype html><html><body>spa-root</body></html>')
      writeFileSync(join(outDir, 'assets', 'app.js'), 'console.log("ludens")')
      writeFileSync(join(outDir, 'assets', 'app.css'), 'body{color:#fff}')
      writeFileSync(join(outDir, 'icon.svg'), '<svg/>')
      writeFileSync(join(outDir, 'manifest.json'), '{"name":"ludens"}')
      writeFileSync(join(outDir, 'fonts', 'ui.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]))

      const handler = createAppProtocolHandler({ staticDir: outDir })

      const indexRes = await handler(new Request('ludens-app://console/'))
      expect(indexRes.status).toBe(200)
      expect(indexRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      const csp = indexRes.headers.get('Content-Security-Policy')
      expect(csp).toBe(APP_CONTENT_SECURITY_POLICY)
      expect(csp).toContain("connect-src 'self' ludens-app: ludens-media: ws: wss: http: https:")
      expect(await indexRes.text()).toContain('spa-root')

      const jsRes = await handler(new Request('ludens-app://console/assets/app.js'))
      expect(jsRes.status).toBe(200)
      expect(jsRes.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
      expect(jsRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
      expect(await jsRes.text()).toBe('console.log("ludens")')

      const cssRes = await handler(new Request('ludens-app://console/assets/app.css'))
      expect(cssRes.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
      await cssRes.body?.cancel()

      const svgRes = await handler(new Request('ludens-app://console/icon.svg'))
      expect(svgRes.headers.get('Content-Type')).toBe('image/svg+xml')
      await svgRes.body?.cancel()

      const jsonRes = await handler(new Request('ludens-app://console/manifest.json'))
      expect(jsonRes.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
      await jsonRes.body?.cancel()

      const woffRes = await handler(new Request('ludens-app://console/fonts/ui.woff2'))
      expect(woffRes.headers.get('Content-Type')).toBe('font/woff2')
      await woffRes.body?.cancel()

      // Extensionless SPA route falls back to index.html
      const spaRes = await handler(new Request('ludens-app://console/workspaces/proj-1/live'))
      expect(spaRes.status).toBe(200)
      expect(spaRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      expect(await spaRes.text()).toContain('spa-root')

      // Missing file with extension returns 404 (not index.html)
      const missingAsset = await handler(new Request('ludens-app://console/assets/missing.js'))
      expect(missingAsset.status).toBe(404)
    })

    it('blocks encoded traversal, symlinks outside static root, and untrusted hosts', async () => {
      const parentDir = makeTempDir()
      const outDir = join(parentDir, 'out')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'index.html'), '<html>ok</html>')
      writeFileSync(join(parentDir, 'secret.txt'), 'top-secret')
      symlinkSync(join(parentDir, 'secret.txt'), join(outDir, 'escaped.txt'))

      const handler = createAppProtocolHandler({ staticDir: outDir })

      const encodedSlashTraversal = await handler(new Request('ludens-app://console/%2e%2e%2fsecret.txt'))
      expect(encodedSlashTraversal.status).toBe(403)

      const unnormalizedRequest = {
        url: 'ludens-app://console/%2e%2e/secret.txt',
        method: 'GET',
        headers: new Headers(),
        signal: new AbortController().signal,
      } as Request
      const rawEncodedTraversal = await handler(unnormalizedRequest)
      expect(rawEncodedTraversal.status).toBe(403)

      const normalizedDotTraversal = await handler(new Request('ludens-app://console/../secret.txt'))
      expect(normalizedDotTraversal.status).toBe(404)

      const backslashTraversal = await handler(new Request('ludens-app://console/..%5csecret.txt'))
      expect(backslashTraversal.status).toBe(403)

      const escapedSymlink = await handler(new Request('ludens-app://console/escaped.txt'))
      expect(escapedSymlink.status).toBe(403)

      const wrongHost = await handler(new Request('ludens-app://other/index.html'))
      expect(wrongHost.status).toBe(404)
    })
  })

  describe('ludens-media resolution and Range slicing', () => {
    it('resolves file-backed media and serves full + 206 Partial Content + 416 Range responses', async () => {
      const dir = makeTempDir()
      const videoPath = join(dir, 'recording.mp4')
      const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
      writeFileSync(videoPath, payload)

      const seenParams: MediaResolveParams[] = []
      const handler = createMediaProtocolHandler({
        resolveMedia: async params => {
          seenParams.push(params)
          return {
            file: videoPath,
            size: payload.byteLength,
            mediaType: 'video/mp4',
            cacheControl: 'public, max-age=3600',
          }
        },
      })

      const replayUrl = 'ludens-media://local/media?kind=replay&project=proj-a&run=run-1&epoch=ep-2&mode=segment&sequence=7&id=seg-7'
      const fullRes = await handler(new Request(replayUrl))
      expect(fullRes.status).toBe(200)
      expect(fullRes.headers.get('Content-Type')).toBe('video/mp4')
      expect(fullRes.headers.get('Accept-Ranges')).toBe('bytes')
      expect(fullRes.headers.get('Content-Length')).toBe(String(payload.byteLength))
      expect(Buffer.from(await fullRes.arrayBuffer())).toEqual(payload)
      expect(seenParams[0]).toEqual({
        kind: 'replay',
        project: 'proj-a',
        run: 'run-1',
        epoch: 'ep-2',
        mode: 'segment',
        sequence: 7,
        id: 'seg-7',
      })

      const rangeRes = await handler(
        new Request(replayUrl, { headers: { Range: 'bytes=10-19' } }),
      )
      expect(rangeRes.status).toBe(206)
      expect(rangeRes.headers.get('Content-Range')).toBe(`bytes 10-19/${payload.byteLength}`)
      expect(rangeRes.headers.get('Content-Length')).toBe('10')
      expect(rangeRes.headers.get('Accept-Ranges')).toBe('bytes')
      expect(rangeRes.headers.get('Content-Type')).toBe('video/mp4')
      expect(Buffer.from(await rangeRes.arrayBuffer()).toString()).toBe('ABCDEFGHIJ')

      const suffixRes = await handler(
        new Request(replayUrl, { headers: { Range: 'bytes=-5' } }),
      )
      expect(suffixRes.status).toBe(206)
      expect(suffixRes.headers.get('Content-Range')).toBe(`bytes 31-35/${payload.byteLength}`)
      expect(Buffer.from(await suffixRes.arrayBuffer()).toString()).toBe('VWXYZ')

      const badRangeRes = await handler(
        new Request(replayUrl, { headers: { Range: 'bytes=999-1024' } }),
      )
      expect(badRangeRes.status).toBe(416)
      expect(badRangeRes.headers.get('Content-Range')).toBe(`bytes */${payload.byteLength}`)

      const headRangeRes = await handler(
        new Request(replayUrl, { method: 'HEAD', headers: { Range: 'bytes=0-3' } }),
      )
      expect(headRangeRes.status).toBe(206)
      expect(headRangeRes.headers.get('Content-Length')).toBe('4')
      expect(await headRangeRes.text()).toBe('')
    })

    it('supports base64 buffer responses with Range and maps RPC/URL errors cleanly', async () => {
      const sample = Buffer.from('PNG_BINARY_CONTENT')
      const handler = createMediaProtocolHandler({
        resolveMedia: async params => {
          if (params.kind === 'asset' && params.id === 'missing') {
            throw Object.assign(new Error('Asset missing'), { code: APP_RPC_ERROR_CODES.NOT_FOUND })
          }
          return {
            bytes: sample.toString('base64'),
            mediaType: 'image/png',
          }
        },
      })

      const assetUrl = buildLudensMediaAssetUrl({ project: 'ws-1', run: 'run-9', id: 'obs-1' })
      expect(assetUrl).toBe('ludens-media://local/media?kind=asset&project=ws-1&run=run-9&id=obs-1')

      const partial = await handler(new Request(assetUrl, { headers: { Range: 'bytes=4-9' } }))
      expect(partial.status).toBe(206)
      expect(partial.headers.get('Content-Range')).toBe(`bytes 4-9/${sample.byteLength}`)
      expect(await partial.text()).toBe('BINARY')

      const notFound = await handler(
        new Request(buildLudensMediaAssetUrl({ project: 'ws-1', run: 'run-9', id: 'missing' })),
      )
      expect(notFound.status).toBe(404)

      const wrongHost = await handler(new Request('ludens-media://remote/media?kind=asset&project=p&run=r&id=1'))
      expect(wrongHost.status).toBe(404)

      const badQuery = await handler(new Request('ludens-media://local/media?kind=replay&project=p&run=r&mode=media&sequence=abc'))
      expect(badQuery.status).toBe(400)
    })

    it('proxies remoteUrl (presigned S3 GET) with zero-CORS HTTP Range 200 / 206 / 416 / HEAD streaming', async () => {
      const payload = Buffer.from('S3_SEGMENT_0123456789_ABCDEFGHIJKLMNOP')
      const seenRanges: Array<string | undefined> = []

      const s3Server = createHttpServer((req, res) => {
        if (req.url?.startsWith('/missing')) {
          res.writeHead(404, { 'Content-Type': 'application/xml' })
          res.end('<Error><Code>NoSuchKey</Code></Error>')
          return
        }
        const range = req.headers.range
        seenRanges.push(range)
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range)
          if (!match) {
            res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` })
            res.end()
            return
          }
          const start = Number(match[1])
          const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1
          if (start >= payload.length || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` })
            res.end()
            return
          }
          const slice = payload.subarray(start, end + 1)
          res.writeHead(206, {
            'Content-Type': 'binary/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${payload.length}`,
            'Content-Length': String(slice.length),
          })
          res.end(req.method === 'HEAD' ? undefined : slice)
          return
        }
        res.writeHead(200, {
          'Content-Type': 'binary/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(payload.length),
        })
        res.end(req.method === 'HEAD' ? undefined : payload)
      })

      await new Promise<void>(resolveListen => s3Server.listen(0, '127.0.0.1', () => resolveListen()))
      const addr = s3Server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      try {
        const handler = createMediaProtocolHandler({
          resolveMedia: async params => {
            if (params.kind === 'replay' && params.id === 'missing') {
              return {
                remoteUrl: `http://127.0.0.1:${port}/missing?X-Amz-Signature=deadbeef`,
                size: payload.byteLength,
                mediaType: 'video/mp4',
              }
            }
            return {
              remoteUrl: `http://127.0.0.1:${port}/bucket/ws-1/video/seg-1.mp4?X-Amz-Signature=cafebabe`,
              size: payload.byteLength,
              mediaType: 'video/mp4',
              cacheControl: 'private, max-age=31536000, immutable',
            }
          },
        })

        const segUrl =
          'ludens-media://local/media?kind=replay&project=ws-1&run=run-1&mode=segment&sequence=1&record=rec-1&media=0'

        const fullRes = await handler(new Request(segUrl))
        expect(fullRes.status).toBe(200)
        expect(fullRes.headers.get('Content-Type')).toBe('video/mp4')
        expect(fullRes.headers.get('Accept-Ranges')).toBe('bytes')
        expect(fullRes.headers.get('Content-Length')).toBe(String(payload.byteLength))
        expect(fullRes.headers.get('Access-Control-Allow-Origin')).toBe('*')
        expect(Buffer.from(await fullRes.arrayBuffer())).toEqual(payload)
        expect(seenRanges[0]).toBeUndefined()

        const partialRes = await handler(
          new Request(segUrl, { headers: { Range: 'bytes=11-20' } }),
        )
        expect(partialRes.status).toBe(206)
        expect(seenRanges[1]).toBe('bytes=11-20')
        expect(partialRes.headers.get('Content-Range')).toBe(`bytes 11-20/${payload.byteLength}`)
        expect(partialRes.headers.get('Content-Length')).toBe('10')
        expect(partialRes.headers.get('Accept-Ranges')).toBe('bytes')
        expect(partialRes.headers.get('Content-Type')).toBe('video/mp4')
        expect(Buffer.from(await partialRes.arrayBuffer()).toString()).toBe('0123456789')

        const badRangeRes = await handler(
          new Request(segUrl, { headers: { Range: 'bytes=500-600' } }),
        )
        expect(badRangeRes.status).toBe(416)
        expect(badRangeRes.headers.get('Content-Range')).toBe(`bytes */${payload.byteLength}`)

        const headRangeRes = await handler(
          new Request(segUrl, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }),
        )
        expect(headRangeRes.status).toBe(206)
        expect(headRangeRes.headers.get('Content-Length')).toBe('10')
        expect(await headRangeRes.text()).toBe('')

        const missingRes = await handler(
          new Request(
            'ludens-media://local/media?kind=replay&project=ws-1&run=run-1&mode=segment&id=missing',
          ),
        )
        expect(missingRes.status).toBe(404)
      } finally {
        await new Promise<void>(resolveClose => s3Server.close(() => resolveClose()))
      }
    })
  })
})
