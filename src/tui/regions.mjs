// Hit-testing for the mouse.
//
// The renderer paints whole lines, so there is no widget tree to walk when a
// click arrives. Instead every surface that wants to be clickable declares its
// rectangle while it paints, and the registry resolves a cell back to the
// topmost declaration. Zones live for exactly one frame, which keeps them
// honest: whatever you can see is whatever you can click.

export const LAYER = { body: 0, rail: 10, chrome: 20, overlay: 100 };

export class Regions {
  constructor() {
    this.zones = [];
    this.sequence = 0;
    // Survives the per-frame reset so a highlight does not flicker on repaint.
    this.hoverId = null;
    this.pressedId = null;
  }

  /** Drop every zone. Called at the top of each paint. */
  clear() {
    this.zones = [];
    this.sequence = 0;
  }

  /**
   * Declare an interactive rectangle.
   *
   * `onPress(app, event, local)` receives the zone-relative { row, column }, so
   * a list can turn a click into a row index without registering a zone per
   * row. `onWheel` and `onDrag` are optional and follow the same shape.
   */
  add({
    row, column, width, height,
    id = null, layer = LAYER.body, cursor = 'pointer',
    onPress = null, onWheel = null, onDrag = null, onRelease = null,
  }) {
    if (width <= 0 || height <= 0) return null;
    this.sequence += 1;
    const zone = {
      row, column, width, height, id, layer, cursor,
      onPress, onWheel, onDrag, onRelease,
      order: this.sequence,
    };
    this.zones.push(zone);
    return zone;
  }

  /** The topmost zone covering a cell: highest layer, then most recently added. */
  hit(row, column, { need = null } = {}) {
    let best = null;
    for (const zone of this.zones) {
      if (row < zone.row || row >= zone.row + zone.height) continue;
      if (column < zone.column || column >= zone.column + zone.width) continue;
      if (need && !zone[need]) continue;
      if (!best || zone.layer > best.layer || (zone.layer === best.layer && zone.order > best.order)) best = zone;
    }
    return best;
  }

  /** Zone-relative coordinates for an event that landed inside `zone`. */
  static local(zone, event) {
    return { row: event.row - zone.row, column: event.column - zone.column };
  }

  /** True when any zone at or above `layer` covers the cell. */
  covered(row, column, layer) {
    return this.zones.some((zone) => zone.layer >= layer
      && row >= zone.row && row < zone.row + zone.height
      && column >= zone.column && column < zone.column + zone.width);
  }
}

const DOUBLE_CLICK_MS = 400;

/**
 * Make a ListView clickable.
 *
 * A click moves the selection; a second click on the row that is already
 * selected activates it, as does a double click. Both gestures exist because
 * people arrive expecting one or the other, and neither costs anything.
 */
export function listZone(app, {
  row, column, width, height, list, id,
  layer = LAYER.body, focus = null, onSelect = null, onClick = null, onActivate = null,
}) {
  if (!app.regions) return;
  app.regions.add({
    row, column, width, height, id, layer,
    onPress: (target, event, zone) => {
      if (focus) target.focus = focus;
      const index = list.offset + (event.row - zone.row);
      if (index < 0 || index >= list.items.length) return;

      const now = Date.now();
      const previous = target.lastListClick;
      const repeat = previous && previous.id === id && previous.index === index
        && now - previous.at < DOUBLE_CLICK_MS;
      const reselect = list.selected === index;
      target.lastListClick = { id, index, at: now };

      list.selected = index;
      list.ensureVisible(height);
      const item = list.items[index];
      onSelect?.(target, item, index);
      // onClick only fires for a real press, never for the wheel moving the
      // selection, so a view can act on the first click without a scroll
      // triggering the same thing.
      if (onClick?.(target, item, index) === true) return;
      if ((repeat || reselect) && onActivate) onActivate(target, item, index);
    },
    onWheel: (target, event) => {
      const step = event.button === 'wheelup' ? -3 : 3;
      list.offset = Math.max(0, Math.min(list.offset + step, Math.max(0, list.items.length - height)));
      // Keep the selection inside the window the wheel just moved to.
      list.selected = Math.max(list.offset, Math.min(list.selected, list.offset + height - 1));
      list.selected = Math.max(0, Math.min(list.selected, Math.max(0, list.items.length - 1)));
      onSelect?.(target, list.items[list.selected], list.selected);
    },
  });
}

/** Make a scrolling Viewport clickable and wheel-scrollable. */
export function viewportZone(app, {
  row, column, width, height, viewport, id, layer = LAYER.body, focus = null,
}) {
  if (!app.regions) return;
  app.regions.add({
    row, column, width, height, id, layer,
    onPress: (target) => { if (focus) target.focus = focus; },
    onWheel: (target, event) => viewport.scroll(event.button === 'wheelup' ? -3 : 3, height),
  });
}

/**
 * Walk a strip of inline chips left to right, handing each one the columns it
 * occupies. Used by the tab strip and hint rail, where the painted string is
 * built by concatenation and the geometry has to be derived alongside it.
 */
export function chipTracker(startColumn = 0) {
  let column = startColumn;
  return {
    get column() { return column; },
    /** Claim `width` columns and return the rectangle they cover. */
    take(width) {
      const rect = { column, width };
      column += width;
      return rect;
    },
    skip(width) { column += width; },
  };
}
