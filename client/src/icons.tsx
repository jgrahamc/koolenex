// -- SVG Icon library ----------------------------------------------------------
// All icons inherit color via currentColor. size = height in px.

import React from 'react';
import styles from './icons.module.css';

interface SvgIconProps {
  vb?: string;
  size?: number;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

// Square nav/space icons (14x14 viewBox)
export function _SvgIcon({
  vb = '0 0 14 14',
  size = 14,
  style,
  children,
}: SvgIconProps) {
  return (
    <svg
      viewBox={vb}
      width={size}
      height={size}
      className={styles.svgIcon}
      style={style}
    >
      {children}
    </svg>
  );
}

interface IconDinBaseProps {
  size?: number;
  detail?: React.ReactNode;
}

// Base DIN-rail module (front face): used for all device-type icons
export function IconDinBase({ size = 13, detail }: IconDinBaseProps) {
  const w = +((size * 10) / 14).toFixed(1);
  return (
    <svg viewBox="0 0 10 14" width={w} height={size} className={styles.svgIcon}>
      {/* Body */}
      <rect
        x="0.8"
        y="0.4"
        width="8.4"
        height="10.5"
        rx="1.2"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      {/* Status LED */}
      <circle cx="5" cy="2.3" r="0.95" fill="currentColor" />
      {/* Panel / label area */}
      <rect
        x="1.5"
        y="3.8"
        width="7"
        height="4.2"
        rx="0.6"
        fill="currentColor"
        fillOpacity="0.07"
        stroke="currentColor"
        strokeWidth="0.45"
      />
      {detail}
      {/* DIN spring clip */}
      <rect
        x="2.5"
        y="10.9"
        width="5"
        height="1.4"
        rx="0.35"
        fill="currentColor"
        fillOpacity="0.25"
        stroke="currentColor"
        strokeWidth="0.4"
      />
      {/* DIN rail bar */}
      <rect
        x="0"
        y="12.3"
        width="10"
        height="1.7"
        rx="0.3"
        fill="currentColor"
        fillOpacity="0.4"
      />
    </svg>
  );
}

interface DeviceTypeIconProps {
  type?: string;
  size?: number;
  style?: React.CSSProperties;
}

export function DeviceTypeIcon({
  type,
  size = 13,
  style,
}: DeviceTypeIconProps) {
  // detail = SVG elements drawn inside the panel area (x 1.5-8.5, y 3.8-8.0)
  let detail: React.ReactNode;
  if (type === 'actuator') {
    detail = (
      <>
        {/* Relay: two contacts + switching bar */}
        <circle
          cx="3.2"
          cy="6.2"
          r="0.62"
          fill="currentColor"
          fillOpacity="0.8"
        />
        <circle
          cx="6.8"
          cy="5.8"
          r="0.62"
          fill="currentColor"
          fillOpacity="0.8"
        />
        <path
          d="M3.8,6 L6.2,5.8"
          stroke="currentColor"
          strokeWidth="0.65"
          strokeLinecap="round"
          strokeOpacity="0.75"
        />
      </>
    );
  } else if (type === 'sensor') {
    detail = (
      /* Sine-wave signal */
      <path
        d="M2.5,6.2 Q3.5,4.2 5,5.9 Q6.5,7.5 7.5,5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.65"
        strokeLinecap="round"
      />
    );
  } else if (type === 'router') {
    detail = (
      <>
        {/* Bidirectional arrows */}
        <line
          x1="2.5"
          y1="5.5"
          x2="7.5"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="0.55"
        />
        <polygon points="6.5,5 7.5,5.5 6.5,6" fill="currentColor" />
        <line
          x1="2.5"
          y1="7.2"
          x2="7.5"
          y2="7.2"
          stroke="currentColor"
          strokeWidth="0.55"
        />
        <polygon points="3.5,6.7 2.5,7.2 3.5,7.7" fill="currentColor" />
      </>
    );
  } else {
    detail = (
      <>
        {/* Generic: label lines */}
        <line
          x1="3"
          y1="5.5"
          x2="7"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeOpacity="0.6"
        />
        <line
          x1="3"
          y1="6.9"
          x2="6.2"
          y2="6.9"
          stroke="currentColor"
          strokeWidth="0.4"
          strokeOpacity="0.35"
        />
      </>
    );
  }
  return (
    <span style={style}>
      <IconDinBase size={size} detail={detail} />
    </span>
  );
}

interface SizeOnlyProps {
  size?: number;
}

export function IconLocations({ size = 14 }: SizeOnlyProps) {
  return (
    <_SvgIcon size={size}>
      <path
        d="M1.5,13 L1.5,5.5 L7,1.5 L12.5,5.5 L12.5,13 Z"
        fill="currentColor"
        fillOpacity="0.1"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <rect
        x="5.5"
        y="8.5"
        width="3"
        height="4.5"
        rx="0.3"
        fill="currentColor"
        fillOpacity="0.35"
      />
      <rect
        x="2.5"
        y="6.5"
        width="2.5"
        height="2"
        rx="0.3"
        fill="currentColor"
        fillOpacity="0.35"
      />
      <rect
        x="9"
        y="6.5"
        width="2.5"
        height="2"
        rx="0.3"
        fill="currentColor"
        fillOpacity="0.35"
      />
    </_SvgIcon>
  );
}

export function IconTopology({ size = 14 }: SizeOnlyProps) {
  // Vertical org-chart tree (KNX style: root -> lines -> devices)
  const sw = 0.85,
    sw2 = 0.7,
    op = 0.65;
  return (
    <_SvgIcon size={size}>
      {/* Root node */}
      <circle cx="7" cy="1.8" r="1.3" fill="currentColor" />
      {/* Root down + horizontal bar */}
      <line
        x1="7"
        y1="3.1"
        x2="7"
        y2="5"
        stroke="currentColor"
        strokeWidth={sw}
      />
      <line
        x1="3.5"
        y1="5"
        x2="10.5"
        y2="5"
        stroke="currentColor"
        strokeWidth={sw}
      />
      {/* Down to L2 */}
      <line
        x1="3.5"
        y1="5"
        x2="3.5"
        y2="7"
        stroke="currentColor"
        strokeWidth={sw}
      />
      <line
        x1="10.5"
        y1="5"
        x2="10.5"
        y2="7"
        stroke="currentColor"
        strokeWidth={sw}
      />
      {/* L2 nodes */}
      <circle cx="3.5" cy="8.2" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="8.2" r="1.2" fill="currentColor" />
      {/* L2 down + L3 horizontal bars */}
      <line
        x1="3.5"
        y1="9.4"
        x2="3.5"
        y2="10.8"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="1.5"
        y1="10.8"
        x2="5.5"
        y2="10.8"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="10.5"
        y1="9.4"
        x2="10.5"
        y2="10.8"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="8.5"
        y1="10.8"
        x2="12.5"
        y2="10.8"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      {/* L3 nodes */}
      <line
        x1="1.5"
        y1="10.8"
        x2="1.5"
        y2="11.6"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="5.5"
        y1="10.8"
        x2="5.5"
        y2="11.6"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="8.5"
        y1="10.8"
        x2="8.5"
        y2="11.6"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <line
        x1="12.5"
        y1="10.8"
        x2="12.5"
        y2="11.6"
        stroke="currentColor"
        strokeWidth={sw2}
        strokeOpacity={op}
      />
      <circle
        cx="1.5"
        cy="12.5"
        r="0.85"
        fill="currentColor"
        fillOpacity={op}
      />
      <circle
        cx="5.5"
        cy="12.5"
        r="0.85"
        fill="currentColor"
        fillOpacity={op}
      />
      <circle
        cx="8.5"
        cy="12.5"
        r="0.85"
        fill="currentColor"
        fillOpacity={op}
      />
      <circle
        cx="12.5"
        cy="12.5"
        r="0.85"
        fill="currentColor"
        fillOpacity={op}
      />
    </_SvgIcon>
  );
}

export function IconGroupAddr({ size = 14 }: SizeOnlyProps) {
  // Two forward slashes -- the "/" separators in a KNX group address like 1/2/3
  return (
    <_SvgIcon size={size}>
      <line
        x1="3.5"
        y1="13"
        x2="6.5"
        y2="1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="7.5"
        y1="13"
        x2="10.5"
        y2="1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </_SvgIcon>
  );
}

export function IconComObjects({ size = 14 }: SizeOnlyProps) {
  return (
    <_SvgIcon size={size}>
      <rect
        x="0.5"
        y="4.5"
        width="4"
        height="5"
        rx="0.7"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <rect
        x="9.5"
        y="4.5"
        width="4"
        height="5"
        rx="0.7"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="4.5"
        y1="7"
        x2="9.5"
        y2="7"
        stroke="currentColor"
        strokeWidth="0.9"
      />
      <polygon points="8.2,6.3 9.5,7 8.2,7.7" fill="currentColor" />
    </_SvgIcon>
  );
}

export function IconMonitor({ size = 14 }: SizeOnlyProps) {
  // ECG / heartbeat trace
  return (
    <_SvgIcon size={size}>
      <path
        d="M0,8 L3.5,8 L5,6 L6,8 L7.5,1.5 L9,12 L10.5,8 L12,6.5 L13,8 L14,8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </_SvgIcon>
  );
}

export function IconScan({ size = 14 }: SizeOnlyProps) {
  // Radar screen
  return (
    <_SvgIcon size={size}>
      <circle
        cx="7"
        cy="7"
        r="6.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeOpacity="0.8"
      />
      <circle
        cx="7"
        cy="7"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.5"
        strokeOpacity="0.5"
      />
      <circle
        cx="7"
        cy="7"
        r="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.4"
        strokeOpacity="0.3"
      />
      <line
        x1="7"
        y1="7"
        x2="12"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <circle cx="7" cy="7" r="0.8" fill="currentColor" />
      <circle
        cx="10.5"
        cy="4.5"
        r="0.9"
        fill="currentColor"
        fillOpacity="0.7"
      />
    </_SvgIcon>
  );
}

export function IconProgramming({ size = 14 }: SizeOnlyProps) {
  // Download-to-device arrow
  return (
    <_SvgIcon size={size}>
      <line
        x1="7"
        y1="1.5"
        x2="7"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <polygon points="4,6.5 7,10.5 10,6.5" fill="currentColor" />
      <rect
        x="1.5"
        y="11.5"
        width="11"
        height="2"
        rx="0.6"
        fill="currentColor"
        fillOpacity="0.45"
      />
    </_SvgIcon>
  );
}

export function IconProject({ size = 14 }: SizeOnlyProps) {
  // Folder icon
  return (
    <_SvgIcon size={size}>
      <path
        d="M1.5,4 L1.5,12 L12.5,12 L12.5,4 Z"
        fill="currentColor"
        fillOpacity="0.1"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <path
        d="M1.5,4 L1.5,3 L5,3 L6.5,4"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
    </_SvgIcon>
  );
}

export function IconManufacturers({ size = 14 }: SizeOnlyProps) {
  // IC chip outline with pins
  return (
    <_SvgIcon size={size}>
      <rect
        x="3.5"
        y="3.5"
        width="7"
        height="7"
        rx="0.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <line
        x1="1"
        y1="5.5"
        x2="3.5"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="1"
        y1="8.5"
        x2="3.5"
        y2="8.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="10.5"
        y1="5.5"
        x2="13"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="10.5"
        y1="8.5"
        x2="13"
        y2="8.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="5.5"
        y1="1"
        x2="5.5"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="8.5"
        y1="1"
        x2="8.5"
        y2="3.5"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="5.5"
        y1="10.5"
        x2="5.5"
        y2="13"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="8.5"
        y1="10.5"
        x2="8.5"
        y2="13"
        stroke="currentColor"
        strokeWidth="1"
      />
    </_SvgIcon>
  );
}

export function IconFloorPlan({ size = 14 }: SizeOnlyProps) {
  // Blueprint/floor plan icon
  return (
    <_SvgIcon size={size}>
      <rect
        x="1.5"
        y="1.5"
        width="11"
        height="11"
        rx="0.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="1.5"
        y1="6"
        x2="8"
        y2="6"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="8"
        y1="1.5"
        x2="8"
        y2="9"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="5"
        y1="6"
        x2="5"
        y2="12.5"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="8"
        y1="9"
        x2="12.5"
        y2="9"
        stroke="currentColor"
        strokeWidth="0.8"
      />
    </_SvgIcon>
  );
}

export function IconCatalog({ size = 14 }: SizeOnlyProps) {
  return (
    <_SvgIcon size={size}>
      <rect
        x="2"
        y="1"
        width="10"
        height="12"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <line
        x1="4.5"
        y1="4"
        x2="9.5"
        y2="4"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="4.5"
        y1="6.5"
        x2="9.5"
        y2="6.5"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      <line
        x1="4.5"
        y1="9"
        x2="7.5"
        y2="9"
        stroke="currentColor"
        strokeWidth="0.8"
      />
    </_SvgIcon>
  );
}

interface SpaceTypeIconProps {
  type?: string;
  size?: number;
}

// Space/location type icons
export function SpaceTypeIcon({ type, size = 13 }: SpaceTypeIconProps) {
  if (type === 'Building') return <IconLocations size={size} />;
  if (type === 'DistributionBoard')
    return (
      <_SvgIcon size={size}>
        {/* Electrical panel: rectangle with fuse lines */}
        <rect
          x="1.5"
          y="0.5"
          width="11"
          height="13"
          rx="1"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeWidth="0.9"
        />
        <line
          x1="4"
          y1="3"
          x2="10"
          y2="3"
          stroke="currentColor"
          strokeWidth="0.7"
        />
        <line
          x1="4"
          y1="5.5"
          x2="10"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="0.7"
        />
        <line
          x1="4"
          y1="8"
          x2="10"
          y2="8"
          stroke="currentColor"
          strokeWidth="0.7"
        />
        <line
          x1="4"
          y1="10.5"
          x2="10"
          y2="10.5"
          stroke="currentColor"
          strokeWidth="0.7"
        />
      </_SvgIcon>
    );
  if (type === 'Floor')
    return (
      <_SvgIcon size={size}>
        {/* Stacked horizontal layers */}
        <rect
          x="2"
          y="2"
          width="10"
          height="2.5"
          rx="0.5"
          fill="currentColor"
          fillOpacity="0.35"
        />
        <rect
          x="2"
          y="5.8"
          width="10"
          height="2.5"
          rx="0.5"
          fill="currentColor"
          fillOpacity="0.2"
        />
        <rect
          x="2"
          y="9.5"
          width="10"
          height="2.5"
          rx="0.5"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeWidth="0.5"
        />
      </_SvgIcon>
    );
  if (type === 'Stairway')
    return (
      <_SvgIcon size={size}>
        <path
          d="M2,12 L2,9 L5,9 L5,6 L8,6 L8,3 L12,3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </_SvgIcon>
    );
  if (type === 'Corridor')
    return (
      <_SvgIcon size={size}>
        {/* Passage / arrow through a gap */}
        <line
          x1="1"
          y1="7"
          x2="12"
          y2="7"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        <polygon points="9.5,5 13,7 9.5,9" fill="currentColor" />
        <line
          x1="2"
          y1="4"
          x2="2"
          y2="10"
          stroke="currentColor"
          strokeWidth="1"
          strokeOpacity="0.4"
        />
        <line
          x1="12"
          y1="4"
          x2="12"
          y2="10"
          stroke="currentColor"
          strokeWidth="1"
          strokeOpacity="0.4"
        />
      </_SvgIcon>
    );
  // Room (default) -- rectangle with door gap
  return (
    <_SvgIcon size={size}>
      <path
        d="M2,12.5 L2,1.5 L12,1.5 L12,12.5 L8,12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="2"
        y1="12.5"
        x2="5"
        y2="12.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      {/* Door swing arc */}
      <path
        d="M5,12.5 Q5,9 8,9"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.7"
        strokeOpacity="0.6"
      />
    </_SvgIcon>
  );
}
