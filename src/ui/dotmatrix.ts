/**
 * Terminal-cell adaptations of Dot Matrix's 3×3 loader rhythms.
 * The upstream registry components render in React; these frames stay
 * entirely within one terminal row and do not need a browser runtime.
 */
const ORBIT = [0, 1, 2, 5, 8, 7, 6, 3] as const;
const BLOOM: ReadonlyArray<ReadonlyArray<number>> = [
  [4], [1, 4], [1, 3, 4], [1, 3, 4, 5],
  [0, 1, 3, 4, 5], [0, 1, 2, 3, 4, 5],
  [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 6, 7, 8],
  [1, 2, 3, 4, 5, 6, 7, 8], [2, 3, 4, 5, 6, 7, 8],
  [2, 4, 5, 6, 7, 8], [4, 5, 6, 7, 8],
  [4, 6, 7, 8], [4, 7, 8], [4, 7], [4],
];

export type DotMotion = "orbit" | "bloom";

export function renderDotMark(frame: number, motion: DotMotion = "orbit"): string {
  const tick = Math.max(0, Math.floor(frame));
  const lit = motion === "orbit"
    ? [ORBIT[tick % ORBIT.length]]
    : BLOOM[tick % BLOOM.length];
  const cells = Array.from({ length: 9 }, (_, index) =>
    lit.includes(index) ? "●" : "·",
  );
  return `${cells.slice(0, 3).join("")} ${cells.slice(3, 6).join("")} ${cells.slice(6).join("")}`;
}
