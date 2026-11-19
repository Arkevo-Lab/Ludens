import * as React from "react"

export const pixelMarkStates = ["idle", "reasoning", "recording", "passed", "failed", "waiting"] as const
export type PixelMarkState = (typeof pixelMarkStates)[number]

// Clockwise from the top, so `--i` drives the assemble and chase order.
const RING = [[1, 0], [2, 0], [2, 1], [2, 2], [3, 2], [4, 2], [4, 3], [3, 4], [2, 4], [1, 4], [0, 3], [0, 2], [0, 1]] as const
const HOLLOW = [[1, 1], [1, 2], [1, 3], [2, 3], [3, 3]] as const
const CELL = 12
// Separate cells overlap by a hair and snap to device pixels so no seam shows between them.
const SIDE = CELL + 0.3
// The same ring as one outline, used whenever the cells do not move on their own.
const RING_PATH = "M12 0h24v24h24v24H48v12H12V48H0V12h12zM12 12v36h36V36H24V12z"

type PixelMarkProps = Omit<React.ComponentProps<"svg">, "children"> & {
  size?: number
  /** What the loose pixel says about the run. */
  state?: PixelMarkState
  /** A three-pixel tail runs round the ring. */
  loading?: boolean
  /** The hollow L is lit: a human holds control. */
  filled?: boolean
  /** Play the one-shot assemble on mount. */
  assemble?: boolean
  /** Accessible name. Without it the mark is decorative. */
  label?: string
}

function PixelMark({ size = 22, state = "idle", loading = false, filled = false, assemble = false, label, className, ...props }: PixelMarkProps) {
  const cells = loading || assemble
  return (
    <svg
      viewBox="0 0 60 60"
      width={size}
      height={size}
      className={className ? `pixel-mark ${className}` : "pixel-mark"}
      data-state={state}
      data-loading={loading || undefined}
      data-filled={filled || undefined}
      data-assemble={assemble || undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    >
      {HOLLOW.map(([x, y], j) => (
        <rect key={`h${j}`} className="pm-h" style={{ "--j": j } as React.CSSProperties} x={x * CELL} y={y * CELL} width={SIDE} height={SIDE} />
      ))}
      {cells ? (
        <g shapeRendering="crispEdges">
          {RING.map(([x, y], i) => (
            <rect key={`c${i}`} className="pm-c" style={{ "--i": i } as React.CSSProperties} x={x * CELL} y={y * CELL} width={SIDE} height={SIDE} />
          ))}
        </g>
      ) : (
        <path className="pm-c" fillRule="evenodd" d={RING_PATH} />
      )}
      <rect className="pm-p" x={4 * CELL} y={0} width={CELL} height={CELL} />
    </svg>
  )
}

export { PixelMark }
