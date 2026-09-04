import { describe, expect, it } from 'vitest'
import { START_MARKER, tryUnframeTcp } from '../../src/codec/framing.js'
import { parseUserData } from '../../src/codec/records/user.js'
import { emptyFindings } from '../../src/diagnostics/probe.js'
import type { Findings } from '../../src/diagnostics/probe.js'
import { renderJson, renderMarkdown, renderRawCapture } from '../../src/diagnostics/report.js'
import type { ProbeResult } from '../../src/diagnostics/report.js'
import { StepRunner } from '../../src/diagnostics/step.js'
import type { StepResult, TraceEvent } from '../../src/diagnostics/types.js'

function sample(): ProbeResult {
  const findings = emptyFindings()
  findings.identity.deviceName = 'MB360'
  findings.identity.firmwareVersion = 'Ver 6.60'
  findings.identity.serialNumberPresent = true
  findings.keywordForm = 'both'
  return {
    libraryVersion: '0.4.0',
    host: '192.168.1.201',
    transport: 'tcp',
    startedAt: '2026-08-30T00:00:00.000Z',
    durationMs: 1234,
    truncated: null,
    // The default run: no --raw-capture. This is the invocation the README
    // documents first, and the one C-2 was rendered from.
    rawCapture: null,
    steps: [{ name: 'firmware', outcome: 'ok' }],
    findings,
  }
}

/** A run that both captured bytes and read attendance — item 1's full evidence. */
function withCapture(path: string, rowCount = 3): ProbeResult {
  const result = sample()
  result.rawCapture = path
  result.findings.attendance = {
    read: true, skippedReason: null, detectedRecordSize: 40, rowCount,
  }
  return result
}

describe('renderMarkdown', () => {
  it('is deterministic for the same input', () => {
    expect(renderMarkdown(sample())).toBe(renderMarkdown(sample()))
  })

  it('names the model, which item 7 needs for the compatibility table', () => {
    const md = renderMarkdown(sample())
    expect(md).toContain('MB360')
    expect(md).toContain('Ver 6.60')
  })

  it('states that item 22 is not testable by this tool rather than omitting it', () => {
    // An absence must be visible as an absence at the point a reader would
    // otherwise assume presence.
    expect(renderMarkdown(sample())).toMatch(/22[^\n]*not testable/i)
  })

  it('says the run was truncated, and where', () => {
    const result = { ...sample(), truncated: { after: 'clock', reason: 'silent' } }
    const md = renderMarkdown(result)
    expect(md).toMatch(/truncated/i)
    expect(md).toContain('clock')
  })

  it('spells out what a bare-only verdict means for the library', () => {
    const result = sample()
    result.findings.keywordForm = 'bare-only'
    expect(renderMarkdown(result)).toMatch(/encodeParamRequest/)
  })

  it("warns that a 'neither' verdict is a keyword question, not a shape question", () => {
    const result = sample()
    result.findings.keywordForm = 'neither'
    expect(renderMarkdown(result)).toMatch(/item 17/i)
  })

  it("marks the one-way probes 'not requested' when they were not run", () => {
    const md = renderMarkdown(sample())   // findings.realtime and .concurrent are null
    expect(md).toMatch(/not requested/i)
    expect(md).not.toMatch(/item 10[^\n]*not answered/i)
  })
})

/**
 * Reads the `state` cell out of one checklist table row, by item number.
 *
 * Splitting on `|` and trusting positional indices is safe here specifically
 * because none of the question/observation text this file's fixtures produce
 * contains a literal `|` — the table format itself is `| item | question |
 * state | observation |`.
 */
function checklistState(md: string, item: number): string {
  const line = md.split('\n').find((l) => l.startsWith(`| ${item} |`))
  if (!line) throw new Error(`no checklist row found for item ${item}`)
  const cells = line.split('|').map((c) => c.trim())
  return cells[3] ?? ''
}

