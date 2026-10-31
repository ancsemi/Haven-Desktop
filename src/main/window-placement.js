'use strict';

// Where a window may sit. A saved position can name a monitor that is gone, and
// a VR headset's virtual monitor can stay listed while nobody can see it, which
// leaves the window where no mouse can reach it (Haven #5847). No Electron here,
// so the rules can be tested on their own.

// How much of a window must show on a monitor to count as reachable.
const MIN_VISIBLE = 100;

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Whether enough of these bounds shows on one of these displays to grab them. */
function onSomeDisplay(bounds, displays) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  const box = { width: 800, height: 600, ...bounds };
  return displays.some((d) => {
    const o = overlap(box, d.workArea);
    return !!o && o.w >= Math.min(MIN_VISIBLE, box.width) && o.h >= Math.min(MIN_VISIBLE, box.height);
  });
}

/**
 * The saved window bounds, without a position that no monitor can show. The
 * size stays, and with no position Electron centers the window on the main
 * monitor. Undefined x and y are fine: a first run has only a size.
 */
function usableBounds(saved, displays) {
  if (!saved || typeof saved !== 'object') return {};
  if (!Number.isFinite(saved.x) && !Number.isFinite(saved.y)) return saved;
  if (onSomeDisplay(saved, displays)) return saved;
  const { x: _x, y: _y, ...rest } = saved;
  return rest;
}

/** These bounds centered in a work area, and made smaller if they would not fit. */
function centeredIn(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

module.exports = { onSomeDisplay, usableBounds, centeredIn };
