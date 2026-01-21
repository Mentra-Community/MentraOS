import Skeleton from "@mui/material/Skeleton";
import { useTheme } from "../hooks/useTheme";

const SkeletonAppDetails = () => {
  const { theme } = useTheme();

  return (
    <div className="px-6 py-6 pb-safe sm:p-12 sm:pb-16">
      <div className="max-w-2xl mx-auto sm:max-w-none">
        {/* Header Section */}
        <div className="mb-8">
          {/* Mobile Layout */}
          <div className="sm:hidden">
            <div className="flex items-start gap-4 mb-4">
              {/* App Icon Skeleton */}
              <Skeleton
                variant="rounded"
                width={80}
                height={80}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "20px",
                }}
              />

              {/* App Info */}
              <div className="flex-1 min-w-0 pr-8">
                {/* App Title */}
                <Skeleton
                  variant="text"
                  width="80%"
                  height={32}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    mb: 1,
                  }}
                />

                {/* Company Name */}
                <Skeleton
                  variant="text"
                  width="50%"
                  height={20}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    mb: 1,
                  }}
                />

                {/* Category Tag */}
                <Skeleton
                  variant="text"
                  width="60%"
                  height={16}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  }}
                />
              </div>
            </div>
          </div>

          {/* Desktop Layout */}
          <div className="hidden sm:flex items-start gap-6 mb-6">
            <div className="flex-1 min-w-0">
              {/* App Title */}
              <Skeleton
                variant="text"
                width="60%"
                height={36}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  mb: 2,
                }}
              />

              {/* Company Name */}
              <Skeleton
                variant="text"
                width="40%"
                height={20}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  mb: 2,
                }}
              />

              {/* Tags */}
              <div className="flex gap-2 mb-4">
                <Skeleton
                  variant="rounded"
                  width={80}
                  height={28}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    borderRadius: "14px",
                  }}
                />
                <Skeleton
                  variant="rounded"
                  width={70}
                  height={28}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    borderRadius: "14px",
                  }}
                />
              </div>

              {/* Buttons */}
              <div className="flex gap-3 mb-4">
                <Skeleton
                  variant="rounded"
                  width={200}
                  height={36}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    borderRadius: "8px",
                  }}
                />
                <Skeleton
                  variant="rounded"
                  width={100}
                  height={36}
                  sx={{
                    bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                    borderRadius: "8px",
                  }}
                />
              </div>
            </div>

            {/* App Icon - Desktop */}
            <Skeleton
              variant="rounded"
              width={140}
              height={140}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                borderRadius: "28px",
              }}
            />
          </div>

          {/* Install Button - Mobile */}
          <div className="sm:hidden mb-6">
            <Skeleton
              variant="rounded"
              width="100%"
              height={48}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                borderRadius: "8px",
              }}
            />
          </div>

          {/* About this app Section Title - Mobile */}
          <div className="sm:hidden mb-4">
            <Skeleton
              variant="text"
              width="40%"
              height={24}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
              }}
            />
          </div>

          {/* Preview Images Carousel - Mobile */}
          <div className="sm:hidden mb-6">
            <div className="flex gap-3 overflow-x-hidden pb-3">
              {/* Landscape Preview */}
              <Skeleton
                variant="rounded"
                width={498}
                height={280}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
              {/* Portrait Preview */}
              <Skeleton
                variant="rounded"
                width={130}
                height={280}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
              {/* Another Landscape */}
              <Skeleton
                variant="rounded"
                width={498}
                height={280}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
            </div>
          </div>

          {/* Description - Mobile */}
          <div className="sm:hidden mb-6">
            <Skeleton
              variant="text"
              width="100%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                mb: 1,
              }}
            />
            <Skeleton
              variant="text"
              width="90%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                mb: 1,
              }}
            />
            <Skeleton
              variant="text"
              width="80%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
              }}
            />
          </div>
        </div>

        {/* Expandable Sections - Mobile */}
        <div className="sm:hidden space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton
              key={i}
              variant="rounded"
              width="100%"
              height={60}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                borderRadius: "12px",
              }}
            />
          ))}
        </div>

        {/* Tab Content - Desktop */}
        <div className="hidden sm:block">
          {/* About this app Section Title - Desktop */}
          <div className="mb-6">
            <Skeleton
              variant="text"
              width="25%"
              height={32}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
              }}
            />
          </div>

          {/* Preview Images Carousel - Desktop */}
          <div className="mb-8">
            <div className="flex gap-4 overflow-x-hidden pb-4">
              {/* Landscape Preview */}
              <Skeleton
                variant="rounded"
                width={750}
                height={422}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
              {/* Portrait Preview */}
              <Skeleton
                variant="rounded"
                width={195}
                height={422}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
              {/* Another Landscape */}
              <Skeleton
                variant="rounded"
                width={750}
                height={422}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  borderRadius: "12px",
                  flexShrink: 0,
                }}
              />
            </div>
          </div>

          {/* Description Content - Desktop */}
          <div className="mb-8">
            <Skeleton
              variant="text"
              width="100%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                mb: 1,
              }}
            />
            <Skeleton
              variant="text"
              width="95%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                mb: 1,
              }}
            />
            <Skeleton
              variant="text"
              width="90%"
              height={20}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
              }}
            />
          </div>

          {/* Additional Sections */}
          <div className="space-y-6">
            <Skeleton
              variant="text"
              width="30%"
              height={28}
              sx={{
                bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
              }}
            />
            <div>
              <Skeleton
                variant="text"
                width="100%"
                height={20}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                  mb: 1,
                }}
              />
              <Skeleton
                variant="text"
                width="85%"
                height={20}
                sx={{
                  bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SkeletonAppDetails;