function withRealtime(overrides: Partial<NonNullable<Findings['realtime']>>): ProbeResult {
  const result = sample()
  result.findings.realtime = {
    windowSeconds: 5,
    registered: false,
    eventsObserved: 0,
    eventTypes: [],
    desyncOnRegister: false,
    error: null,
    ...overrides,
  }
  return result
}

function withConcurrent(overrides: Partial<NonNullable<Findings['concurrent']>>): ProbeResult {
  const result = sample()
  result.findings.concurrent = { attempted: true, accepted: false, error: null, ...overrides }
  return result
}

/**
 * Fix round 1, F9: the three-way realtime/concurrent -> checklist-state
 * mapping was hand-verified by a reviewer once and locked in by nothing —
 * these tests exercise it through the actual renderer, the same way a real
 * report would be read, for the four cases the reviewer walked by hand.
 */
describe('the realtime/concurrent checklist mapping (Fix round 1, F9)', () => {
  it('a completed subscription answers 8/9/13, leaves 14 not answered, and 12 stays not testable', () => {
    const md = renderMarkdown(
      withRealtime({ registered: true, eventsObserved: 2, eventTypes: [1], desyncOnRegister: false }),
    )
    expect(checklistState(md, 8)).toBe('answered')
    expect(checklistState(md, 9)).toBe('answered')
    expect(checklistState(md, 13)).toBe('answered')
    expect(checklistState(md, 14)).toBe('not answered')
    // F11: item 12 has no supporting mechanism in ANY branch -- this library
    // has no cancel/unsubscribe primitive, so a completed window must not
    // make it look answered.
    expect(checklistState(md, 12)).toBe('not testable by this tool')
  })

  it('a refused registration leaves 8/9/13/14 all not answered', () => {
    const md = renderMarkdown(
      withRealtime({
        registered: false,
        error: 'device refused a realtime subscription with command 1001',
        desyncOnRegister: false,
      }),
    )
    for (const item of [8, 9, 13, 14]) expect(checklistState(md, item)).toBe('not answered')
    expect(checklistState(md, 12)).toBe('not testable by this tool')
  })

  it('a desync answers item 14 alone, even though 8/9/13 stay not answered on the same run', () => {
    const md = renderMarkdown(
      withRealtime({
        registered: false,
        error: 'a realtime event arrived where the CMD_REG_EVENT reply was expected: out of step',
        desyncOnRegister: true,
      }),
    )
    expect(checklistState(md, 14)).toBe('answered')
    for (const item of [8, 9, 13]) expect(checklistState(md, item)).toBe('not answered')
  })

  it('item 10 is answered whether the second connection was accepted or refused', () => {
    const accepted = renderMarkdown(withConcurrent({ accepted: true, error: null }))
    const declined = renderMarkdown(withConcurrent({ accepted: false, error: 'connection refused' }))
    expect(checklistState(accepted, 10)).toBe('answered')
    expect(checklistState(declined, 10)).toBe('answered')
  })
})

/**
 * C-2. Item 1 said `answered` and pointed at "the accompanying raw capture" on
 * a run that writes no such file — the README's own default invocation. Both
 * directions again, plus the second half of the question ("and one attendance
 * read"), which `steps.length > 0` was satisfied by the firmware step alone.
 */
describe('item 1 — the raw byte dump (C-2)', () => {
  it('is not answered on a default run, and says the bytes are gone', () => {
    const md = renderMarkdown(sample()) // rawCapture: null, one step traced
    expect(checklistState(md, 1)).toBe('not answered')
    expect(md).toMatch(/1 \|[^\n]*--raw-capture/)
    // The false claim itself, named so a re-introduction cannot pass quietly.
    expect(md).not.toMatch(/accompanying raw capture/)
  })

  it('is answered, naming the file, when a capture was requested and attendance was read', () => {
    const md = renderMarkdown(withCapture('trace.jsonl'))
    expect(checklistState(md, 1)).toBe('answered')
    expect(md).toMatch(/1 \|[^\n]*trace\.jsonl/)
  })

  it('stays not answered when the capture exists but attendance was skipped', () => {
    // "a full handshake AND one attendance read" -- half the evidence is not
    // an answer, and --attendance=never is a normal thing to pass.
    const result = withCapture('trace.jsonl')
    result.findings.attendance = {
      read: false, skippedReason: 'skipped: --attendance=never', detectedRecordSize: null, rowCount: 0,
    }
    const md = renderMarkdown(result)
    expect(checklistState(md, 1)).toBe('not answered')
    expect(md).toMatch(/1 \|[^\n]*--attendance=never/)
  })
})

