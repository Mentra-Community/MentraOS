import { useTheme } from "../../hooks/useTheme";
import { Toaster as Sonner, ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-2xl group-[.toaster]:border group-[.toaster]:shadow-xl group-[.toaster]:backdrop-blur-sm font-redhat",
          description: "group-[.toast]:text-sm group-[.toast]:opacity-90",
          actionButton:
            "group-[.toast]:rounded-lg group-[.toast]:px-3 group-[.toast]:py-1.5 group-[.toast]:font-medium group-[.toast]:transition-all",
          cancelButton:
            "group-[.toast]:rounded-lg group-[.toast]:px-3 group-[.toast]:py-1.5 group-[.toast]:font-medium group-[.toast]:transition-all",
          success: "group-[.toaster]:text-[#00A814] group-[.toaster]:border-[#00A814]/20",
          error: "group-[.toaster]:text-red-500 group-[.toaster]:border-red-500/20",
          info: "group-[.toaster]:text-blue-500 group-[.toaster]:border-blue-500/20",
          warning: "group-[.toaster]:text-amber-500 group-[.toaster]:border-amber-500/20",
        },
        style: {
          background: theme === "light" ? "rgba(255, 255, 255, 0.98)" : "rgba(23, 23, 23, 0.98)",
          color: theme === "light" ? "#171717" : "#ffffff",
          borderColor: theme === "light" ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.08)",
          fontFamily: '"Red Hat Display", sans-serif',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
