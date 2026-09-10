# `1140-zennio-real-blank-device-write.hex`

Real captured data, used to seed `../knx-connection-write-service.test.ts`'s
golden-capture replay test so it exercises actual real-world byte content,
not synthetic filler - same convention `tests/fixtures/relmem-real-devices/`
already uses for the 1.1.9/1.1.10 write-protocol tests.

The exact 57,076-byte parameter-memory image real ETS wrote to a genuinely
blank Zennio KLIC-DI v2 (mask `0x07B0`, `PID_MCB_TABLE` byte 5 = `0x33`),
reconstructed byte-for-byte from a real capture. Gaps ETS itself never wrote
are filled with `0x00` (the app's own declared `Fill` value). This is the
device that falsified the `IsSecureEnabled` write-service signal (the
application program declares `IsSecureEnabled=false` but requires the
extended memory-write service) - see the `PID_MCB_TABLE` write-service
resolution comment in `../../server/knx-connection.ts` for the full
evidence this fixture supports.