/** Runs one throwing callback through a real StepRunner, as the probe would. */
async function stepsFrom(name: string, fn: () => unknown): Promise<readonly StepResult[]> {
  const runner = new StepRunner()
  await runner.run(name, async () => fn())
  return runner.steps
}

/**
 * C-1. Item 5 names exactly one constant — MAX_DECLARED_SIZE in
 * src/codec/framing.ts — and the row was matching `ZkFramingError`, which that
 * file never throws and the two RECORD parsers throw seven times. Both
 * directions are tested because they are independent defects: the false
 * negative loses the one event the row exists to catch, and the false positive
 * prints `answered` about framing.ts while citing an error from
 * codec/records/user.ts.
 *
 * Both errors come from the REAL library functions rather than a hand-written
 * message, so a reworded throw site reddens this test instead of silently
 * disabling the row.
 */
describe('item 5 — the TCP declared-size cap (C-1)', () => {
  it('answers item 5 when the declared-size cap actually fires', async () => {
    const oversized = Buffer.alloc(8)
    START_MARKER.copy(oversized, 0)
    oversized.writeUInt32LE(0x00ff_ffff, 4) // far above MAX_CHUNK.tcp + 8
    const steps = await stepsFrom('firmware', () => tryUnframeTcp(oversized))

    // The premise, asserted rather than assumed: the cap throws
    // ZkFramingError (v0.5), and TcpTransport propagates it unwrapped.
    expect(steps[0]).toMatchObject({ outcome: 'malformed', errorClass: 'ZkFramingError' })

    const md = renderMarkdown({ ...sample(), steps })
    expect(checklistState(md, 5)).toBe('answered')
  })

  it('leaves item 5 not answered when a record parser throws ZkFramingError', async () => {
    // A user body that declares more than arrived — nothing to do with the TCP
    // declared-size cap, and the exact shape that used to print `answered`.
    const short = Buffer.alloc(4 + 144)
    short.writeUInt32LE(800, 0)
    const steps = await stepsFrom('users', () => parseUserData(short))

    expect(steps[0]).toMatchObject({ outcome: 'malformed', errorClass: 'ZkFramingError' })

    const md = renderMarkdown({ ...sample(), steps })
    expect(checklistState(md, 5)).toBe('not answered')
  })

  it('says where the rejected bytes are, since the report no longer carries them', async () => {
    const oversized = Buffer.alloc(8)
    START_MARKER.copy(oversized, 0)
    oversized.writeUInt32LE(0x00ff_ffff, 4)
    const steps = await stepsFrom('firmware', () => tryUnframeTcp(oversized))
    const md = renderMarkdown({ ...sample(), steps })
    // Spec §4.5 names the framing error's `raw` as item 5's evidence; F5
    // removed `raw` from StepResult, so the row must point at the opt-in
    // capture instead of leaving a reader hunting for bytes that are not here.
    expect(md).toMatch(/5 \|[^\n]*--raw-capture/)
  })
})

/**
 * I-3. `detectedRecordSize` is null for an empty attendance log, and the
 * fallthrough said "attendance was not read." — false on the most likely first
 * device (a demo unit, a freshly wiped terminal), and false again when the
 * attendance step threw, where it also contradicts the step table.
 */
