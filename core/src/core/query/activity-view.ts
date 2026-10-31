/** Browser-safe presentation helpers shared by the server projection and the incremental UI. */
import type { LogBlock } from "./activity";

export const blockLabels: Record<LogBlock["kind"], string> = {
  thinking: "思考", text: "文本", tool: "工具", system: "系统", diagnostic: "诊断",
};

export const printable = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");

/** Shared by the server projection and incremental UI, never a full-run filter. */
export function activitySearchText(block: LogBlock): string {
  return [block.title, block.text, blockLabels[block.kind],
    block.source?.component, block.source?.implementation, printable(block.tool), printable(block.trace), block.id]
    .filter(Boolean).join("\n").toLocaleLowerCase();
}
