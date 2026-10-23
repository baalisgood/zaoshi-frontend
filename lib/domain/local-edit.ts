export const localEditOptions = [
  { value: "replace", label: "替换" },
  { value: "blend", label: "融合" },
  { value: "recolor", label: "换颜色" },
  { value: "rematerial", label: "换材质" },
  { value: "reshape", label: "更换样式" },
  { value: "prompt", label: "提示词修改" },
] as const;
export type LocalEditOperation = typeof localEditOptions[number]["value"];
export function localEditInstruction(operation: LocalEditOperation): string { return `local-edit:v2:${operation}`; }
export function parseLocalEditInstruction(value: unknown): LocalEditOperation | undefined {
  return localEditOptions.find((option) => localEditInstruction(option.value) === value || (option.value !== "prompt" && `local-edit:v1:${option.value}` === value))?.value;
}
/** The explicit selection role is required; ordinary free text never enables local editing. */
export function validLocalEdit(workflow: string, roles: readonly string[], instruction: unknown): boolean {
  return workflow === "advanced" && Boolean(parseLocalEditInstruction(instruction)) && roles[0] === "source" && roles[1] === "selection" && roles.length <= 5 && roles.slice(2).every((role) => role === "furnishing");
}

export function localEditUsesPrompt(instruction: unknown): boolean {
  return typeof instruction === "string" && (instruction.startsWith("local-edit:v1:") || instruction === "local-edit:v2:prompt");
}