describe('items 3 and 11 — what "no record size" actually means (I-3)', () => {
  it('says the log was read and came back empty, rather than that it was not read', () => {
    const result = sample()
    result.findings.attendance = {
      read: true, skippedReason: null, detectedRecordSize: null, rowCount: 0,
    }
    const md = renderMarkdown(result)
    expect(checklistState(md, 3)).toBe('not answered')
    expect(md).toMatch(/3 \|[^\n]*returned 0 records/)
    expect(md).not.toMatch(/3 \|[^\n]*attendance was not read/)
    expect(md).toMatch(/11 \|[^\n]*returned 0 records/)
  })

  it('still says "not read" when the read was never attempted', () => {
    // findings.attendance stays null and no attendance step exists: the run
    // was truncated before it, or probeBulk never got that far.
    const md = renderMarkdown(sample())
    expect(md).toMatch(/3 \|[^\n]*attendance was not read/)
  })

  it('names the failed step instead of claiming no read happened', () => {
    const result = { ...sample(), steps: [{ name: 'attendance', outcome: 'malformed' as const }] }
    const md = renderMarkdown(result)
    expect(md).toMatch(/3 \|[^\n]*did not complete/)
    expect(md).not.toMatch(/3 \|[^\n]*attendance was not read/)
  })
})

/**
 * I-6. Both rows gated on `keywordForm !== null`, and 'neither' is a non-null
 * verdict — so item 18 printed `answered` next to its own observation saying
 * "Re-run the A/B ... before recording any item-18 answer", and item 6 called
 * the §7.3 divergence "resolved" when it was not.
 */
describe('items 6 and 18 — a neither verdict is not an answer (I-6)', () => {
  it('leaves both not answered on neither, keeping the note that explains why', () => {
    const result = sample()
    result.findings.keywordForm = 'neither'
    const md = renderMarkdown(result)
    expect(checklistState(md, 6)).toBe('not answered')
    expect(checklistState(md, 18)).toBe('not answered')
    expect(md).toMatch(/18 \|[^\n]*item 17/) // the note survives
  })

  it('answers both on a decisive verdict', () => {
    for (const verdict of ['both', 'nul-only', 'bare-only'] as const) {
      const result = sample()
      result.findings.keywordForm = verdict
      const md = renderMarkdown(result)
      expect(checklistState(md, 6)).toBe('answered')
      expect(checklistState(md, 18)).toBe('answered')
    }
  })
})

/** Builds `n` `param:` steps, the first `unauthorized` of them ACK_UNAUTH. */
function paramSteps(n: number, unauthorized: number): StepResult[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `param:~Key${i}`,
    outcome: i < unauthorized ? ('unauthorized' as const) : ('ok' as const),
  }))
}

/**
 * I-5. Since F6 an ACK_UNAUTH key throws ZkAuthError and never reaches
 * `findings.parameters`, so a device demanding a comm key swept all 12 keys
 * and the report said "the parameter sweep did not run" — and the "tried"
 * count was the survivors, not the attempts.
 */
describe('items 15-17 — the parameter sweep summary (I-5)', () => {
  it('says the sweep ran and every key was refused, not that it did not run', () => {
    const result = { ...sample(), steps: paramSteps(12, 12) } // findings.parameters stays empty
    const md = renderMarkdown(result)
    for (const item of [15, 16, 17]) expect(checklistState(md, item)).toBe('not answered')
    expect(md).toMatch(/15 \|[^\n]*12 keyword\(s\) tried/)
    expect(md).toMatch(/15 \|[^\n]*12 refused authorization/)
    expect(md).not.toMatch(/15 \|[^\n]*sweep did not run/)
  })

  it('counts the keys TRIED, not the ones that survived the ACK_UNAUTH guard', () => {
    const result = { ...sample(), steps: paramSteps(12, 3) }
    for (let i = 3; i < 12; i++) {
      result.findings.parameters.push({ key: `~Key${i}`, outcome: 'answered', empty: false })
    }
    const md = renderMarkdown(result)
    expect(checklistState(md, 17)).toBe('answered')
    // The defect: 9 survivors reported as "9 keyword(s) tried" when 12 were.
    expect(md).toMatch(/17 \|[^\n]*12 keyword\(s\) tried/)
    expect(md).not.toMatch(/17 \|[^\n]*9 keyword\(s\) tried/)
    expect(md).toMatch(/17 \|[^\n]*3 refused authorization/)
  })

  it('still says the sweep did not run when no param step exists', () => {
    const md = renderMarkdown(sample())
    expect(md).toMatch(/15 \|[^\n]*sweep did not run/)
  })
})

