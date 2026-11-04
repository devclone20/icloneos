// The image on the system clipboard, read through Electron's async clipboard API.
//
// Since Electron 44 the main-process clipboard follows the W3C shape: `read()` resolves with the items on the
// clipboard and an image arrives as an `image/*` Blob (the synchronous `readImage()` is gone). The caller still gets
// what `readImage().toPNG()` gave it: PNG bytes re-encoded through nativeImage, or null when there is no image.

/** The part of Electron's ClipboardItem this module reads. */
export interface ClipboardItemLike {
  readonly types: string[]
  getType: (type: string) => Promise<unknown>
}

export interface ClipboardImageSource {
  read: () => Promise<ClipboardItemLike[]>
}

/** Decodes image bytes of any platform clipboard format and re-encodes them as PNG; null when they hold no image. */
export type DecodeImageToPng = (bytes: Buffer) => Buffer | null

interface BlobLike {
  arrayBuffer: () => Promise<ArrayBuffer>
}

function isBlobLike(value: unknown): value is BlobLike {
  return typeof (value as BlobLike | null)?.arrayBuffer === 'function'
}

// PNG first: Electron 44's clipboard converts a macOS TIFF and a Windows DIB/BMP to image/png, so it is what every
// platform offers for a screenshot or a copied image, and it decodes without loss. Any other image type the
// clipboard still exposes as itself (image/svg+xml, say) is the fallback.
function imageType(types: readonly string[]): string | undefined {
  return types.includes('image/png') ? 'image/png' : types.find(type => type.startsWith('image/'))
}

export async function readClipboardImagePng(
  clipboard: ClipboardImageSource,
  decodeToPng: DecodeImageToPng
): Promise<Buffer | null> {
  let items: ClipboardItemLike[]

  try {
    items = await clipboard.read()
  } catch {
    // An unreadable clipboard is an empty one, as readImage() returned an empty image.
    return null
  }

  for (const item of items) {
    const type = imageType(item.types)

    if (!type) {
      continue
    }

    try {
      const blob = await item.getType(type)

      if (!isBlobLike(blob)) {
        continue
      }

      const bytes = Buffer.from(await blob.arrayBuffer())
      const png = bytes.length > 0 ? decodeToPng(bytes) : null

      if (png && png.length > 0) {
        return png
      }
    } catch {
      // The platform withdrew this format between read() and getType(): try the next item.
    }
  }

  return null
}
