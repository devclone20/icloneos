import type { TranslationOverrides } from '../define-locale'

export const ui: TranslationOverrides['ui'] = {
  search: {
    clear: 'Limpar pesquisa'
  },
  pagination: {
    label: 'paginação',
    previous: 'Anterior',
    previousAria: 'Ir para a página anterior',
    next: 'Seguinte',
    nextAria: 'Ir para a página seguinte'
  },
  sidebar: {
    title: 'Barra lateral',
    description: 'Mostra a barra lateral móvel.',
    toggle: open => `${open ? 'Mostrar' : 'Ocultar'} barra lateral`
  }
}