/**
 * I-4. Item 23 gated on `bulkPath !== null`, so a buffered run — where nothing
 * was refused and no ACK_UNAUTH was seen — printed `answered` beside an
 * observation describing, in the subjunctive, the evidence that WOULD answer
 * it. Item 19 is the related pair: `bulkPath` stays null when the users step
 * fails after PREPARE_BUFFER was already put on the wire.
 */
describe('items 19 and 23 — the bulk path (I-4)', () => {
  function withBulk(path: Findings['bulkPath'], prepareAttempted: boolean): ProbeResult {
    const result = sample()
    result.findings.bulkPath = path
    result.findings.bulkPrepareAttempted = prepareAttempted
    return result
  }

  it('leaves item 23 not answered on a buffered run, and says no refusal occurred', () => {
    const md = renderMarkdown(withBulk('buffered', true))
    expect(checklistState(md, 23)).toBe('not answered')
    expect(md).toMatch(/23 \|[^\n]*no refusal occurred/)
  })

  it('answers item 23 on a legacy run, where a refusal is what produced the fallback', () => {
    const md = renderMarkdown(withBulk('legacy', true))
    expect(checklistState(md, 23)).toBe('answered')
  })

  it('answers item 19 whenever the 11-byte payload reached the wire, even if the read then failed', () => {
    // The false negative: PREPARE_BUFFER was exercised, the users step then
    // threw, bulkPath stayed null, and item 19 said "not answered" about a
    // payload the device had already seen.
    const md = renderMarkdown(withBulk(null, true))
    expect(checklistState(md, 19)).toBe('answered')
  })

  it('leaves item 19 not answered when no PREPARE_BUFFER reached the wire', () => {
    const md = renderMarkdown(withBulk(null, false))
    expect(checklistState(md, 19)).toBe('not answered')
  })

  it('distinguishes an accepted odd-length payload from a refused one', () => {
    expect(renderMarkdown(withBulk('buffered', true))).toMatch(/19 \|[^\n]*accepted/i)
    expect(renderMarkdown(withBulk('legacy', true))).toMatch(/19 \|[^\n]*did not accept/i)
  })
})

/**
 * M-9. `packetsChecked` counted our own sends alongside the device's replies —
 * about half the number was this tool's encoder agreeing with itself — and the
 * reply-id third of the question was never computed at all while the row said
 * `answered`.
 */
