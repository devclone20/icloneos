import { expect, test } from 'vitest'

import { osc9Notification, osc777Notification } from './osc'

test('OSC 9 text is a notification; cwd and progress sub-commands are not', () => {
  expect(osc9Notification('build finished')).toBe('build finished')
  expect(osc9Notification('9;/Users/me/repo')).toBeNull()
  expect(osc9Notification('4;1;50')).toBeNull()
  expect(osc9Notification('')).toBeNull()
})

test('OSC 777 notify carries title and body; control characters never reach the UI', () => {
  expect(osc777Notification('notify;Claude;needs approval')).toBe('Claude: needs approval')
  expect(osc777Notification('notify;only title')).toBe('only title')
  expect(osc777Notification('preexec;x')).toBeNull()
  expect(osc777Notification('notify;a\u001b[31mred;b\u0007')).toBe('a [31mred: b')
  expect(osc777Notification(`notify;${'x'.repeat(500)}`)?.length).toBe(200)
})
