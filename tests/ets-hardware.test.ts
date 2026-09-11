/**
 * server/ets-hardware.ts - the product and Hardware2Program lookups every
 * imported device's manufacturer, model, width and bus current come from.
 *
 * Only ever exercised through the smoke fixtures, so a change here showed
 * up as "the devices table looks wrong" rather than as a failing unit. The
 * functions take ZipEntry[], so the XML below is hand-written rather than a
 * fixture: each case is one rule, and the shapes are the ones real ETS
 * files use (a Product carrying its own width, a hardware-level fallback, a
 * device described only in a non-English language).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMfrNames, parseHardware } from '../server/ets-hardware.ts';
import type { ZipEntry } from '../server/ets-zip.ts';

/** A zip entry backed by a string, for feeding the parsers directly. */
const entry = (entryName: string, xml: string): ZipEntry => ({
  entryName,
  getData: () => Buffer.from(xml, 'utf8'),
  release: () => {},
});

const hardwareXml = (inner: string) => `<?xml version="1.0"?>
<KNX><ManufacturerData><Manufacturer RefId="M-0083">
  <Hardware>${inner}</Hardware>
</Manufacturer></ManufacturerData></KNX>`;

describe('parseMfrNames', () => {
  const master = `<?xml version="1.0"?>
<KNX><MasterData><Manufacturers>
  <Manufacturer Id="M-0002" Name="ABB" />
  <Manufacturer Id="M-0083" Name="MDT technologies" />
</Manufacturers></MasterData></KNX>`;

  it('maps manufacturer id to name and keeps the raw XML', () => {
    const r = parseMfrNames([entry('knx_master.xml', master)]);
    assert.equal(r.mfrById['M-0002'], 'ABB');
    assert.equal(r.mfrById['M-0083'], 'MDT technologies');
    assert.ok(r.knxMasterXml?.includes('<Manufacturers>'));
  });

  it('finds knx_master.xml nested under a directory', () => {
    // A .knxproj keeps it at the root; a .knxprod nests it.
    const r = parseMfrNames([entry('P-0AFC/knx_master.xml', master)]);
    assert.equal(r.mfrById['M-0002'], 'ABB');
  });

  it('returns empty rather than throwing when there is none', () => {
    const r = parseMfrNames([entry('M-0083/Hardware.xml', '<KNX/>')]);
    assert.deepEqual(r.mfrById, {});
    assert.equal(r.knxMasterXml, null);
  });

  it('survives malformed master data', () => {
    // An unreadable master file must not take the whole import down.
    const r = parseMfrNames([entry('knx_master.xml', 'not xml at all <<<')]);
    assert.deepEqual(r.mfrById, {});
  });
});