describe('item 2 — checksum and reply-id reconciliation (M-9)', () => {
  it('reports the DEVICE count, and is not answered by our own packets alone', () => {
    const result = sample()
    result.findings.checksum = {
      received: { packetsChecked: 0, mismatches: 0 },
      sent: { packetsChecked: 19, mismatches: 0 },
    }
    const md = renderMarkdown(result)
    expect(checklistState(md, 2)).toBe('not answered')
    expect(md).not.toMatch(/2 \|[^\n]*19 /)
  })

  it('answers on device packets, naming ours separately as the control', () => {
    const result = sample()
    result.findings.checksum = {
      received: { packetsChecked: 19, mismatches: 0 },
      sent: { packetsChecked: 19, mismatches: 0 },
    }
    result.findings.replyIds = { repliesChecked: 19, echoedRequestId: 17 }
    const md = renderMarkdown(result)
    expect(checklistState(md, 2)).toBe('answered')
    expect(md).toMatch(/2 \|[^\n]*19 DEVICE packet\(s\)/)
    expect(md).toMatch(/2 \|[^\n]*17 of 19 repl\(ies\) echoed/)
    // The third part reports its own verdict rather than hiding under
    // `answered` -- see the block below for all four of them.
    expect(md).toMatch(/2 \|[^\n]*[Cc]omm-key mixing/)
  })

  /**
   * Item 2's third part used to end at "check the CMD_AUTH exchange in the raw
   * capture by hand". The trace answers it, and the flag does not: CMD_AUTH is
   * sent only when the device answers CONNECT with ACK_UNAUTH, so a run given
   * --comm-key against a device that never asks exercises mixCommKey zero
   * times. Each state below has to read differently from the others, because a
   * reader deciding whether 5's mixing has been checked cannot act on a row
   * that collapses "confirmed" into "never ran".
   */
  describe('the comm-key third', () => {
    function withCommKey(commKey: Findings['commKey']): string {
      const result = sample()
      result.findings.checksum = {
        received: { packetsChecked: 19, mismatches: 0 },
        sent: { packetsChecked: 19, mismatches: 0 },
      }
      result.findings.commKey = commKey
      const row = renderMarkdown(result).split('\n').find((l) => /^\| 2 \|/.test(l))
      expect(row, 'no row for item 2').toBeDefined()
      return row!
    }

    it('says the mixing was exercised and accepted when the device took the key', () => {
      const row = withCommKey({ configured: true, authSent: true, authAccepted: true })
      expect(row).toMatch(/comm-key mixing: exercised/i)
      expect(row).toMatch(/accepted/i)
      expect(row).not.toMatch(/not exercised/i)
    })

    it('says the mixing was rejected when the device refused the key', () => {
      const row = withCommKey({ configured: true, authSent: true, authAccepted: false })
      expect(row).toMatch(/rejected/i)
      expect(row).not.toMatch(/accepted/i)
    })

    it('says the mixing never ran when a key was given but never demanded', () => {
      // The state that would otherwise be read as confirmation: the operator
      // passed --comm-key, so they have every reason to assume it was checked.
      const row = withCommKey({ configured: true, authSent: false, authAccepted: null })
      expect(row).toMatch(/not exercised/i)
      expect(row).toMatch(/never demanded/i)
      expect(row).not.toMatch(/accepted/i)
    })

    it('says the mixing never ran when no key was given, and names the remedy', () => {
      const row = withCommKey({ configured: false, authSent: false, authAccepted: null })
      expect(row).toMatch(/not exercised/i)
      expect(row).toMatch(/--comm-key/)
      expect(row).not.toMatch(/never demanded/i)
    })

    it('leaves the row answered on the checksum reconciliation alone', () => {
      // The other two thirds were answered; an unexercised mixing does not
      // retract them. The observation carries the distinction, not the state.
      const result = sample()
      result.findings.checksum = {
        received: { packetsChecked: 19, mismatches: 0 },
        sent: { packetsChecked: 19, mismatches: 0 },
      }
      expect(checklistState(renderMarkdown(result), 2)).toBe('answered')
    })
  })
})

/**
 * Deferred minor 5. `errorMessage` is the one column fed from an Error whose
 * message can originate in the OS (`ZkConnectionError(err.message)` at
 * tcp.ts:35,111). A literal `|` in it shifts every cell after it, so a
 * Markdown renderer puts the WRONG VALUE under the "Raw bytes" heading — a
 * step table displaying a wrong value in a labelled column is the exact
 * failure mode this tool exists to avoid.
 */
