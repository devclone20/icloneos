import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { createAppNavigationGuard } from './app-navigation-policy'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }))

// X1c: before, an app window's will-navigate let the main frame go to ANY file: URL in a packaged build, so a
// `<a target="_self" href="file:…">` in model-written HTML put a local page into the app window with the preload and
// the bridge (measured on the 40.10.2 binary). The main frame may now only go to the app itself.

const INDEX = '/Applications/App.app/Contents/Resources/app/dist/index.html'
const APP = pathToFileURL(INDEX).toString()

function navigate(url: string, { devServer, isMainFrame = true }: { devServer?: string; isMainFrame?: boolean } = {}) {
  const log = vi.fn()
  const event = { isMainFrame, preventDefault: vi.fn(), url }

  createAppNavigationGuard({ devServer, log, rendererIndexPath: () => INDEX })(event)

  return { cancelled: event.preventDefault.mock.calls.length === 1, log }
}

describe('createAppNavigationGuard', () => {
  it.each([APP, `${APP}?win=hud`, `${APP}?win=quick#/x`, `${APP}#/settings`])(
    'lets the app window load the app: %s',
    url => {
      expect(navigate(url).cancelled).toBe(false)
    }
  )

  it('lets the dev server origin through in dev', () => {
    expect(navigate('http://localhost:5174/#/chat', { devServer: 'http://localhost:5174' }).cancelled).toBe(false)
  })

  it.each([
    ['another local page', 'file:///tmp/model-wrote-this.html', 'file:'],
    [
      'a sibling of the index',
      pathToFileURL('/Applications/App.app/Contents/Resources/app/dist/other.html').toString(),
      'file:'
    ],
    ['a remote page', 'https://attacker.example.test/', 'https:'],
    ['a data: page', 'data:text/html,<p>x</p>', 'data:'],
    ['a javascript: URL', 'javascript:alert(1)', 'javascript:'],
    ['an unparsable URL', 'not a url', 'invalid']
  ])('cancels %s and logs only the scheme', (_label, url, scheme) => {
    const { cancelled, log } = navigate(url)

    expect(cancelled).toBe(true)
    expect(log).toHaveBeenCalledExactlyOnceWith(`[link] blocked app window navigation: ${scheme}`)
  })

  it('in dev, cancels a file: page and another origin', () => {
    expect(navigate('file:///tmp/x.html', { devServer: 'http://localhost:5174' }).cancelled).toBe(true)
    expect(navigate('http://localhost:9999/', { devServer: 'http://localhost:5174' }).cancelled).toBe(true)
  })

  it('leaves a sub-frame alone (an embed or an artifact iframe holds no preload)', () => {
    expect(navigate('https://www.youtube-nocookie.com/embed/x', { isMainFrame: false }).cancelled).toBe(false)
  })
})
