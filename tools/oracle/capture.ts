import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startEmulator, type Emulator } from '../../test/emulator/index.js'
import { describeFailure, runOracleScript, succeeded } from './run-oracle.js'

const OUT_DIR = path.join('test', 'fixtures', 'oracle')
const EMULATOR_SESSION_ID = 0x1f2e
const ORACLE_COMM_KEY = 1234

/** Runs that produced no evidence. A crashed driver must not leave a fixture behind. */
const failures: string[] = []

// Extra (commKey, sessionId) pairs, captured against pyzk only, specifically
// to test the low-byte-discard invariance with real external data instead of
// resting it on this library's own mixCommKey. The single (ORACLE_COMM_KEY,
// EMULATOR_SESSION_ID) pair above vindicates the algorithm at one point, but
// pyzk was never asked to mix two session ids differing only in the low
// byte, so it could not confirm the low-byte invariance specifically —
// EMULATOR_SESSION_ID's low byte (0x2e) never varied across any capture.
//
// Written to their own subdirectory, not OUT_DIR: test/oracle/fixtures.spec.ts
// scans every *.json directly under OUT_DIR for the reply-id checksum
// adjudication (§5.1) and asserts an exact count of discriminating packets
// across that specific corpus. These captures are real evidence too, but for
// a different, narrower question (§A.4's low-byte invariance) — mixing them
// into the general survey would silently change a number that test pins on
// purpose.
//
// zkteco-js is excluded here: it has no comm-key support at all (see the
// `auth-*-zkteco-js.json` fixtures, which carry no CMD_AUTH packet), so it
// cannot offer a second opinion on this either.
const COMMKEY_DIR = path.join(OUT_DIR, 'commkey')
const LOW_BYTE_VARIANT_SESSION_ID = 0x1f99 // same high byte as the baseline (0x1f), different low byte
const HIGH_BYTE_VARIANT_SESSION_ID = 0x2e2e // same low byte as the baseline (0x2e), different high byte
const SECOND_COMM_KEY = 5678

// Realtime captures live in their own directory, NOT in OUT_DIR.
// test/oracle/fixtures.spec.ts scans every *.json directly under OUT_DIR and
// asserts an exact count of discriminating packets for the reply-id
// adjudication; these fixtures answer a different question and would silently
// change a number that test pins on purpose.
const REALTIME_DIR = path.join(OUT_DIR, 'realtime')

// Parameter captures live in their own directory, NOT in OUT_DIR, for the
// same reason as COMMKEY_DIR and REALTIME_DIR: test/oracle/fixtures.spec.ts
// scans every *.json directly under OUT_DIR and asserts an exact count of
// discriminating packets for the reply-id adjudication. These fixtures answer
// a different question and would silently change a number that test pins on
// purpose.
const PARAMS_DIR = path.join(OUT_DIR, 'params')

/**
 * Waits for the last datagram to land, then writes what the emulator
 * received as a committed fixture.
 *
 * `meta` supplies every field the fixture carries before `packets`, in the
 * order callers want them written — object spread preserves insertion order,
 * so this reproduces each caller's exact prior field order byte-for-byte.
 * `includeData` is on for the realtime captures, where the registration mask
 * and pushed-event bytes are themselves the evidence, and off for the
 * handshake/auth captures, whose payload carries nothing beyond the header.
 */
async function writeFixture(
  emulator: Emulator,
  outDir: string,
  file: string,
  meta: Record<string, unknown>,
  includeData: boolean,
): Promise<void> {
  // Give the last datagram a moment to land before tearing the socket down.
  await new Promise((r) => setTimeout(r, 300))
  const packets = emulator.received.map((p, i) => {
    const record: Record<string, unknown> = {
      hex: emulator.receivedRaw[i]!.toString('hex'),
      command: p.command,
      checksum: p.checksum,
      sessionId: p.sessionId,
      replyId: p.replyId,
    }
    if (includeData) record.data = p.data.toString('hex')
    return record
  })
  const fixture = { ...meta, packets }
  mkdirSync(outDir, { recursive: true })
  const filePath = path.join(outDir, file)
  writeFileSync(filePath, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`wrote ${filePath} (${packets.length} packets)\n`)
}

async function capture(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
  commKey = 0,
  sessionId = EMULATOR_SESSION_ID,
  // Overrides the handshake/auth naming derived from commKey, and the
  // directory it's written under, for the extra pairs below that are all
  // CMD_AUTH captures but must not collide on disk with the baseline
  // `auth-${transport}-${source}.json` file — and must not land in OUT_DIR
  // at all, per the comment on COMMKEY_DIR above.
  fileTag?: string,
  outDir = OUT_DIR,
): Promise<void> {
  const emulator = await startEmulator({ transport, sessionId, commKey })
  try {
    const kind = fileTag ?? (commKey === 0 ? 'handshake' : 'auth')
    const file = `${kind}-${transport}-${source}.json`
    const { run: oracleRun, script } = await runOracleScript(
      source,
      'tools/oracle/capture_pyzk.py',
      'tools/oracle/capture_zkjs.ts',
      [String(emulator.port), transport, String(commKey)],
    )
    if (!succeeded(oracleRun)) {
      failures.push(describeFailure(script, oracleRun))
      process.stderr.write(`skipped ${file}: the oracle run produced no evidence\n`)
      return
    }
    await writeFixture(
      emulator,
      outDir,
      file,
      { source, transport, commKey, emulatorSessionId: sessionId },
      false,
    )
  } finally {
    await emulator.close()
  }
}

