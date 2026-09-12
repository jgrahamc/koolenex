# 2026-09-12: a device that will not serve A_Memory_Read for its own tables

**Status: open. Blocked on an ETS capture.** Verify fails on every Zennio `AC_*`
device in the S22012 project (18 of them, application `M-0071_A-1222-15-CBCE`,
"KLIC-DI VRV 1.5"). The plan is provably correct and the device declines anyway.
This records what is established, what the KNX Standard rules out, and the one
experiment that would settle it - so none of it has to be rediscovered.

## Symptom

```
11:10:02.482 Device verify failed: Memory_Response returned zero bytes at 0x4000 (requested 1)
```

On the wire (1.3.60), the first read of the verify plan:

```
us -> device   42 01 4000   seq 0, A_Memory_Read, count 1, address 0x4000
device -> us   42 40 4000   seq 0, A_Memory_Response, count 0, address 0x4000, no data
```

The device answers. It answers with "nothing", which is a specified refusal, not a
fault.

## What the standard says a zero count means

`03/03/07 Application Layer v02.01.01`, A_Memory_Response, Error handling:

> If data are to be read from a protected area or from any logical address that is
> not associated to physical memory then in the A_Memory_Response-PDU the field
> number shall be zero and there shall be no field data to indicate an error. The
> same shall apply if only part of the memory to be read is protected or physically
> existing. In addition, the same shall apply if the value of the parameter number
> is greater than Maximum APDU Length.

Three permitted causes. All three are excluded below.

## Measurements against the real device

| Question                                    | How                                                                                                                   | Result                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Is the requested count too large?           | we asked for 1 octet; device declares max APDU 15                                                                     | no                                                                                 |
| Are the loadable parts valid?               | `PID_LOAD_STATE_CONTROL` (PID 5) on objIdx 1, 2, 3                                                                    | `01` = **Loaded** for all three                                                    |
| Is 0x4000 really where its tables live?     | `PID_TABLE_REFERENCE` (PID 7) on objIdx 1, 2, 3                                                                       | `4000` / `4200` / `4400` - the device's own answer matches the declaration exactly |
| Is the region read-protected?               | declared `Access` on every `LdCtrlAbsSegment` is `0xF4`                                                               | read level **15 = free** (see nibble order below)                                  |
| Does the device serve A_Memory_Read at all? | probed 0x0000, 0x0050, 0x0060, 0x0064, 0x0070, 0x0100, 0x0200, 0x1000, 0x3FFF, 0x4000, 0x4200, 0x4400, 0x4800, 0x4C00 | answers **only** 0x0060 and 0x0100; refuses every other address tried              |
| Do property reads work?                     | all of the above were property reads                                                                                  | yes, every one                                                                     |

So: the tables are loaded, the device agrees with us about where they are, it
declares them freely readable, it serves the memory service in principle - and it
refuses every address in the region regardless.

## The access nibbles, since this was got wrong once

`03/05/02 Management Procedures v02.01.02` §3.31, `LoadEvent: AllocAbsDataSeg`:

> Access Attributes contains the access level of the segment
>
> - bit 0-3 write access level
> - bit 4-7 read access level

and `03/03/07` §3.5.7 on the levels themselves:

> Access levels (unsigned8) between 0 (maximum level, i.e. maximum access rights)
> and 3 (minimum level ...) or 0 ... and 15 (minimum level, i.e. minimum access
> rights) are allowed.

So `0xF4` is read level 15 (free), write level 4. An earlier reading of this file
had the nibbles the other way round, inferred from comparing two devices - the
Berker `M-0002_A-A001-13-63C2` declares `0xFF` and answers reads, the Zennio
declares `0xF4` and does not - and concluded the region was read-protected. It is
not. Do not re-derive this from device behaviour; it is declared.

## The authorization idea, and why it is wrong

The obvious next thought is that koolenex never sends `A_Authorize_Request` on a
read path, while it does send one at the start of a RelSegment download
(`knx-connection.ts`, "A_Authorize_Request with the well-known/default key").
`03/03/07` §3.5.7, Error and exception handling, says not to:

> If the Remote Management supports authorization and if the communication partner
> does not authorize itself, the Remote Management shall select the maximum access
> level protected with FFFFFFFFh as the current access level.
> If the communication partner authorizes itself with an invalid key, the Remote
> Management shall select the minimal access level (this is level 3 or level 15).

