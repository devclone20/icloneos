// FSEV (L1-4), 2026-11-12: a Team signature grows __LINKEDIT.vmsize and `codesign --remove-signature` leaves it
// grown, so the stripped Team-signed addon differed from the stripped pinned build in that one header field only.
// canonicalLinkedit puts that field back to filesize rounded to the 16 KiB page, and touches nothing else.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { canonicalLinkedit } from './build-iclone-fsevents.mjs'

const SEGMENT = 72

// A thin Mach-O 64 header with the given segments (name, vmsize, filesize) and some trailing "code" bytes.
function machO(segments, { magic = 0xfeedfacf, code = [1, 2, 3, 4] } = {}) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(magic, 0)
  header.writeUInt32LE(segments.length, 16)
  header.writeUInt32LE(segments.length * SEGMENT, 20)
  const commands = segments.map(([name, vmsize, filesize]) => {
    const command = Buffer.alloc(SEGMENT)
    command.writeUInt32LE(0x19, 0)
    command.writeUInt32LE(SEGMENT, 4)
    command.write(name, 8, 'latin1')
    command.writeBigUInt64LE(BigInt(vmsize), 32)
    command.writeBigUInt64LE(BigInt(filesize), 48)
    return command
  })
  return Buffer.concat([header, ...commands, Buffer.from(code)])
}

const vmsizeOf = (bytes, index) => bytes.readBigUInt64LE(32 + index * SEGMENT + 32)

test('the grown __LINKEDIT vmsize of a stripped Team-signed copy becomes the linker value', () => {
  const linker = machO([['__TEXT', 0x4000, 0x4000], ['__LINKEDIT', 0x4000, 6024]])
  const team = machO([['__TEXT', 0x4000, 0x4000], ['__LINKEDIT', 0x8000, 6024]])

  assert.notDeepEqual(linker, team)
  assert.deepEqual(canonicalLinkedit(team), canonicalLinkedit(linker))
  assert.equal(vmsizeOf(canonicalLinkedit(team), 1), 0x4000n)
  // The linker-signed build is already canonical: the committed sha256Unsigned does not move.
  assert.deepEqual(canonicalLinkedit(linker), linker)
})

test('only __LINKEDIT.vmsize is touched: any other differing byte still differs', () => {
  const pinned = machO([['__TEXT', 0x4000, 0x4000], ['__LINKEDIT', 0x4000, 6024]])
  const code = machO([['__TEXT', 0x4000, 0x4000], ['__LINKEDIT', 0x8000, 6024]], { code: [1, 2, 3, 5] })
  const text = machO([['__TEXT', 0x8000, 0x4000], ['__LINKEDIT', 0x8000, 6024]])
  const filesize = machO([['__TEXT', 0x4000, 0x4000], ['__LINKEDIT', 0x8000, 6025]])

  for (const other of [code, text, filesize]) {
    assert.notDeepEqual(canonicalLinkedit(other), canonicalLinkedit(pinned))
  }
  assert.equal(vmsizeOf(canonicalLinkedit(text), 0), 0x8000n)
})

test('the input buffer is not modified', () => {
  const team = machO([['__LINKEDIT', 0x8000, 6024]])
  const before = Buffer.from(team)

  canonicalLinkedit(team)
  assert.deepEqual(team, before)
})

test('anything that is not one thin Mach-O 64 with exactly one __LINKEDIT is refused', () => {
  assert.throws(() => canonicalLinkedit(machO([['__LINKEDIT', 0x4000, 1]], { magic: 0xcafebabe })), /Mach-O 64/)
  assert.throws(() => canonicalLinkedit(Buffer.alloc(8)), /Mach-O 64/)
  assert.throws(() => canonicalLinkedit(machO([['__TEXT', 0x4000, 1]])), /found 0/)
  assert.throws(() => canonicalLinkedit(machO([['__LINKEDIT', 0x4000, 1], ['__LINKEDIT', 0x4000, 1]])), /found 2/)

  const short = machO([['__LINKEDIT', 0x4000, 1]])
  short.writeUInt32LE(4096, 20)
  assert.throws(() => canonicalLinkedit(short), /past the file/)

  const bad = machO([['__LINKEDIT', 0x4000, 1]])
  bad.writeUInt32LE(4, 32 + 4)
  assert.throws(() => canonicalLinkedit(bad), /bad size/)
})

test('L6.2: a vmsize no signature grows to is refused, never hashed as the pin', () => {
  for (const vmsize of [0x40000000, 0x10000, 0x2000, 0x4001, 0x6000]) {
    assert.throws(() => canonicalLinkedit(machO([['__LINKEDIT', vmsize, 6024]])), /not what a signature grows/)
  }
  // The canonical page itself, and one or two pages more (the measured Developer ID growth), still hash alike.
  for (const vmsize of [0x4000, 0x8000, 0xc000]) {
    assert.equal(vmsizeOf(canonicalLinkedit(machO([['__LINKEDIT', vmsize, 6024]])), 0), 0x4000n)
  }
})
