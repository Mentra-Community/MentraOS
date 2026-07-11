export function textContent(data: unknown, isError = false) {
  const text =
    typeof data === "string"
      ? data
      : (JSON.stringify(data, null, 2) ?? String(data));
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