Not authorizing gets the best level still protected by the default key.
Authorizing with `0xFFFFFFFF` on a device whose keys have been set gets the
**minimum** level. Sending it would be neutral at best and a demotion at worst.

That also puts a question mark over the existing download-path call, which sends
the default key unconditionally. Not investigated; worth a look on its own.

## Leading hypothesis

The application declares `PreEts4Style="true"` and `ConvertedFromPreEts4Data="true"`
with `MaskVersion="MV-0701"`. It is plausibly a modern device carrying a converted
pre-ETS4 absolute-segment load procedure, which emulates a handful of legacy
BCU-compatibility addresses (0x0060, 0x0100 - exactly the two it answers) and holds
its real configuration somewhere the memory services do not reach. If so, no
correction to the verify plan can help, and koolenex should say so rather than fail
obscurely.

Unproven. The declaration says the memory is there and readable; the device says
otherwise; one of them is not describing the real device.

## The experiment that would settle it

Capture what ETS itself does, on the IP side (Wireshark on the KNXnet/IP tunnel to
the router, not ETS's own filtered monitor - full cEMI is wanted). Use a read-only
ETS action: Diagnostics -> Device Info on one of these devices. **Not** Download or
Unload; those write, and one of them leaves the device unloaded.

What to look for:

- Which APCI ETS uses for this region - `A_Memory_Read`, `A_MemoryExtended_Read`,
  `A_UserMemory_Read`, or property reads only.
- Whether it sends `A_Authorize_Request` first, and with which key. The spec above
  makes a real key significant and a default key counterproductive.
- Whether it writes `PID_DEVICE_CONTROL` or touches the load state before reading.
- Whether its `A_DeviceDescriptor_Read` is connection-oriented. koolenex's now is
  (`4be486e`), changed on this device's evidence; a capture confirms it
  independently.

Three outcomes, all useful:

1. ETS reads 0x4000 successfully - we send something subtly different and the
   capture shows what.
2. ETS never touches that memory and uses properties - memory comparison is the
   wrong mechanism for this device and the capture shows the right one.
3. ETS also gets a zero count - the device does not serve it, and the honest
   product behaviour is to report that.

Frames can be decoded through koolenex's own `parseCEMI`, which has the side
benefit that a decoder bug would show up too.

## What to build regardless of the outcome

A zero-byte `A_Memory_Response` should explain itself instead of needing this
excursion repeated. On refusal, read the owning object's `PID_LOAD_STATE_CONTROL`
and report the standard's own categories: what was asked for, the load state, and
the segment's declared access level. Today the message is
`Memory_Response returned zero bytes at 0x4000 (requested 1)`, which names none of
the three things that decide the answer.

## Separate defect found on the way

`buildSegmentDescriptor()` (`server/knx-download-plan.ts`) writes the segment
descriptor's last three octets from one of two hardcoded constants chosen by
`address >= 0x4000`:

```
FLASH_FOOTER = [0xff, 0x03, 0x80, 0x00]      RAM_FOOTER = [0x00, 0x02, 0x00, 0x00]
```

By §3.31 those octets are access attributes, memory type (1 zero-page RAM, 2 RAM,
3 EEPROM) and memory attributes (bit 7 = checksum control). The application
declares all three per segment as `Access`, `MemType` and `SegFlags`, and the
parser discards them - the same pattern as the discarded `CodeSegment` fixed in
`3144fb4`. `FLASH_FOOTER` happens to equal the Berker device's declaration
(`0xFF`, 3, `0x80`) exactly, which is why nothing has ever noticed. For the Zennio
it would allocate segments with write access level 15 where the manufacturer
declares 4 - less protected than specified. Download path only; it has no bearing
on the read failure above.

`buildSegmentDescriptor()` also derives the segment type from `size === 1 ? 1 : 0`
rather than from the declared `SegType`, which is `0` on every segment of both
applications examined.

## Reference

Spec volumes used, all from KNX Standard section 3:

- `03_03_07 Application Layer v02.01.01` - A_Memory_Read/Response, A_Authorize.
- `03_05_01 Resources v01.10.01` - Load State Machine, load states and events,
  `PID_LOAD_STATE_CONTROL`, `PID_TABLE_REFERENCE`.
- `03_05_02 Management Procedures v02.01.02` - `DM_LoadStateMachineWrite` §3.31,
  the `AllocAbsDataSeg` record and its access/memory attribute octets.

These are licensed documents and are not in the repository; `/*.pdf` is gitignored.
