import type { Translations } from '../types'

export const ui: Translations['ui'] = {
  search: {
    clear: 'Clear search'
  },
  pagination: {
    label: 'pagination',
    previous: 'Prev',
    previousAria: 'Go to previous page',
    next: 'Next',
    nextAria: 'Go to next page'
  },
  sidebar: {
    title: 'Sidebar',
    description: 'Displays the mobile sidebar.',
    toggle: open => `${open ? 'Show' : 'Hide'} sidebar`
  }
}
