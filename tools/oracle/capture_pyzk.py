"""Drives pyzk against the local emulator so its wire bytes can be recorded.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    comm_key = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp, password=comm_key)
    try:
        conn.connect()
    except Exception as exc:  # the emulator may answer only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
