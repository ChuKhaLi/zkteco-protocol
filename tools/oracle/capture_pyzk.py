"""Drives pyzk against the local emulator so its wire bytes can be recorded.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.

Method and attribute names are probed with getattr and an absence is
REPORTED, never assumed away: if pyzk has no such public member, that is
recorded as producing no evidence rather than as agreement. This is the
discipline capture_pyzk_params.py established; the read modes below follow it
so a pyzk version that dropped a method cannot be mistaken for one that
answered.

Usage: capture_pyzk.py <port> [tcp|udp] [comm_key] [read-users|read-attendance]

Exit codes, so a harness can tell "did not run" from "ran and failed":
  0  completed everything it was asked
  1  could not connect
  2  connected, but the read raised
  3  connected, but pyzk exposes no such public method — no evidence either way
"""
import sys

from zk import ZK

#: Public attributes of the objects `get_attendance()` returns. Each is probed
#: with getattr; one that is missing prints as `<absent:name>` rather than
#: being dropped, so a line with four resolved fields is distinguishable from
#: a line that merely has four separators in it.
ATTENDANCE_FIELDS = ("user_id", "timestamp", "status", "punch")


def field(record: object, name: str) -> str:
    value = getattr(record, name, None)
    return f"<absent:{name}>" if value is None else str(value)


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    comm_key = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    mode = sys.argv[4] if len(sys.argv) > 4 else ""
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp, password=comm_key)
    try:
        conn.connect()
    except Exception as exc:  # the emulator may answer only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
        return 1
    code = 0
    try:
        if mode == "read-users":
            for user in conn.get_users():
                # One line per user the client believes it read: what it
                # parsed is the observable, not how it parsed it.
                print(f"{user.uid}|{user.user_id}|{user.name}")
        elif mode == "read-attendance":
            read = getattr(conn, "get_attendance", None)
            if read is None:
                print("pyzk exposes no public get_attendance", file=sys.stderr)
                code = 3
            else:
                for record in read():
                    # Same observable as above, one line per attendance record
                    # the client believes it read.
                    print("|".join(field(record, name) for name in ATTENDANCE_FIELDS))
    except Exception as exc:
        print(f"pyzk read failed: {exc}", file=sys.stderr)
        code = 2
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return code


if __name__ == "__main__":
    raise SystemExit(main())
