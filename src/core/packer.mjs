// Binary MaxRects packer with a free list. Deterministic ordering.
// Places ONLY core rects; padding is reserved by inflating each candidate and
// recording the unpadded rect. A pack result's `placed` rects never overlap.
export class MaxRectsPacker {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.free = [{ x: 0, y: 0, w: width, h: height }];
    this.used = 0;
  }

  // items: [{id, w, h, allowRotate}] in priority order.
  insert(items) {
    const placed = [];
    const failed = [];
    for (const item of items) {
      const ok = this.#placeOne(item);
      if (ok) placed.push(ok);
      else failed.push(item);
    }
    return { placed, failed, free: this.free };
  }

  #placeOne(item) {
    const pad = item.pad;
    const variants = [{ w: item.w, h: item.h, rotated: false }];
    if (item.allowRotate !== false && item.w !== item.h) {
      variants.push({ w: item.h, h: item.w, rotated: true });
    }
    let best = null;
    for (const variant of variants) {
      const needW = variant.w + pad * 2;
      const needH = variant.h + pad * 2;
      for (const free of this.free) {
        if (free.w < needW || free.h < needH) continue;
        const scoreShort = Math.min(free.w - needW, free.h - needH);
        const scoreLong = Math.max(free.w - needW, free.h - needH);
        const area = free.w * free.h;
        const candidate = { free, variant, score: [scoreShort, scoreLong, -area] };
        if (!best || lexLess(candidate.score, best.score)) best = candidate;
      }
    }
    if (!best) return null;

    const { free, variant } = best;
    // Push the core to the free rect's outer edge, keeping the pad on the
    // inner sides so we never walk outside the atlas on two sides.
    const coreX = free.x + pad;
    const coreY = free.y + pad;
    const occupied = { x: free.x, y: free.y, w: variant.w + pad * 2, h: variant.h + pad * 2 };
    const placed = {
      id: item.id,
      x: coreX,
      y: coreY,
      w: variant.w,
      h: variant.h,
      rotated: variant.rotated,
    };
    this.#splitFree(occupied);
    this.#prune();
    this.used += occupied.w * occupied.h;
    return placed;
  }

  #splitFree(used) {
    const next = [];
    for (const r of this.free) {
      if (!(used.x < r.x + r.w && used.x + used.w > r.x && used.y < r.y + r.h && used.y + used.h > r.y)) {
        next.push(r);
        continue;
      }
      if (used.x > r.x) next.push({ x: r.x, y: r.y, w: used.x - r.x, h: r.h });
      if (used.x + used.w < r.x + r.w) {
        next.push({ x: used.x + used.w, y: r.y, w: r.x + r.w - (used.x + used.w), h: r.h });
      }
      if (used.y > r.y) {
        next.push({ x: r.x, y: r.y, w: r.w, h: used.y - r.y });
      }
      if (used.y + used.h < r.y + r.h) {
        next.push({ x: r.x, y: used.y + used.h, w: r.w, h: r.y + r.h - (used.y + used.h) });
      }
    }
    this.free = next;
  }

  #prune() {
    this.free = this.free.filter((a, i, arr) => {
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;
        const b = arr[j];
        const contained =
          a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
        if (contained && (j < i || !sameRect(a, b))) return false;
      }
      return true;
    });
  }
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

export function assertNoOverlap(placed) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        throw new Error(`overlap: ${a.id} and ${b.id}`);
      }
    }
  }
}
