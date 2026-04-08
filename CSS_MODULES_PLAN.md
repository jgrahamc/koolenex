# CSS Modules Migration Plan

## Overview

Convert all inline `style={{}}` objects to CSS Modules. Replace the JavaScript theme context (`useC()` / `ThemeCtx`) with CSS custom properties set on the root element. Remove the `makeGS` template string hack.

## Phase 1: Theme Infrastructure

### 1a. Create `client/src/theme.module.css`

Define CSS custom properties for both themes:

```css
:root, [data-theme="dark"] {
  --bg: #060a10;
  --surface: #0b1220;
  --border: #1a2a44;
  --border2: #1e3355;
  --text: #e0eeff;
  --muted: #8ab8e0;
  --dim: #5a80a8;
  --accent: #00b4ff;
  --green: #00ff9f;
  --amber: #ffcc00;
  --red: #ff4466;
  --purple: #c084fc;
  --actuator: #00b4ff;
  --sensor: #00ff9f;
  --router: #ffcc00;
  --input-bg: #080b0f;
  --sidebar: #060810;
  --hover: #0f1620;
  --selected: #0c1830;
}

[data-theme="light"] {
  --bg: #f0f4f8;
  --surface: #ffffff;
  /* ... etc */
}
```

### 1b. Create `client/src/global.css`

Move the `makeGS` content (scrollbar, animations, utility classes) into a real CSS file. Replace hardcoded colors with `var(--bg)`, `var(--hover)` etc.

### 1c. Update `App.tsx`

- Import `global.css` at the top
- Remove the `makeGS` function and `<style>{makeGS(C)}</style>`
- Set `data-theme` attribute on root div instead of using `ThemeCtx.Provider`
- Keep `ThemeCtx` temporarily for components not yet migrated (allows incremental migration)

### 1d. Update `theme.ts`

- Keep `DARK_C`/`LIGHT_C` constants (used by non-migrated components during transition)
- Keep `STATUS_COLOR`, `SPACE_COLOR` as JS objects (used for dynamic per-item coloring that CSS can't handle)
- Export a `setTheme(theme: 'dark' | 'light')` function that sets `document.documentElement.dataset.theme`

## Phase 2: Shared Components (`primitives.tsx`)

This file defines Badge, Chip, TH, TD, SearchBox, SectionHeader, Btn, TabBar, Empty, ConfirmModal, Toast, PinAddr, SpacePath — used by every view.

- Create `client/src/primitives.module.css`
- Convert each component's inline styles to CSS classes
- Replace `const C = useC()` with CSS variable references
- Where colors are passed as props (e.g. Badge color), use `style={{ '--badge-color': color }}` with the CSS module consuming `var(--badge-color)`

## Phase 3: Small Components

Convert one at a time, each getting its own `.module.css`:

1. `icons.tsx` → `icons.module.css` (SVG styling)
2. `search.tsx` → `search.module.css`
3. `columns.tsx` → `columns.module.css`
4. `hex.tsx` → `hex.module.css`
5. `rtf.tsx` → `rtf.module.css`
6. `diagram.tsx` → `diagram.module.css`
7. `AddDeviceModal.tsx` → `AddDeviceModal.module.css`

## Phase 4: Detail Panels

8. `detail/DeviceParameters.tsx` → `detail/DeviceParameters.module.css`
9. `detail/DevicePinPanel.tsx` → `detail/DevicePinPanel.module.css`
10. `detail/GAPinPanel.tsx` → `detail/GAPinPanel.module.css`
11. `detail/ComparePanel.tsx` → `detail/ComparePanel.module.css`
12. `detail/PinTelegramFeed.tsx` → `detail/PinTelegramFeed.module.css`
13. `detail/PinDetailView.tsx` → `detail/PinDetailView.module.css`
14. `detail/DeviceProductTab.tsx` → `detail/DeviceProductTab.module.css`

## Phase 5: Views

15-29. Each view file gets its own `.module.css`. These are the largest files.

## Phase 6: App Shell

30. `App.tsx` → `App.module.css` — title bar, sidebar, main layout

## Phase 7: Cleanup

- Remove `useC()` hook and `ThemeCtx` (all consumers now use CSS variables)
- Remove `DARK_C`/`LIGHT_C` exports if no longer referenced
- Remove `makeGS` function
- Delete the `<style>` tag injection from App.tsx

## Patterns

### Inline style → CSS module

Before:
```tsx
<div style={{ background: C.surface, border: `1px solid ${C.border}`, padding: 8 }}>
```

After:
```tsx
<div className={styles.card}>
```
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 8px;
}
```

### Dynamic values (props-driven colors)

Before:
```tsx
<span style={{ color: device.status === 'programmed' ? C.green : C.dim }}>
```

After — use a data attribute:
```tsx
<span className={styles.status} data-status={device.status}>
```
```css
.status[data-status="programmed"] { color: var(--green); }
.status[data-status="unassigned"] { color: var(--amber); }
```

Or for truly dynamic values (e.g. arbitrary hex from a map), keep a minimal inline style:
```tsx
<span className={styles.dot} style={{ background: STATUS_COLOR[device.status] }}>
```

### Conditional classes

Use template literals or a helper:
```tsx
<div className={`${styles.navItem} ${active ? styles.active : ''}`}>
```

### hover/focus states

Before (impossible with inline styles, worked around with `makeGS`):
```tsx
<div className="rh" style={{ padding: 8 }}>
```

After:
```css
.row { padding: 8px; }
.row:hover { background: var(--hover); cursor: pointer; }
```

## Vite Configuration

No changes needed — Vite supports CSS Modules out of the box. Any file named `*.module.css` is automatically scoped.

## TypeScript

Add `client/src/css-modules.d.ts`:
```ts
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
```

## Estimated Scope

- ~30 new `.module.css` files
- ~30 `.tsx` files modified
- 1 new `global.css`
- 1 new `css-modules.d.ts`
- `theme.ts` simplified
- `App.tsx` significantly simplified (no more makeGS, no ThemeCtx.Provider wrapping)