describe('pipe-delimited cells survive a message containing a pipe', () => {
  /** Splits a table row on unescaped pipes, the way a Markdown renderer does. */
  function cells(line: string): string[] {
    return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim())
  }

  it('keeps every step column under its own heading', () => {
    const result = {
      ...sample(),
      steps: [{
        name: 'users',
        outcome: 'malformed' as const,
        errorClass: 'ZkProtocolError',
        errorMessage: 'connect ECONNREFUSED a | b | c',
        rawByteLength: 8,
      }],
    }
    const row = renderMarkdown(result).split('\n').find((l) => l.startsWith('| users |'))!
    expect(cells(row)).toEqual([
      'users', '', '', 'malformed', 'ZkProtocolError', 'connect ECONNREFUSED a \\| b \\| c', '8',
    ])
  })

  it('leaves a message with no pipe untouched', () => {
    const result = {
      ...sample(),
      steps: [{
        name: 'users', outcome: 'malformed' as const,
        errorClass: 'ZkProtocolError', errorMessage: 'no pipe here', rawByteLength: 8,
      }],
    }
    const row = renderMarkdown(result).split('\n').find((l) => l.startsWith('| users |'))!
    expect(row).toContain('| no pipe here |')
    expect(row).not.toContain('\\')
  })

  it('escapes the checklist observation too, which interpolates the same message', () => {
    // Item 5's observation quotes errorMessage verbatim.
    const result = {
      ...sample(),
      steps: [{
        name: 'firmware', outcome: 'malformed' as const, errorClass: 'ZkProtocolError',
        errorMessage: 'TCP declared payload size 99 exceeds the 8-byte maximum | truncated',
      }],
    }
    const row = renderMarkdown(result).split('\n').find((l) => l.startsWith('| 5 |'))!
    expect(cells(row)).toHaveLength(4)
  })

  /**
   * Design spec 5.1's "per-step outcomes (command, ack code, body length)".
   * The table delivered the body length alone and said so in a comment rather
   * than claiming the requirement was met; StepResult now carries the other
   * two, attributed from the trace span each step produced.
   */
  describe('the command and ack columns', () => {
    function stepRow(step: StepResult): string[] {
      const result = { ...sample(), steps: [step] }
      const row = renderMarkdown(result).split('\n').find((l) => l.startsWith(`| ${step.name} |`))!
      return cells(row)
    }

    it('puts the command and the ack code under their own headings', () => {
      expect(stepRow({
        name: 'firmware', outcome: 'ok', command: 1100, ackCode: 2000, exchanges: 1,
      })).toEqual(['firmware', '1100', '2000', 'ok', '', '', ''])
    })

    it('marks a step that made more than one exchange, so one command cannot read as one round trip', () => {
      const [, command] = stepRow({
        name: 'users', outcome: 'ok', command: 1503, ackCode: 2000, exchanges: 3,
      })
      expect(command).toBe('1503 x3')
    })

    it('leaves both cells empty for a step that reached no wire', () => {
      // Empty, not '0' and not 'undefined': 0 is a real command number.
      expect(stepRow({ name: 'skipped', outcome: 'ok' })).toEqual(
        ['skipped', '', '', 'ok', '', '', ''],
      )
    })

    it('shows the command of a step whose reply never came, with the ack left empty', () => {
      expect(stepRow({
        name: 'clock', outcome: 'silent', command: 201, exchanges: 1,
      })).toEqual(['clock', '201', '', 'silent', '', '', ''])
    })
  })
})

describe('renderRawCapture', () => {
  it('emits one JSON object per line, after a header line', () => {
    const events: TraceEvent[] = [
      { seq: 0, direction: 'send', offsetMs: 0, hex: 'aabb' },
      { seq: 1, direction: 'recv', offsetMs: 1, hex: 'ccdd' },
    ]
    const lines = renderRawCapture(events).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    const header = JSON.parse(lines[0]!)
    // The header must say what is in the file, in words, before anyone
    // attaches it to a public issue.
    expect(header.warning).toMatch(/comm key/i)
    expect(JSON.parse(lines[1]!).hex).toBe('aabb')
  })
})

describe('renderJson', () => {
  it('carries the same findings as the markdown', () => {
    const json = renderJson(sample()) as { findings: { identity: { deviceName: string } } }
    expect(json.findings.identity.deviceName).toBe('MB360')
  })
})
