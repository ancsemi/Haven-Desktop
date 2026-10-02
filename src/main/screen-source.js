'use strict';

function getSourceType(source) {
  const match = /^(screen|window):/.exec(String(source?.id || ''));
  return match ? match[1] : null;
}

function hasDisplayId(source) {
  return source?.display_id !== undefined &&
    source.display_id !== null &&
    String(source.display_id) !== '';
}

function hasSameDisplay(left, right) {
  return hasDisplayId(left) === hasDisplayId(right) &&
    (!hasDisplayId(left) || String(left.display_id) === String(right.display_id));
}

function resolveRefreshedSource(originalSources, freshSources, requestedId) {
  if (!Array.isArray(originalSources) || !Array.isArray(freshSources)) return null;
  const original = originalSources.find(source => source.id === requestedId);
  if (!original) return null;

  const sourceType = getSourceType(original);
  if (!sourceType) return null;
  if (sourceType === 'screen' && !hasDisplayId(original)) return null;

  const sameType = freshSources.filter(source => getSourceType(source) === sourceType);
  const exact = sameType.find(source =>
    source.id === requestedId &&
    source.name === original.name &&
    hasSameDisplay(source, original)
  );
  if (exact) return exact;

  if (sourceType === 'screen' && hasDisplayId(original)) {
    const sameDisplay = sameType.filter(source =>
      hasDisplayId(source) && String(source.display_id) === String(original.display_id)
    );
    if (sameDisplay.length === 1) return sameDisplay[0];
  }
  return null;
}

function getPhysicalDisplayBounds(display, dipToScreenPoint) {
  const scaleFactor = display.scaleFactor || 1;
  const width = Math.round(display.bounds.width * scaleFactor);
  const height = Math.round(display.bounds.height * scaleFactor);
  const center = dipToScreenPoint({
    x: Math.round(display.bounds.x + display.bounds.width / 2),
    y: Math.round(display.bounds.y + display.bounds.height / 2),
  });
  return {
    x: Math.round(center.x - width / 2),
    y: Math.round(center.y - height / 2),
    width,
    height,
  };
}

module.exports = { getPhysicalDisplayBounds, resolveRefreshedSource };