describe('parseHardware', () => {
  const mfrById = { 'M-0083': 'MDT technologies' };

  it('maps a product ref and an H2P ref to the same hardware', () => {
    // These are the two ways a device instance names its hardware: by
    // product (the catalogue entry) and by Hardware2Program (the
    // application it runs). Both have to land on the same device.
    const xml = hardwareXml(`
      <Hardware Id="M-0083_H-SCN" Name="Rain Sensor" SerialNumber="SCN-01"
                BusCurrent="10" WidthInMillimeter="36">
        <Products><Product Id="M-0083_H-SCN_P-1" Text="KP-SCN-01"
                           OrderNumber="SCN-RS1.01" IsRailMounted="true" /></Products>
        <Hardware2Programs><Hardware2Program Id="M-0083_H-SCN_HP-004F-11" /></Hardware2Programs>
      </Hardware>`);
    const { hwByProd, hwByH2P } = parseHardware(
      [entry('M-0083/Hardware.xml', xml)],
      mfrById,
    );

    const p = hwByProd['M-0083_H-SCN_P-1'];
    assert.ok(p, 'product should be indexed');
    assert.equal(p.manufacturer, 'MDT technologies');
    assert.equal(p.model, 'KP-SCN-01');
    assert.equal(p.orderNumber, 'SCN-RS1.01');
    assert.equal(p.hwSerial, 'SCN-01');
    assert.equal(p.busCurrent, 10);
    assert.equal(p.widthMm, 36);
    assert.equal(p.isRailMounted, true);

    const h = hwByH2P['M-0083_H-SCN_HP-004F-11'];
    assert.ok(h, 'H2P should be indexed');
    assert.equal(h.manufacturer, 'MDT technologies');
    assert.equal(h.hwSerial, 'SCN-01');
    // The H2P entry names the hardware, not the product.
    assert.equal(h.model, 'Rain Sensor');
  });

  it('prefers the product width over the hardware width', () => {
    const xml = hardwareXml(`
      <Hardware Id="H" Name="N" WidthInMillimeter="36">
        <Products><Product Id="P-wide" WidthInMillimeter="72" /></Products>
      </Hardware>`);
    const { hwByProd } = parseHardware(
      [entry('M-0083/Hardware.xml', xml)],
      mfrById,
    );
    assert.equal(hwByProd['P-wide']!.widthMm, 72);
  });

  it('falls back to the product width when the hardware has none', () => {
    // Real files put it in either place.
    const xml = hardwareXml(`
      <Hardware Id="H" Name="N">
        <Products><Product Id="P-only" WidthInMillimeter="18" /></Products>
      </Hardware>`);
    const { hwByProd } = parseHardware(
      [entry('M-0083/Hardware.xml', xml)],
      mfrById,
    );
    assert.equal(hwByProd['P-only']!.widthMm, 18);
  });

  it('reads the power-supply and coupler flags either way round', () => {
    // ETS writes these as "true" in some files and "1" in others.
    const xml = hardwareXml(`
      <Hardware Id="H1" Name="PSU" IsPowerSupply="true" IsCoupler="0">
        <Products><Product Id="P-psu" /></Products>
      </Hardware>
      <Hardware Id="H2" Name="Coupler" IsPowerSupply="0" IsCoupler="1">
        <Products><Product Id="P-cpl" /></Products>
      </Hardware>`);
    const { hwByProd } = parseHardware(
      [entry('M-0083/Hardware.xml', xml)],
      mfrById,
    );
    assert.equal(hwByProd['P-psu']!.isPowerSupply, true);
    assert.equal(hwByProd['P-psu']!.isCoupler, false);
    assert.equal(hwByProd['P-cpl']!.isCoupler, true);
    assert.equal(hwByProd['P-cpl']!.isPowerSupply, false);
  });

  it('falls back to the hardware name when a product has no text', () => {
    const xml = hardwareXml(`
      <Hardware Id="H" Name="Fallback Name">
        <Products><Product Id="P-untitled" /></Products>
      </Hardware>`);
    const { hwByProd } = parseHardware(
      [entry('M-0083/Hardware.xml', xml)],
      mfrById,
    );
    assert.equal(hwByProd['P-untitled']!.model, 'Fallback Name');
  });

  it('leaves an unknown manufacturer id rather than inventing a name', () => {
    const xml = hardwareXml(`
      <Hardware Id="H" Name="N"><Products><Product Id="P" /></Products></Hardware>`);
    const { hwByProd } = parseHardware(
      [entry('M-9999/Hardware.xml', xml)],
      mfrById,
    );
    assert.ok(hwByProd['P']);
    assert.notEqual(hwByProd['P']!.manufacturer, 'MDT technologies');
  });

  it('keeps going when one Hardware.xml is broken', () => {
    // One bad manufacturer file must not lose every other product in the
    // project.
    const good = hardwareXml(`
      <Hardware Id="H" Name="Good"><Products><Product Id="P-good" /></Products></Hardware>`);
    const { hwByProd } = parseHardware(
      [
        entry('M-0001/Hardware.xml', 'not xml <<<'),
        entry('M-0083/Hardware.xml', good),
      ],
      mfrById,
    );
    assert.ok(hwByProd['P-good'], 'the readable file should still be indexed');
  });

  it('ignores entries that are not a Hardware.xml', () => {
    const { hwByProd, hwByH2P } = parseHardware(
      [entry('M-0083/Catalog.xml', hardwareXml('<Hardware Id="H" Name="N"/>'))],
      mfrById,
    );
    assert.deepEqual(hwByProd, {});
    assert.deepEqual(hwByH2P, {});
  });
});
