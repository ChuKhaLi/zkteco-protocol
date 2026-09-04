/**
 * Starts the test emulator and keeps it alive, so the PUBLISHED CLI can be
 * driven against it from outside this repo.
 *
 * This exists to answer a question the test suite structurally cannot: does
 * `npx zkteco-protocol <host>` work when installed from a package tarball?
 * Every other check runs the CLI from source inside this repo, which shares
 * its node_modules, its tsconfig and its build output. A published consumer
 * has none of those, and plan defect 8 on the bring-up branch was exactly this
 * shape — a build failure that silently dropped `dist/index.cjs` with no test
 * failing anywhere.
 *
 * Writes the chosen port to the path given as argv[2] so the caller can find
 * it without parsing stdout.
 */
import { writeFileSync } from 'node:fs'
import { startEmulator } from '../test/emulator/index.js'
import { USER_RECORD_SIZE } from '../src/codec/records/user.js'
import type { ZkUser } from '../src/types.js'

function emUser(uid: number, userId: string, name: string): ZkUser {
  const b = Buffer.alloc(USER_RECORD_SIZE)
  b.writeUInt16LE(uid, 0)
  b.write(name, 11, 24, 'latin1')
  b.write(userId, 48, 9, 'latin1')
  return {
    uid,
    userId,
    name,
    privilege: 0,
    hasPassword: false,
    cardNumber: 0,
    raw: b.toString('hex'),
  }
}

/**
 * One 40-byte attendance record: uid, the printed id, then the packed time.
 *
 * The drill's device used to report zero records, so `getAttendanceLogs`
 * returned without issuing a read and checklist item 1 was answered by a
 * capture containing no attendance request at all. The drill now checks the
 * capture for that request, which needs a device that has one to give.
 */
function rec40(uid: number, userId: string, seconds: number): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt16LE(uid, 0)
  b.write(userId, 2, 24, 'latin1')
  b.writeUInt32LE(seconds, 27)
  return b
}

const portFile = process.argv[2]
if (!portFile) throw new Error('usage: emulator-serve.ts <port-file>')

const running = await startEmulator({
  transport: 'tcp',
  params: {
    '~SerialNumber': 'SN-PACKTEST-001',
    '~DeviceName': 'MB360',
    '~Platform': 'ZMM220_TFT',
    '~OS': 'Linux',
  },
  firmware: 'Ver 6.60 Jun 10 2019',
  info: { userCount: 1, recordCount: 1, recordCapacity: 100_000 },
  users: [emUser(1, '000123', 'Alice')],
  records: { size: 40, rows: [rec40(1, '000123', 86_400)] },
  deviceTimeRaw: 0,
})

writeFileSync(portFile, String(running.port), 'utf8')
process.stdout.write(`emulator listening on ${running.port}\n`)

// Stay alive until killed.
setInterval(() => {}, 1 << 30)
