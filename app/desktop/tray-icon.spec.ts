import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  createLudensTrayIcon,
  LUDENS_TRAY_SIZE_1X,
  LUDENS_TRAY_SIZE_2X,
  ludensTrayTheme,
  readLudensTrayBuffers,
  resolveLudensTrayPaths,
} from './tray-icon.js'

const publicAssets = resolve('public')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RING_CELLS = new Set([
  '1,0', '2,0',
  '2,1',
  '2,2', '3,2', '4,2',
  '4,3',
  '3,4', '2,4', '1,4',
  '0,3', '0,2', '0,1',
])
const LOOSE_CELL = '4,0'

function decodeRgbaPng(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatChunks: Buffer[] = []

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  expect(bitDepth).toBe(8)
  expect(colorType).toBe(6)
  expect(interlace).toBe(0)

  const raw = inflateSync(Buffer.concat(idatChunks))
  const rowBytes = width * 4
  const stride = 1 + rowBytes
  expect(raw.length).toBe(height * stride)

  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]
    expect(filter).toBe(0)
    raw.copy(pixels, y * rowBytes, y * stride + 1, y * stride + 1 + rowBytes)
  }

  const pixelAt = (x: number, y: number): [number, number, number, number] => {
    const idx = (y * width + x) * 4
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]]
  }

  return { width, height, pixelAt }
}

describe('Ludens pixel-frame menu bar tray icon', () => {
  it('ships all 4 crisp @1x/@2x PNGs and leaves companion spider tray assets untouched', () => {
    for (const dark of [true, false]) {
      const paths = resolveLudensTrayPaths(publicAssets, dark)
      expect(existsSync(paths.png1x)).toBe(true)
      expect(existsSync(paths.png2x)).toBe(true)
    }
    expect(existsSync(resolve(publicAssets, 'companion/ludens/icons/icon-tray.png'))).toBe(true)
    expect(existsSync(resolve(publicAssets, 'companion/ludens/icons/icon-tray.webp'))).toBe(true)
    expect(existsSync(resolve(publicAssets, 'companion/ludens/icons/icon-tray.svg'))).toBe(true)
  })

  it.each([
    { dark: true, variant: 'dark', ring: [0xf3, 0xf2, 0xee, 0xff] as const },
    { dark: false, variant: 'light', ring: [0x17, 0x18, 0x17, 0xff] as const },
  ])('encodes exact integer-grid $variant @1x (18×18) and @2x (36×36) RGBA pixels with zero blur', ({ dark, variant, ring }) => {
    expect(ludensTrayTheme(dark)).toBe(variant)
    const buffers = readLudensTrayBuffers(publicAssets, dark)
    expect(buffers.variant).toBe(variant)

    const scales = [
      { buf: buffers.png1x, size: LUDENS_TRAY_SIZE_1X, cellSize: 3, margin: 1 },
      { buf: buffers.png2x, size: LUDENS_TRAY_SIZE_2X, cellSize: 6, margin: 3 },
    ]

    for (const { buf, size, cellSize, margin } of scales) {
      const decoded = decodeRgbaPng(buf)
      expect(decoded.width).toBe(size)
      expect(decoded.height).toBe(size)

      const span = cellSize * 5
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const rgba = decoded.pixelAt(x, y)
          const mx = x - margin
          const my = y - margin
          if (mx < 0 || my < 0 || mx >= span || my >= span) {
            expect(rgba).toEqual([0, 0, 0, 0])
            continue
          }
          const cell = `${Math.floor(mx / cellSize)},${Math.floor(my / cellSize)}`
          if (cell === LOOSE_CELL) {
            expect(rgba).toEqual([0xff, 0x4f, 0x1f, 0xff])
          } else if (RING_CELLS.has(cell)) {
            expect(rgba).toEqual([...ring])
          } else {
            expect(rgba).toEqual([0, 0, 0, 0])
          }
        }
      }
    }
  })

  it('constructs a multi-representation NativeImage (@1x + @2x) for dark and light themes without resizing', () => {
    for (const [dark, variant] of [[true, 'dark'], [false, 'light']] as const) {
      const representations: Electron.AddRepresentationOptions[] = []
      const resize = vi.fn()
      const setTemplateImage = vi.fn()
      const image = createLudensTrayIcon(publicAssets, dark, {
        createEmpty: () => ({
          addRepresentation: options => { representations.push(options) },
          resize,
          setTemplateImage,
        }),
      })

      expect(image).toBeDefined()
      expect(resize).not.toHaveBeenCalled()
      expect(setTemplateImage).not.toHaveBeenCalled()
      expect(representations).toHaveLength(2)

      const expected1x = readFileSync(resolve(publicAssets, `brand/ludens-tray-${variant}.png`)).toString('base64')
      const expected2x = readFileSync(resolve(publicAssets, `brand/ludens-tray-${variant}@2x.png`)).toString('base64')

      expect(representations[0]).toEqual({
        scaleFactor: 1,
        width: 18,
        height: 18,
        dataURL: `data:image/png;base64,${expected1x}`,
      })
      expect(representations[1]).toEqual({
        scaleFactor: 2,
        width: 36,
        height: 36,
        dataURL: `data:image/png;base64,${expected2x}`,
      })
    }
  })
})