/**
 * Records what an oracle puts on the wire for a realtime subscription.
 *
 * The emulator pushes three events in the same handler return as the
 * registration ack, so the oracle receives them without any timing
 * coordination between the two processes.
 */
async function captureRealtime(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
): Promise<void> {
  const pushes = [0x01, 0x02, 0x03].map((n) => {
    const data = Buffer.alloc(36)
    data.write(`ORACLE${n}`, 0, 9, 'ascii')
    data.set([26, 8, 27, 8, 1, n], 26)
    return { eventType: 1, data }
  })
  const emulator = await startEmulator({
    transport,
    sessionId: EMULATOR_SESSION_ID,
    pushWithAck: pushes,
  })
  try {
    const file = `realtime-${transport}-${source}.json`
    const { run: oracleRun, script } = await runOracleScript(
      source,
      'tools/oracle/capture_pyzk_realtime.py',
      'tools/oracle/capture_zkjs_realtime.ts',
      [String(emulator.port), transport],
    )
    if (!succeeded(oracleRun)) {
      failures.push(describeFailure(script, oracleRun))
      process.stderr.write(`skipped ${file}: the oracle run produced no evidence\n`)
      return
    }
    await writeFixture(
      emulator,
      REALTIME_DIR,
      file,
      { source, transport, emulatorSessionId: EMULATOR_SESSION_ID },
      true,
    )
  } finally {
    await emulator.close()
  }
}

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await capture(source, transport, 0)
    await capture(source, transport, ORACLE_COMM_KEY)
  }
}

// Low-byte/high-byte/different-key characterisation, pyzk only, TCP only —
// the invariance under test is structural (in the mixing algorithm), not
// transport-dependent, and one transport is enough to pin it against a real
// external computation. Written under COMMKEY_DIR, not OUT_DIR — see the
// comment on that constant above.
await capture('pyzk', 'tcp', ORACLE_COMM_KEY, LOW_BYTE_VARIANT_SESSION_ID, 'auth-lowbyte', COMMKEY_DIR)
await capture('pyzk', 'tcp', ORACLE_COMM_KEY, HIGH_BYTE_VARIANT_SESSION_ID, 'auth-highbyte', COMMKEY_DIR)
await capture('pyzk', 'tcp', SECOND_COMM_KEY, EMULATOR_SESSION_ID, 'auth-keydiff', COMMKEY_DIR)

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await captureRealtime(source, transport)
  }
}

/**
 * Records what an oracle puts on the wire for the terminal read commands.
 *
 * The emulator is configured to answer every keyword either driver asks for,
 * so a driver that reaches the command produces a request packet regardless
 * of whether it can make sense of the reply. What is being captured is the
 * REQUEST shape — zkteco-js's reply parser cannot discriminate the reply
 * layout at all (design spec §8.2).
 */
async function captureParams(
  source: 'pyzk' | 'zkteco-js',
  transport: 'tcp' | 'udp',
): Promise<void> {
  const emulator = await startEmulator({
    transport,
    sessionId: EMULATOR_SESSION_ID,
    params: {
      '~SerialNumber': 'ORACLE0000001',
      '~DeviceName': 'ORACLE-MB360',
      '~Platform': 'ZMM220_TFT',
      '~OS': 'Linux',
      '~ZKFPVersion': '10',
      'MAC': '00:17:61:01:02:03',
    },
    firmware: 'Ver 6.60 Jun 10 2019',
    deviceTimeRaw: 0x2b1f_c4d0,
  })
  try {
    const file = `params-${transport}-${source}.json`
    const { run: oracleRun, script } = await runOracleScript(
      source,
      'tools/oracle/capture_pyzk_params.py',
      'tools/oracle/capture_zkjs_params.ts',
      [String(emulator.port), transport],
    )
    if (!succeeded(oracleRun)) {
      failures.push(describeFailure(script, oracleRun))
      process.stderr.write(`skipped ${file}: the oracle run produced no evidence\n`)
      return
    }
    await writeFixture(
      emulator,
      PARAMS_DIR,
      file,
      { source, transport, emulatorSessionId: EMULATOR_SESSION_ID },
      true,
    )
  } finally {
    await emulator.close()
  }
}

for (const transport of ['tcp', 'udp'] as const) {
  for (const source of ['pyzk', 'zkteco-js'] as const) {
    await captureParams(source, transport)
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} oracle run(s) produced no fixture:\n`)
  for (const line of failures) process.stderr.write(`  ${line}\n`)
  process.exitCode = 1
}
