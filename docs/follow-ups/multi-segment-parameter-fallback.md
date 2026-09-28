# Multi-segment parameter apps and the single-buffer fallback

**Status: open question, not yet decided.** Recorded so it is looked at deliberately
rather than rediscovered.

## Background

On AbsoluteSegment-style devices the parameters live in memory segments, and each
segment numbers its parameter offsets from zero. An application can declare more than
one segment that carries parameters. `M-0002_A-A001-13-63C2` is an example: 160 bytes
at `0x6D00` holding four channels' parameters, plus 8 bytes at `0x6F00` for the
device-level General block. Putting both into one buffer puts General's bytes on top
of Channel A's, and the write goes to the wrong addresses with no protocol-level error.

## What the code does today

- Each parameter records the segment its offset belongs to (`segmentAddress`, from the
  parameter's own `<Memory CodeSegment=.../>` binding).
- `resolveParamSegments()` and `buildParamMemBySegment()` build one buffer per segment,
  and the download receives them as `paramMemBySegment`.

## The open question

`resolveParamSegment()` (singular) still exists and still resolves a single segment by
a size-fit heuristic. It is used when a model carries no segment bindings: a
RelSegment/WriteRelMem device (correct there), or an application model cached before
segment tracking was added. An old cached model of a multi-segment application would
take that path and could flatten the segments.

Two things are not established:

1. Whether the per-segment write path has been exercised on real hardware for every
   kind of multi-segment application (the M-0002 case is the one it was built for).
2. Whether a stale cached model of a multi-segment application can reach the
   single-segment path in practice, or is always caught by re-import.

## Option to consider

A narrow guard: refuse the parameter-memory download when an AbsoluteSegment
application's parameters reference more than one distinct `CodeSegment` but the
model carries no per-segment bindings (that is, the fallback would flatten them).
The refusal would tell the user to re-import the project so the model is rebuilt.
This costs nothing for models that already carry bindings.

## To decide

- Is the guard worth adding, given how rarely a stale model of a multi-segment
  application should occur?
- Has the per-segment path been hardware-tested for a second multi-segment device?
