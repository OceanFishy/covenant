#!/usr/bin/env python3
"""Minimal JSON-lines APDU bridge to a Ledger device over USB (ledgerblue).

One request per stdin line, one response per stdout line:
  {"apdu": "e002000015..."}  ->  {"data": "<hex>", "sw": 36864}
                             or  {"sw": 27013, "error": "..."}   (device status word != 0x9000)
                             or  {"error": "..."}                (no device, bad request, ...)
Exits cleanly on EOF. Used by app/scripts/ledger7702.mjs; needs `pip install ledgerblue`.
"""
import json
import sys

try:
    from ledgerblue.comm import getDongle
    from ledgerblue.commException import CommException
except ImportError as exc:  # pragma: no cover - depends on the host
    sys.stderr.write(f"ledgerblue is not importable ({exc}); install it with: python3 -m pip install ledgerblue\n")
    sys.exit(2)


def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    dongle = None
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                apdu = bytes.fromhex(json.loads(line)["apdu"])
            except (ValueError, KeyError, TypeError) as exc:
                reply({"error": f"bad request: {exc}"})
                continue
            try:
                if dongle is None:
                    dongle = getDongle(debug=False)
                data = dongle.exchange(apdu)
                reply({"data": bytes(data).hex(), "sw": 0x9000})
            except CommException as exc:
                reply({"sw": exc.sw, "error": str(exc.message)})
            except Exception as exc:  # no device, USB errors, ...
                reply({"error": f"{type(exc).__name__}: {exc}"})
    finally:
        if dongle is not None:
            dongle.close()


if __name__ == "__main__":
    main()
