import Skeleton from "@mui/material/Skeleton"
import {useTheme} from "../hooks/useTheme"

const SkeletonSlider = () => {
  const {theme} = useTheme()

  return (
    <div className="w-full relative mb-4 sm:mb-8 overflow-hidden">
      {/* Main Slide Skeleton */}
      <Skeleton
        variant="rounded"
        width="100%"
        height="clamp(200px, 40vw, 400px)"
        sx={{
          bgcolor: theme === "light" ? "rgba(0, 0, 0, 0.11)" : "rgba(255, 255, 255, 0.11)",
          borderRadius: "24px",
        }}
      />

      {/* Slide Indicators Skeleton */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-2 z0">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton
            key={i}
            variant="rounded"
            width={40}
            height={2}
            sx={{
              bgcolor: "rgba(255, 255, 255, 0.5)",
              borderRadius: "4px",
            }}
          />
        ))}
      </div>
    </div>
  )
}

export default SkeletonSlider
