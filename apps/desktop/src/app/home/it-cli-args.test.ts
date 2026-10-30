import { describe, expect, it } from 'vitest'

import { parseItFlags, resolvePaneRef, screenLooksIdle, toPtyText } from './it-cli-args'

describe('toPtyText', () => {
  it('turns every newline into a carriage return', () => {
    // A terminal accepts a line on CR. LF just sits in the line buffer, so a
    // heredoc sent with LFs hangs the pane at `heredoc>` forever.
    expect(toPtyText('one\ntwo\nthree')).toBe('one\rtwo\rthree')
    expect(toPtyText('crlf\r\nhere')).toBe('crlf\rhere')
  })

  it('leaves a single-line command exactly as it was', () => {
    expect(toPtyText('echo hello world')).toBe('echo hello world')
  })
})

describe('parseItFlags', () => {
  it('keeps the command text and lifts the options out of it', () => {
    const flags = parseItFlags(['echo', 'hello world', '--enter', '--pane', '3'])

    expect(flags.rest).toEqual(['echo', 'hello world'])
    expect(flags.enter).toBe(true)
    expect(flags.pane).toBe('3')
  })

  it('does not let a flag leak into what gets typed', () => {
    // The bug this guards: `it send echo hi --enter` typing "echo hi --enter".
    expect(parseItFlags(['echo', 'hi', '--enter']).rest.join(' ')).toBe('echo hi')
  })

  it('takes a pane id, not just an index', () => {
    expect(parseItFlags(['--pane', 'a1b2c3d4']).pane).toBe('a1b2c3d4')
  })

  it('reads the numeric options and ignores rubbish', () => {
    const flags = parseItFlags(['--lines', '40', '--wait', '12'])

    expect(flags.lines).toBe(40)
    expect(flags.wait).toBe(12)

    const junk = parseItFlags(['--lines', 'lots'])

    expect(junk.lines).toBeUndefined()
    // …and the value it could not read is not left behind as command text.
    expect(junk.rest).toEqual([])
  })

  it('survives a trailing flag with nothing after it', () => {
    expect(() => parseItFlags(['--pane'])).not.toThrow()
    expect(parseItFlags(['--pane']).pane).toBeUndefined()
  })
})

describe('resolvePaneRef', () => {
  const panes = ['aaaa1111', 'bbbb2222', 'cccc3333']

  it('falls back when no pane was named', () => {
    expect(resolvePaneRef(panes, undefined, 'bbbb2222')).toBe('bbbb2222')
    expect(resolvePaneRef(panes, '', 'bbbb2222')).toBe('bbbb2222')
  })

  it('takes a 1-based index in tree order', () => {
    expect(resolvePaneRef(panes, '1', null)).toBe('aaaa1111')
    expect(resolvePaneRef(panes, '3', null)).toBe('cccc3333')
  })

  it('refuses an index that is out of range', () => {
    expect(resolvePaneRef(panes, '0', null)).toBeNull()
    expect(resolvePaneRef(panes, '4', null)).toBeNull()
  })

  it('takes an exact id, never a prefix or a substring', () => {
    expect(resolvePaneRef(panes, 'bbbb2222', null)).toBe('bbbb2222')
    expect(resolvePaneRef(panes, 'bbbb', null)).toBeNull()
    expect(resolvePaneRef(panes, '2222', null)).toBeNull()
  })

  it('refuses a shared prefix instead of guessing', () => {
    expect(resolvePaneRef(['ab1', 'ab2'], 'ab', null)).toBeNull()
  })
})

describe('screenLooksIdle', () => {
  it('recognises a shell prompt', () => {
    expect(screenLooksIdle('~/Desktop main % ')).toBe(true)
    expect(screenLooksIdle('output\nmore output\nuser@host:~$ ')).toBe(true)
    expect(screenLooksIdle('# ')).toBe(true)
  })

  it('does not call a running command idle', () => {
    expect(screenLooksIdle('~ % sleep 30\n')).toBe(false)
    expect(screenLooksIdle('progress 7/20')).toBe(false)
  })

  it('reports a pager as busy — which is the honest answer', () => {
    // A pane captured by `less` will never be idle; a driver that is told so
    // can recover it. Pretending otherwise is how the first campaign run fed
    // a job's command into a search prompt.
    expect(screenLooksIdle(':')).toBe(false)
    expect(screenLooksIdle('(END)')).toBe(false)
  })

  it('never calls a zsh CONTINUATION prompt idle', () => {
    // This one cost three jobs. A pane sat in `heredoc>`, the old predicate
    // counted the trailing `>` as a prompt, so the recovery never ran and the
    // next two jobs were typed into the heredoc.
    for (const prompt of ['heredoc>', 'dquote>', 'quote>', 'pipe>', 'cmdsubst>', 'for>', 'then>', '>']) {
      expect(screenLooksIdle(`~ % cat <<EOS\n${prompt}`)).toBe(false)
    }
  })

  it('accepts the pointed prompt many zsh themes use', () => {
    expect(screenLooksIdle('~/Desktop ❯ ')).toBe(true)
  })

  it('ignores trailing blank lines', () => {
    expect(screenLooksIdle('~ % \n\n\n')).toBe(true)
  })
})

describe('no instance flag', () => {
  it('-i and --instance are not options any more: they stay in the text (the command refuses them)', () => {
    expect(parseItFlags(['-i', '2', 'echo']).rest).toEqual(['-i', '2', 'echo'])
    expect(parseItFlags(['grep', '-i', 'foo']).rest).toEqual(['grep', '-i', 'foo'])
    expect(parseItFlags(['--instance', 'x', '--workspace', '3']).workspace).toBe('3')
  })
})

describe('R5 r6 — exact refs and an honest busy check', () => {
  const panes = ['t-a', 't-b', 't-c']

  it('reads a ref as an index only when it is all digits', () => {
    expect(resolvePaneRef(panes, '2', null)).toBe('t-b')

    for (const ref of ['0x2', '2.0', '1e0', '+2', '02 ', ' 2', '-1']) {
      expect(resolvePaneRef(panes, ref, 't-a')).toBeNull()
    }
  })

  it('never reads a progress line or a price as a prompt', () => {
    expect(screenLooksIdle('copying\n  1.2G  45%')).toBe(false)
    expect(screenLooksIdle('total 12$')).toBe(false)
    expect(screenLooksIdle('build 100%  ')).toBe(false)
  })

  it('still sees the real prompts, including bash with its version', () => {
    expect(screenLooksIdle('pat@mac ~ %')).toBe(true)
    expect(screenLooksIdle('bash-5.2$ ')).toBe(true)
    expect(screenLooksIdle('bash-3.2#')).toBe(true)
    expect(screenLooksIdle('~/src ❯')).toBe(true)
  })
})

describe('R5 r7 — a prompt character counts only in prompt context', () => {
  it('never reads a spaced percentage, a progress bar or markdown as a prompt', () => {
    for (const screenText of [
      'Downloading model  45 %',
      'Progress: 100 %',
      'eta 3.5 %  ',
      '[##########   ',
      'tail -f notes.md\n## TODO #',
      '###',
      'x-45%'
    ]) {
      expect(screenLooksIdle(screenText)).toBe(false)
    }
  })

  it('keeps every real prompt idle', () => {
    for (const screenText of [
      '~/Desktop main % ',
      'root@host:~# ',
      '# ',
      '%',
      'bash-5.2$ ',
      'pat@mac ~ %',
      '~/src/v2 ❯',
      'C:\\proj $'
    ]) {
      expect(screenLooksIdle(screenText)).toBe(true)
    }
  })
})
