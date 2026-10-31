// Renders the README's demos: headless Chrome steps through each scene of
// scenes.html frame by frame, and ffmpeg turns the frames into a looping GIF.
//
//   node docs/demo/src/render.mjs              all scenes
//   node docs/demo/src/render.mjs catch fix    some of them
//
// Needs Google Chrome (or CHROME=/path/to/chrome) and ffmpeg.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FPS = 25
const SCALE = 2
const WIDTH = Number(process.env.GIF_WIDTH ?? 1440)
const scenes = process.argv.length > 2 ? process.argv.slice(2) : ['catch', 'decide', 'fix', 'quiet']

const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), 'ripple-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--force-color-profile=srgb', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' })

async function json(path, method = 'GET') {
  for (let i = 0; i < 100; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json()
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }
  throw new Error('Chrome did not start')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const waiters = []
  let id = 0
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    } else {
      for (const w of waiters.splice(0)) if (w.method === m.method) w.resolve(m.params); else waiters.push(w)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const once = method => new Promise(resolve => waiters.push({ method, resolve }))
  return new Promise(resolve => (ws.onopen = () => resolve({ send, once, close: () => ws.close() })))
}

try {
  await json('/json/version')
  const page = (await json('/json/list')).find(t => t.type === 'page')
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 600, deviceScaleFactor: SCALE, mobile: false })

  for (const scene of scenes) {
    const url = `${pathToFileURL(join(here, 'scenes.html')).href}?scene=${scene}&capture`
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url })
    await loaded
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => window.SCENE_DURATION)', awaitPromise: true })
    const frames = Math.round(result.value * FPS)
    const dir = mkdtempSync(join(tmpdir(), `ripple-${scene}-`))

    // A frame identical to the one before only lengthens that one, so long
    // still moments cost almost nothing in the GIF.
    const stills = []
    let previous
    for (let i = 0; i < frames; i++) {
      await cdp.send('Runtime.evaluate', { expression: `seek(${i / FPS})` })
      const png = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')
      if (previous?.equals(png)) {
        stills[stills.length - 1].frames++
        continue
      }
      const file = join(dir, `${String(i).padStart(5, '0')}.png`)
      writeFileSync(file, png)
      stills.push({ file, frames: 1 })
      previous = png
    }
    const list = join(dir, 'frames.txt')
    writeFileSync(list, [
      'ffconcat version 1.0',
      ...stills.flatMap(s => [`file '${s.file}'`, `duration ${s.frames / FPS}`]),
      `file '${stills[stills.length - 1].file}'`,
    ].join('\n'))

    const input = ['-f', 'concat', '-safe', '0', '-i', list]
    const prep = `scale=${WIDTH}:-1:flags=lanczos`
    const palette = join(dir, 'palette.png')
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...input, '-vf', `${prep},palettegen=max_colors=256:stats_mode=full`, '-update', '1', palette])
    const gif = join(outDir, `${scene}.gif`)
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', ...input, '-i', palette,
      '-lavfi', `${prep}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-fps_mode', 'vfr', '-loop', '0', gif,
    ])
    rmSync(dir, { recursive: true, force: true })
    console.log(`${scene}.gif  ${stills.length} of ${frames} frames  ${(statSync(gif).size / 1e6).toFixed(1)} MB`)
  }
  cdp.close()
} finally {
  const exited = new Promise(resolve => chrome.once('exit', resolve))
  chrome.kill()
  await exited
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
}
