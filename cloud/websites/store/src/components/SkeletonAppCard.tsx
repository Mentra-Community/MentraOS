import Skeleton from "@mui/material/Skeleton";
import { useTheme } from "../hooks/useTheme";

const SkeletonAppCard = () => {
  const { theme } = useTheme();

  return (
    <div className="flex gap-2 sm:gap-3 rounded-sm relative py-3">
      {/* App Icon Skeleton - matches w-14 h-14 sm:w-16 sm:h-16 */}
      <div className="shrink-0 flex items-start">
        <Skeleton
          variant="rounded"
          className="w-14 h-14 sm:w-16 sm:h-16"
          sx={{
            bgcolor:
              theme === "light"
                ? "rgba(0, 0, 0, 0.11)"
                : "rgba(255, 255, 255, 0.11)",
            borderRadius: "16px",
          }}
        />
      </div>

      {/* App Info Skeleton */}
      <div className="flex-1 flex flex-col justify-center min-w-0">
        {/* App Name - matches text-[16px] */}
        <Skeleton
          variant="text"
          width="60%"
          height={20}
          sx={{
            bgcolor:
              theme === "light"
                ? "rgba(0, 0, 0, 0.11)"
                : "rgba(255, 255, 255, 0.11)",
            mb: 0.25,
          }}
        />

        {/* Tags - matches text-[11px] sm:text-[13px] */}
        <div className="flex gap-1 mb-1">
          <Skeleton
            variant="text"
            width={40}
            height={14}
            sx={{
              bgcolor:
                theme === "light"
                  ? "rgba(0, 0, 0, 0.11)"
                  : "rgba(255, 255, 255, 0.11)",
            }}
          />
          <Skeleton
            variant="text"
            width={35}
            height={14}
            sx={{
              bgcolor:
                theme === "light"
                  ? "rgba(0, 0, 0, 0.11)"
                  : "rgba(255, 255, 255, 0.11)",
            }}
          />
        </div>

        {/* Description - matches text-[10px] with 1 line */}
        <Skeleton
          variant="text"
          width="85%"
          height={13}
          sx={{
            bgcolor:
              theme === "light"
                ? "rgba(0, 0, 0, 0.11)"
                : "rgba(255, 255, 255, 0.11)",
          }}
        />
      </div>

      {/* Install Button Skeleton - matches w-[56px] h-[36px] */}
      <div className="shrink-0 flex items-center">
        <Skeleton
          variant="rounded"
          width={56}
          height={36}
          sx={{
            bgcolor:
              theme === "light"
                ? "rgba(0, 0, 0, 0.11)"
                : "rgba(255, 255, 255, 0.11)",
            borderRadius: "9999px",
          }}
        />
      </div>
    </div>
  );
};

export default SkeletonAppCard;
