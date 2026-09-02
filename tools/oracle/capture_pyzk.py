"""Drives pyzk against the local emulator so its wire bytes can be recorded.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.

Usage: capture_pyzk.py <port> [tcp|udp] [comm_key] [read-users]

Exit codes, so a harness can tell "did not run" from "ran and failed":
  0  completed everything it was asked
  1  could not connect
  2  connected, but the read raised
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    comm_key = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    read_users = len(sys.argv) > 4 and sys.argv[4] == "read-users"
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp, password=comm_key)
    try:
        conn.connect()
    except Exception as exc:  # the emulator may answer only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
        return 1
    code = 0
    try:
        if read_users:
            for user in conn.get_users():
                # One line per user the client believes it read: what it
                # parsed is the observable, not how it parsed it.
                print(f"{user.uid}|{user.user_id}|{user.name}")
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
