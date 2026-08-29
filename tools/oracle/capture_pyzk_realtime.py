"""Drives pyzk's realtime capture against the local emulator.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.
"""
import sys

from zk import ZK


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    conn = ZK("127.0.0.1", port=port, timeout=3, force_udp=force_udp)
    try:
        conn.connect()
        seen = 0
        for _ in conn.live_capture():
            seen += 1
            if seen >= 3:
                break
    except Exception as exc:  # the emulator answers only part of a session
        print(f"pyzk stopped: {exc}", file=sys.stderr)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
