/**
 * The iNFT's field color, read from its own poster.
 *
 * Not every token bakes scenery into the GLB (ATLAS ships none) or declares
 * `background_color` in metadata — but every iNFT has a poster rendered ON
 * its field. Sampling the poster's border pixels recovers that field for any
 * collection, past or future. Irys/IPFS gateways reflect the request Origin
 * in CORS, so an anonymous crossOrigin load keeps the canvas readable; a
 * tainted or failed read resolves null and the stage falls back to ink.
 */

const cache = new Map<string, Promise<null | string>>()

const SAMPLE = 48

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0')
}

function sample(url: string): Promise<null | string> {
  return new Promise(resolve => {
    const image = new Image()

    image.crossOrigin = 'anonymous'

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')

        canvas.width = SAMPLE
        canvas.height = SAMPLE

        const ctx = canvas.getContext('2d', { willReadFrequently: true })

        if (!ctx) {
          resolve(null)

          return
        }

        ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE)

        // Border ring only — the subject sits center-frame, the field owns
        // the edges.
        const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data
        let r = 0
        let g = 0
        let b = 0
        let n = 0

        for (let y = 0; y < SAMPLE; y++) {
          for (let x = 0; x < SAMPLE; x++) {
            if (x > 2 && x < SAMPLE - 3 && y > 2 && y < SAMPLE - 3) {
              continue
            }

            const i = (y * SAMPLE + x) * 4

            if (data[i + 3] < 128) {
              continue
            }

            r += data[i]
            g += data[i + 1]
            b += data[i + 2]
            n++
          }
        }

        resolve(n > 0 ? `#${toHex(r / n)}${toHex(g / n)}${toHex(b / n)}` : null)
      } catch {
        // Tainted canvas (no CORS) or decode failure — the ink fallback wins.
        resolve(null)
      }
    }

    image.onerror = () => resolve(null)
    image.src = url
  })
}

export function sampleImageField(url: string): Promise<null | string> {
  const hit = cache.get(url)

  if (hit) {
    return hit
  }

  const pending = sample(url)

  cache.set(url, pending)

  return pending
}
