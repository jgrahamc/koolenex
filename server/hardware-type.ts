/**
 * The hardware type an application program expects its device to report.
 *
 * Every application declares a hidden (Access="None"), property-based
 * parameter - typically named "_Allg Hardware Type", placed with
 * `<Property ObjectIndex="0" PropertyId="78"/>` (PID_HARDWARE_TYPE of the
 * device object) - whose enumeration texts are the raw six bytes ETS reads
 * back from the device. Multi-variant families (for example a pushbutton
 * range) declare one option per physical variant, as "$00 0A 80 00 01 10
 * (2-gang F50)": the hex, then an optional description. Comparing the live
 * PID_HARDWARE_TYPE with the expected option catches a download aimed at the
 * wrong physical product before anything is written.
 *
 * Which option applies to a given device is the parameter's own value:
 * whatever the project stores for that device's instance of it, else the
 * application default.
 */

/** One hardware-type parameter of an application, as kept in its app model. */
export interface HardwareTypeParamDef {
  /** The parameter's own id in the application (`<appId>_P-<n>`). */
  key: string;
  /** Its factory default, an enumeration value ('' when none). */
  value?: string;
  /** Enumeration value -> declared text ("$00 0A 80 00 01 10 (2-gang F50)"). */
  enums: Record<string, string>;
}

export interface HardwareTypeInfo {
  buffer: Buffer;
  /** The description in the enum text's trailing parentheses, or null when the
   *  application declares the option without one. */
  label: string | null;
}

/** "$00 0A 80 00 01 10 (2-gang F50)" -> the bytes and the description. */
export function parseHardwareTypeEnumText(
  text: string,
): HardwareTypeInfo | null {
  const parenMatch = /\(([^)]+)\)\s*$/.exec(text);
  const hexPart = text
    .split('(')[0]!
    .trim()
    .replace(/\$/g, '')
    .replace(/\s+/g, '');
  if (!/^[0-9A-Fa-f]+$/.test(hexPart)) return null;
  return {
    buffer: Buffer.from(hexPart, 'hex'),
    label: parenMatch ? parenMatch[1]!.trim() : null,
  };
}

/**
 * The hardware type this application expects for one device, or null when the
 * application declares none.
 *
 * `currentValues` are the device's stored parameter values. A hardware-type
 * parameter can sit inside a module definition, in which case the app only has
 * the bare id but the device's stored value is under a module-instance key
 * (`<appId>_MD-<x>_M-<y>_MI-<z>_P-<n>_R-<r>`); the trailing `_P-<n>` segment is
 * matched for that case. It is a single, non-repeating identity flag, so
 * matching on it alone is safe.
 */
export function getExpectedHardwareType(
  defs: HardwareTypeParamDef[] | undefined,
  currentValues?: Record<string, unknown>,
  appId?: string,
): HardwareTypeInfo | null {
  for (const pd of defs ?? []) {
    let raw: string | undefined =
      currentValues?.[pd.key] !== undefined
        ? String(currentValues[pd.key])
        : undefined;
    if (raw === undefined && currentValues) {
      const pNum = pd.key.match(/_P-(\d+)$/);
      if (pNum) {
        const suffix = new RegExp(`_P-${pNum[1]}(?:_R-\\d+)?$`);
        const prefix = `${appId ?? pd.key.replace(/_P-\d+$/, '')}_MD-`;
        for (const [k, v] of Object.entries(currentValues)) {
          if (k.startsWith(prefix) && suffix.test(k)) {
            raw = String(v);
            break;
          }
        }
      }
    }
    if (raw === undefined) raw = pd.value;
    const text = raw !== undefined ? pd.enums[raw] : undefined;
    return text ? parseHardwareTypeEnumText(text) : null;
  }
  return null;
}

/**
 * The description of the option matching the bytes a device actually reported,
 * looked up among this same application's own declared options only. A real
 * mismatch usually belongs to a different product, whose name an unrelated
 * application's list could not honestly supply, so no match returns null.
 */
export function describeHardwareType(
  defs: HardwareTypeParamDef[] | undefined,
  actual: Buffer,
): string | null {
  for (const pd of defs ?? []) {
    for (const text of Object.values(pd.enums)) {
      const parsed = parseHardwareTypeEnumText(text);
      if (parsed && parsed.buffer.equals(actual)) return parsed.label;
    }
  }
  return null;
}
