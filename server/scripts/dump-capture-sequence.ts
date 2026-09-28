/**
 * Precise operation-sequence dump for a single real KNXnet/IP capture -
 * no eyeballed grep, no manual line-reading. Extraction approach: tshark
 * `-T fields` on `cemi.sa`/`cemi.da`/`_ws.col.Info`, filtered to
 * `L_Data.req` frames addressed to the target device only (the command
 * actually issued, not its .con/.ind echo), with ACK/NAK excluded.
 * Answers a common question - "what did THIS ONE real capture actually
 * do, in order" - without needing a second side to diff against.
 *
 * Usage:
 *   node server/scripts/dump-capture-sequence.ts --capture <path.pcapng> --addr 1.1.10 \
 *     [--tshark "C:\\Program Files\\Wireshark\\tshark.exe"] [--objidx 5] [--full]
 *
 * --objidx <n>  filters the printed sequence to only operations naming that
 *               ObjIdx (OX=<n>) - e.g. `--objidx 5` to answer "were there any
 *               Object 5 reads/writes, and exactly what were they" precisely,
 *               instead of grepping the text summary by eye.
 * --full        print every individual operation with its frame's raw Info
 *               text, instead of the collapsed "Kind xN" summary.
 */
import { execFileSync } from 'node:child_process';

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CAPTURE = argVal('capture');
const ADDR = argVal('addr');
if (!CAPTURE || !ADDR) {
  console.error(
    'Usage: --capture <path.pcapng> --addr <e.g. 1.1.10> [--tshark <path>] [--objidx <n>] [--full]',
  );
  process.exit(1);
}
const TSHARK = argVal('tshark') || 'C:\\Program Files\\Wireshark\\tshark.exe';
const OBJIDX_FILTER = argVal('objidx');
const FULL = process.argv.includes('--full');

function individualAddressToWord(addr: string): number {
  const [a, l, d] = addr.split('.').map(Number);
  return (((a! << 4) | (l! & 0xf)) << 8) | (d! & 0xff);
}
const ADDR_WORD = individualAddressToWord(ADDR);

interface Op {
  kind: string;
  raw: string;
}

// Keeps OX=/P= (structurally meaningful) while stripping exact byte
// payloads/addresses (not meaningful for sequencing) from Mem*Write/Read
// operations.
function normalizeKind(rest: string): string {
  if (/^Mem(Ext)?Write/.test(rest)) return rest.split(' ')[0]!;
  if (/^Mem(Ext)?Read/.test(rest)) return rest.split(' ')[0]!;
  const propMatch =
    /^(PropValueRead|PropValueWrite|PropDescrRead|FuncPropExtRead|FuncPropExtWrite)\s+(OX=\d+\s+P=\d+|OT=\d+\s+OI=\d+\s+P=\d+)/.exec(
      rest,
    );
  if (propMatch) return `${propMatch[1]} ${propMatch[2]}`;
  const restartMatch = /^(RestartReq|RestartResp)/.exec(rest);
  if (restartMatch) return restartMatch[1]!;
  if (/^(Connect|Disconnect|DevDescrRead|DevDescrResp)/.test(rest))
    return rest.split(' ')[0]!.split('$')[0]!.trim();
  return rest.split(' ')[0]!;
}

function extractSequence(): Op[] {
  const out = execFileSync(
    TSHARK,
    [
      '-r',
      CAPTURE!,
      '-d',
      'tcp.port==3671,kip',
      '-T',
      'fields',
      '-e',
      'cemi.sa',
      '-e',
      'cemi.da',
      '-e',
      '_ws.col.Info',
    ],
    { maxBuffer: 1024 * 1024 * 256 },
  ).toString('utf8');

  const lastOf = (v: string): string => v.split(',').pop() ?? v;
  const ops: Op[] = [];
  for (const rawLine of out.split('\n')) {
    // A bare `$` anchor doesn't match past a trailing '\r' on Windows
    // tshark output, which silently zeroes out every match without this.
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const da = Number(lastOf(cols[1] ?? ''));
    const info = cols[2] ?? '';
    if (da !== ADDR_WORD) continue;
    if (!info.includes('L_Data.req')) continue;
    const m = /L_Data\.req \S+->\S+\s+(.*)$/.exec(info);
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest === 'ACK' || rest === 'NAK') continue;
    ops.push({ kind: normalizeKind(rest), raw: rest });
  }
  return ops;
}

function collapse(ops: Op[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    const lastKind = last?.replace(/ x\d+$/, '');
    if (lastKind === op.kind) {
      const n = last!.match(/ x(\d+)$/);
      out[out.length - 1] = `${op.kind} x${n ? Number(n[1]) + 1 : 2}`;
    } else {
      out.push(op.kind);
    }
  }
  return out;
}

function main(): void {
  const ops = extractSequence();
  const filtered = OBJIDX_FILTER
    ? ops.filter((o) => new RegExp(`OX=${OBJIDX_FILTER}\\b`).test(o.raw))
    : ops;

  console.log(
    `\n=== ${CAPTURE} (addr ${ADDR}) ===` +
      (OBJIDX_FILTER ? ` - filtered to ObjIdx=${OBJIDX_FILTER}` : ''),
  );
  console.log(
    `${ops.length} total commanded operations (L_Data.req only, ACK/NAK excluded)`,
  );
  if (OBJIDX_FILTER) {
    console.log(`${filtered.length} matching ObjIdx=${OBJIDX_FILTER}\n`);
    if (!filtered.length) {
      console.log(
        '(none - this ObjIdx was never the target of any commanded operation)',
      );
      return;
    }
  } else {
    console.log('');
  }

  if (FULL) {
    for (const op of filtered) console.log(op.raw);
  } else {
    for (const line of collapse(filtered)) console.log(line);
  }
}

main();
