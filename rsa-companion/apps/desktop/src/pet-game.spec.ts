// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const root = resolve('ui/public/companion')
const read = (name: string) => readFileSync(resolve(root, name), 'utf8')
type Activity = { type: 'show'; displayId: string; input: { title: string; description: string; block: { id: string; kind: string; title: string; text: string; status: string } } }
let activity: ((event: Activity) => void) | undefined
let renderer: { startGame(): void; setLocale(locale: string): void; stop(): void }
let pending: { src: string; resolve: () => void }[]

beforeEach(async () => {
  vi.useFakeTimers()
  document.body.innerHTML = read('index.html').match(/<body>([\s\S]*)<\/body>/)![1]
  pending = []
  activity = undefined
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
  vi.stubGlobal('DOMMatrixReadOnly', class { a = 1 })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  Object.assign(window, { companion: {
    onActivity(callback: (event: Activity) => void) { activity = callback },
    onSound() {}, onCursor() {}, onFlip() {}, onPose() {}, onLocale() {}, onGame() {},
    interactive() {}, reducedMotion() {}, ready() {},
  } })
  for (const image of document.querySelectorAll('img')) image.decode = async () => {}
  vi.stubGlobal('Image', class {
    src = ''; naturalWidth = 2; naturalHeight = 1
    decode() { const { promise, resolve } = Promise.withResolvers<void>(); pending.push({ src: this.src, resolve }); return promise }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {}, getImageData: () => ({ width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]) }),
  } as unknown as CanvasRenderingContext2D)
  renderer = new Function(read('companion-i18n.cjs') + '\n' + read('log-content.js') + '\n' + read('ludens/catalog.js') + '\n' + read('pet-state.js') + '\n' + read('pet.js') +
    '\nreturn {startGame,setLocale,stop:()=>{clearInterval(poseTimer);stopGame()}};')()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  for (const image of pending) image.resolve()
  await Promise.resolve()
  pending = []
})

afterEach(() => {
  renderer?.stop()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'companion')
  document.body.replaceChildren()
})

it('scores catches, finishes at 20 seconds and retains the session best', () => {
  renderer.startGame()
  vi.advanceTimersByTime(20)
  const target = document.querySelector<HTMLButtonElement>('#game-target')!
  expect(target.hidden).toBe(false)
  for (let score = 1; score <= 10; score++) {
    target.click()
    expect(document.querySelector('#game-score')?.textContent).toBe(`★ ${score} / 10`)
    vi.advanceTimersByTime(120)
  }
  vi.advanceTimersByTime(19_000)
  expect(document.querySelector('#game')?.hidden).toBe(true)
  expect(document.querySelector('#message')?.textContent).toContain('Star catcher!')
  expect(document.querySelector('#message')?.textContent).toContain('10 stars · Best: 10')
  renderer.startGame()
  vi.advanceTimersByTime(20_000)
  expect(document.querySelector('#message')?.textContent).toContain('0 stars · Best: 10')
})

it('exits cleanly with Escape', () => {
  renderer.startGame()
  vi.advanceTimersByTime(20)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('#game')?.hidden).toBe(true)
  expect(document.querySelector('#game-target')?.hidden).toBe(true)
  expect(document.querySelector('#bubble')?.classList.contains('open')).toBe(false)
})

it('immediately yields the game and pose to live activity', () => {
  renderer.startGame()
  vi.advanceTimersByTime(20)
  activity!({ type: 'show', displayId: 'activity-1', input: {
    title: 'Thinking', description: 'Inspect the evidence',
    block: { id: 'block-1', kind: 'thinking', title: 'Thinking', text: 'Inspect the evidence', status: 'running' },
  } })
  expect(document.querySelector('#game')?.hidden).toBe(true)
  expect(document.querySelector('#message')?.textContent).toContain('Inspect the evidence')
  expect(document.querySelector('#bubble')?.classList.contains('open')).toBe(true)
  expect(pending.at(-1)?.src).toContain('07-think')
})
