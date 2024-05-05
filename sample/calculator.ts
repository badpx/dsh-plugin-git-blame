export interface Point {
  x: number;
  y: number;
}

/** Add two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Subtract b from a. */
export function subtract(a: number, b: number): number {
  return a - b;
}

/** Scale a point by a factor. */
export function scale(point: Point, factor: number): Point {
  return { x: point.x * factor, y: point.y * factor };
}

/** Compute the Euclidean length of a vector. */
export function magnitude(point: Point): number {
  return Math.sqrt(point.x * point.x + point.y * point.y);
}

/** Clamp a value into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Return the absolute value of a number. */
export function absolute(value: number): number {
  return Math.abs(value);
}
