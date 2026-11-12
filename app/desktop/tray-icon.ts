import * as electron from 'electron'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type LudensTrayTheme = 'dark' | 'light'

export const LUDENS_TRAY_SIZE_1X = 18
export const LUDENS_TRAY_SIZE_2X = 36

export interface LudensTrayPaths {
  readonly variant: LudensTrayTheme
  readonly png1x: string
  readonly png2x: string
}

export interface LudensTrayBuffers {
  readonly variant: LudensTrayTheme
  readonly png1x: Buffer
  readonly png2x: Buffer
}

export interface TrayImageTarget {
  addRepresentation(options: Electron.AddRepresentationOptions): void
}

export interface TrayImageFactory<T extends TrayImageTarget = Electron.NativeImage> {
  createEmpty(): T
}

export function ludensTrayTheme(dark: boolean): LudensTrayTheme {
  return dark ? 'dark' : 'light'
}

export function resolveLudensTrayPaths(publicAssets: string, dark: boolean): LudensTrayPaths {
  const variant = ludensTrayTheme(dark)
  return {
    variant,
    png1x: resolve(publicAssets, 'brand', `ludens-tray-${variant}.png`),
    png2x: resolve(publicAssets, 'brand', `ludens-tray-${variant}@2x.png`),
  }
}

export function readLudensTrayBuffers(publicAssets: string, dark: boolean): LudensTrayBuffers {
  const paths = resolveLudensTrayPaths(publicAssets, dark)
  return {
    variant: paths.variant,
    png1x: readFileSync(paths.png1x),
    png2x: readFileSync(paths.png2x),
  }
}

/**
 * Builds a multi-representation (@1x 18×18 + @2x 36×36) menu bar tray icon
 * directly from integer-grid PNGs with zero bilinear `.resize()` blur and
 * preserving the `#ff4f1f` accent loose pixel across dark/light menu bars.
 */
export function createLudensTrayIcon(publicAssets: string, dark: boolean): Electron.NativeImage
export function createLudensTrayIcon<T extends TrayImageTarget>(
  publicAssets: string,
  dark: boolean,
  factory: TrayImageFactory<T>,
): T
export function createLudensTrayIcon<T extends TrayImageTarget = Electron.NativeImage>(
  publicAssets: string,
  dark: boolean,
  factory?: TrayImageFactory<T>,
): T {
  const { png1x, png2x } = readLudensTrayBuffers(publicAssets, dark)
  const targetFactory = factory ?? (electron.nativeImage as unknown as TrayImageFactory<T>)
  const image = targetFactory.createEmpty()
  image.addRepresentation({
    scaleFactor: 1,
    width: LUDENS_TRAY_SIZE_1X,
    height: LUDENS_TRAY_SIZE_1X,
    dataURL: `data:image/png;base64,${png1x.toString('base64')}`,
  })
  image.addRepresentation({
    scaleFactor: 2,
    width: LUDENS_TRAY_SIZE_2X,
    height: LUDENS_TRAY_SIZE_2X,
    dataURL: `data:image/png;base64,${png2x.toString('base64')}`,
  })
  return image
}
