export interface LabelBox { left: number; top: number; width: number; height: number }

/** Suppress colliding text only. The original structure geometry is never moved.
 * Place the selected label first so it always remains visible. */
export function reserveLabel(box: LabelBox, occupied: LabelBox[], selected = false, padding = 3): boolean {
  if (!selected && occupied.some((other) => box.left < other.left + other.width + padding
    && box.left + box.width + padding > other.left
    && box.top < other.top + other.height + padding
    && box.top + box.height + padding > other.top)) return false;
  occupied.push(box);
  return true;
}
