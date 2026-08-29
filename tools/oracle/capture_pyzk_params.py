"""Drives pyzk's device-information reads against the local emulator.

pyzk is used strictly as a black box: only its public API is called, and no
part of its source is read or reproduced. See ../../PROVENANCE.md.

Method names are probed with getattr and an absence is REPORTED, never
assumed away: if pyzk has no such public method, that is recorded as
producing no evidence rather than as agreement.
"""
import sys

from zk import ZK

METHODS = (
    "get_serialnumber",
    "get_device_name",
    "get_platform",
    "get_fp_version",
    "get_firmware_version",
    "get_time",
)


def main() -> int:
    port = int(sys.argv[1])
    force_udp = len(sys.argv) > 2 and sys.argv[2] == "udp"
    conn = ZK("127.0.0.1", port=port, timeout=5, force_udp=force_udp)
    try:
        conn.connect()
        for name in METHODS:
            method = getattr(conn, name, None)
            if method is None:
                print(f"pyzk exposes no public {name}", file=sys.stderr)
                continue
            try:
                print(f"{name} -> {method()!r}", file=sys.stderr)
            except Exception as exc:
                print(f"{name} raised {exc!r}", file=sys.stderr)
    except Exception as exc:
        print(f"pyzk stopped: {exc}", file=sys.stderr)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
