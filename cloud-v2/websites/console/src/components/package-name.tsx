import { cn } from "@/lib/utils";

type PackageNameProps = {
  packageName: string;
  packagePrefix?: string | null;
  className?: string;
};

export function PackageName({ packageName, packagePrefix, className }: PackageNameProps) {
  const normalizedPrefix = packagePrefix?.replace(/\.+$/, "");
  const prefixWithDot = normalizedPrefix ? `${normalizedPrefix}.` : "";
  const matchesPrefix = prefixWithDot !== "" && packageName.startsWith(prefixWithDot);
  const suffix = matchesPrefix ? packageName.slice(prefixWithDot.length) : packageName;

  return (
    <span className={cn("font-mono text-xs", className)}>
      {matchesPrefix ? <span className="text-[#a0a3aa]">{prefixWithDot}</span> : null}
      <span className="font-semibold text-[#6e727b]">{suffix}</span>
    </span>
  );
}
