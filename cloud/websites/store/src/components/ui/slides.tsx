import {motion} from "framer-motion"
import {useState, useEffect} from "react"
import {useNavigate} from "react-router-dom"
import api from "../../api"

/**
 * Captions Slide - Returns a div with the captions image and custom-placed buttons
 */
export const CaptionsSlide: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="min-w-full flex items-center justify-center relative px-4 sm:px-0">
      <motion.img
        src="/slides/captions_slide.png"
        alt="Captions Slide"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      {/* Custom positioned buttons for this slide */}
      <motion.button
        className="absolute font-bold bottom-[20px] left-[20px] sm:bottom-[2.5vw] sm:left-[4vw] bg-[#FBFF00] hover:bg-[#ffd500] text-black shadow-lg rounded-full cursor-pointer"
        style={{
          width: "clamp(150px, 13vw, 250px)",
          height: "clamp(35px, 2.8vw, 45px)",
          fontSize: "clamp(11px, 1vw, 15px)",
          padding: "0 clamp(16px, 2vw, 32px)",
        }}
        onClick={() => navigate("/package/com.augmentos.livecaptions")}
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.3, duration: 0.4}}
        whileHover={{scale: 1.05}}
        whileTap={{scale: 0.95}}>
        GET NOW
      </motion.button>
    </div>
  )
}

/**
 * Captions Slide Mobile - Mobile version with optimized image
 */
export const CaptionsSlideMobile: React.FC = () => {
  const navigate = useNavigate()
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [appData, setAppData] = useState<{
    name: string
    description: string
    logoURL: string
    packageName: string
  } | null>(null)

  useEffect(() => {
    const fetchAppData = async () => {
      try {
        const data = await api.app.getAppByPackageName("com.augmentos.livecaptions")
        if (data) {
          setAppData({
            name: data.name || "Live Captions",
            description: data.description || "Real-time speech-to-text captions",
            logoURL: data.logoURL || "",
            packageName: data.packageName,
          })
        }
      } catch (error) {
        console.error("Error fetching app data:", error)
      }
    }

    fetchAppData()
  }, [])

  const handleImageLoad = () => {
    setImageLoaded(true)
  }

  const handleImageError = () => {
    setImageError(true)
    setImageLoaded(true)
  }

  return (
    <div className="min-w-full flex items-center justify-center relative overflow-hidden">
      <motion.img
        src="/slides/banner-cap-phone.png"
        alt="Captions Slide Mobile"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      <motion.div
        className="absolute bottom-0 w-full min-h-[70px] sm:min-h-[90px] bg-[#4C8D3A] flex flex-row items-center gap-2 sm:gap-3 px-[11px] sm:px-4 py-2 sm:py-3 rounded-b-xl"
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.2, duration: 0.4}}>
        {/* App Image */}
        <div className="shrink-0 flex items-center">
          <div className="relative w-12 h-12 ">
            {/* Placeholder that shows immediately */}
            <div
              className={`absolute inset-0 rounded-xl bg-gray-200 dark:bg-gray-700 flex items-center justify-center transition-opacity duration-200 ${
                imageLoaded ? "opacity-0" : "opacity-100"
              }`}>
              <div className="w-4 h-4 sm:w-6 sm:h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
            </div>

            {/* Actual image that loads in background */}
            <img
              src={
                imageError
                  ? "https://placehold.co/48x48/gray/white?text=App"
                  : appData?.logoURL || "https://placehold.co/48x48/gray/white?text=App"
              }
              alt={`${appData?.name || "Live Captions"} logo`}
              className={`w-12 h-12 xs:w-12 xs:h-12 sm:w-14 sm:h-14 object-cover rounded-xl transition-opacity duration-200 ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          </div>
        </div>

        {/* App Information (name, tags, and description) */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 sm:gap-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          <h3 className="text-white font-semibold  xs:text-[12px] sm:text-[14px] leading-tight text-[18px]">
            {appData?.name || "Live Captions"}
          </h3>

          {/* Tags */}
          <span className=" text-white text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
            Language • Communication
          </span>

          {/* Description - hidden on very small screens */}
          <p className="text-[#d3d3d3] text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {appData?.description || "Real-time speech-to-text captions"}
          </p>
        </div>

        {/* Get Now Button */}
        <motion.button
          className="shrink-0  w-[88px] h-[38px] xs:w-[70px] xs:h-[28px] sm:w-[80px] sm:h-[32px] bg-[#2E610B] hover:bg-[#ffd500] text-white shadow-lg rounded-full cursor-pointer xs:text-[14px] sm:text-[14px] text-[14px] font-medium"
          onClick={() => navigate(`/package/${appData?.packageName || "com.augmentos.livecaptions"}`)}
          whileHover={{scale: 1.05}}
          whileTap={{scale: 0.95}}>
          Get Now
        </motion.button>
      </motion.div>
    </div>
  )
}

/**
 * Merge Slide - Returns a div with the merge image and custom-placed buttons
 */
export const MergeSlide: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="min-w-full flex items-center justify-center relative px-4 sm:px-0">
      <motion.img
        src="/slides/merge_slide.png"
        alt="Merge Slide"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      {/* Custom positioned buttons for this slide */}
      <motion.button
        className=" absolute font-bold bottom-[20px] left-[20px] sm:bottom-[2.2vw] sm:left-[3vw] bg-[#8F2995] hover:bg-[#00ddff] text-white shadow-lg rounded-full cursor-pointer"
        style={{
          width: "clamp(130px, 12vw, 190px)",
          height: "clamp(30px, 2.2vw, 35px)",
          fontSize: "clamp(11px, 0.85vw, 13px)",
          padding: "0 clamp(16px, 2vw, 32px)",
        }}
        onClick={() => navigate("/package/com.mentra.merge")}
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.3, duration: 0.4}}
        whileHover={{scale: 1.05}}
        whileTap={{scale: 0.95}}>
        GET NOW
      </motion.button>
    </div>
  )
}

/**
 * Merge Slide Mobile - Mobile version with optimized image
 */
export const MergeSlideMobile: React.FC = () => {
  const navigate = useNavigate()
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [appData, setAppData] = useState<{
    name: string
    description: string
    logoURL: string
    packageName: string
  } | null>(null)

  useEffect(() => {
    const fetchAppData = async () => {
      try {
        const data = await api.app.getAppByPackageName("com.mentra.merge")
        if (data) {
          setAppData({
            name: data.name || "Merge",
            description: data.description || "Unified messaging platform",
            logoURL: data.logoURL || "",
            packageName: data.packageName,
          })
        }
      } catch (error) {
        console.error("Error fetching app data:", error)
      }
    }

    fetchAppData()
  }, [])

  return (
    <div className="min-w-full flex items-center justify-center relative overflow-hidden">
      <motion.img
        src="/slides/banner-merge-phone.png"
        alt="Merge Slide Mobile"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      <motion.div
        className="absolute bottom-0 w-full min-h-[70px] sm:min-h-[90px] bg-[#d9d9d9]/50 backdrop-blur-[25px] flex flex-row items-center gap-2 sm:gap-3 px-[11px] sm:px-4 py-2 sm:py-3 rounded-b-xl"
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.2, duration: 0.4}}>
        {/* App Image */}
        <div className="shrink-0 flex items-center">
          <div className="relative w-12 h-12 ">
            <div
              className={`absolute inset-0 rounded-xl bg-gray-200 dark:bg-gray-700 flex items-center justify-center transition-opacity duration-200 ${
                imageLoaded ? "opacity-0" : "opacity-100"
              }`}>
              <div className="w-4 h-4 sm:w-6 sm:h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
            </div>

            <img
              src={
                imageError
                  ? "https://placehold.co/48x48/gray/white?text=App"
                  : appData?.logoURL || "https://placehold.co/48x48/gray/white?text=App"
              }
              alt={`${appData?.name || "Merge"} logo`}
              className={`w-12 h-12 xs:w-12 xs:h-12 sm:w-14 sm:h-14 object-cover rounded-xl transition-opacity duration-200 ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => {
                setImageError(true)
                setImageLoaded(true)
              }}
            />
          </div>
        </div>

        {/* App Information */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 sm:gap-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          <h3 className="text-white font-semibold xs:text-[12px] sm:text-[14px] leading-tight text-[18px]">
            {appData?.name || "Merge"}
          </h3>

          <span className="text-white text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
            Chat • Social
          </span>

          <p className="text-[#ebebeb] text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {appData?.description || "Unified messaging platform"}
          </p>
        </div>

        {/* Get Now Button */}
        <motion.button
          className="shrink-0 w-[88px] h-[38px] xs:w-[70px] xs:h-[28px] sm:w-[80px] sm:h-[32px] bg-[#8F2995] hover:bg-[#00ddff] text-white shadow-lg rounded-full cursor-pointer xs:text-[14px] sm:text-[14px] text-[14px] font-medium"
          onClick={() => navigate(`/package/${appData?.packageName || "com.mentra.merge"}`)}
          whileHover={{scale: 1.05}}
          whileTap={{scale: 0.95}}>
          Get Now
        </motion.button>
      </motion.div>
    </div>
  )
}

/**
 * Stream Slide - Returns a div with the stream image and custom-placed buttons
 */
export const StreamSlide: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="min-w-full flex items-center justify-center relative px-4 sm:px-0">
      <motion.img
        src="/slides/stream_slide.png"
        alt="Stream Slide"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      {/* Custom positioned buttons for this slide */}
      <motion.button
        className="absolute font-bold bottom-[20px] left-[20px] sm:bottom-[2.2vw] sm:left-[3vw] bg-[#000000] text-[#fff] shadow-lg rounded-full cursor-pointer"
        style={{
          width: "clamp(150px, 13vw, 250px)",
          height: "clamp(35px, 2.8vw, 45px)",
          fontSize: "clamp(11px, 1vw, 15px)",
          padding: "0 clamp(16px, 2vw, 32px)",
        }}
        onClick={() => navigate("/package/com.mentra.streamer")}
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.3, duration: 0.4}}
        whileHover={{scale: 1.05}}
        whileTap={{scale: 0.95}}>
        GET NOW
      </motion.button>
    </div>
  )
}

/**
 * Stream Slide Mobile - Mobile version with optimized image
 */
export const StreamSlideMobile: React.FC = () => {
  const navigate = useNavigate()
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [appData, setAppData] = useState<{
    name: string
    description: string
    logoURL: string
    packageName: string
  } | null>(null)

  useEffect(() => {
    const fetchAppData = async () => {
      try {
        const data = await api.app.getAppByPackageName("com.mentra.streamer")
        if (data) {
          setAppData({
            name: data.name || "Stream",
            description: data.description || "Live stream from your smart glasses",
            logoURL: data.logoURL || "",
            packageName: data.packageName,
          })
        }
      } catch (error) {
        console.error("Error fetching app data:", error)
      }
    }

    fetchAppData()
  }, [])

  return (
    <div className="min-w-full flex items-center justify-center relative overflow-hidden">
      <motion.img
        src="/slides/banner-stream-phone.png"
        alt="Stream Slide Mobile"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      <motion.div
        className="absolute bottom-0 w-full min-h-[70px] sm:min-h-[90px] bg-[#d9d9d9]/50 backdrop-blur-[25px] flex flex-row items-center gap-2 sm:gap-3 px-[11px] sm:px-4 py-2 sm:py-3 rounded-b-xl"
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.2, duration: 0.4}}>
        {/* App Image */}
        <div className="shrink-0 flex items-center">
          <div className="relative w-12 h-12 ">
            <div
              className={`absolute inset-0 rounded-xl bg-gray-200 dark:bg-gray-700 flex items-center justify-center transition-opacity duration-200 ${
                imageLoaded ? "opacity-0" : "opacity-100"
              }`}>
              <div className="w-4 h-4 sm:w-6 sm:h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
            </div>

            <img
              src={
                imageError
                  ? "https://placehold.co/48x48/gray/white?text=App"
                  : appData?.logoURL || "https://placehold.co/48x48/gray/white?text=App"
              }
              alt={`${appData?.name || "Stream"} logo`}
              className={`w-12 h-12 xs:w-12 xs:h-12 sm:w-14 sm:h-14 object-cover rounded-xl transition-opacity duration-200 ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => {
                setImageError(true)
                setImageLoaded(true)
              }}
            />
          </div>
        </div>

        {/* App Information */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 sm:gap-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          <h3 className="text-white font-semibold xs:text-[12px] sm:text-[14px] leading-tight text-[18px]">
            {appData?.name || "Stream"}
          </h3>

          <span className="text-white text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
            Media • Streaming
          </span>

          <p className="text-[#d3d3d3] text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {appData?.description || "Live stream from your smart glasses"}
          </p>
        </div>

        {/* Get Now Button */}
        <motion.button
          className="shrink-0 w-[88px] h-[38px] xs:w-[70px] xs:h-[28px] sm:w-[80px] sm:h-[32px] bg-[#000000] hover:bg-[#333333] text-white shadow-lg rounded-full cursor-pointer xs:text-[14px] sm:text-[14px] text-[14px] font-medium"
          onClick={() => navigate(`/package/${appData?.packageName || "com.mentra.streamer"}`)}
          whileHover={{scale: 1.05}}
          whileTap={{scale: 0.95}}>
          Get Now
        </motion.button>
      </motion.div>
    </div>
  )
}

/**
 * X Slide - Returns a div with the X image and custom-placed buttons
 */
export const XSlide: React.FC = () => {
  const navigate = useNavigate()

  return (
    <div className="min-w-full flex items-center justify-center relative px-4 sm:px-0">
      <motion.img
        src="/slides/x_slide.png"
        alt="X Slide"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      {/* Custom positioned buttons for this slide */}
      <motion.button
        className="absolute font-bold bottom-[20px] right-[20px] sm:bottom-[2.2vw] sm:right-[1.9vw] bg-[#ffffff] hover:bg-[#000000] hover:text-white text-black shadow-lg rounded-full cursor-pointer"
        style={{
          width: "clamp(150px, 13vw, 250px)",
          height: "clamp(35px, 2.8vw, 45px)",
          fontSize: "clamp(11px, 1vw, 15px)",
          padding: "0 clamp(16px, 2vw, 32px)",
        }}
        onClick={() => navigate("/package/com.augmentos.xstats")}
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.3, duration: 0.4}}
        whileHover={{scale: 1.05}}
        whileTap={{scale: 0.95}}>
        GET NOW
      </motion.button>
    </div>
  )
}

/**
 * X Slide Mobile - Mobile version with optimized image
 */
export const XSlideMobile: React.FC = () => {
  const navigate = useNavigate()
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [appData, setAppData] = useState<{
    name: string
    description: string
    logoURL: string
    packageName: string
  } | null>(null)

  useEffect(() => {
    const fetchAppData = async () => {
      try {
        const data = await api.app.getAppByPackageName("com.augmentos.xstats")
        console.log("Fetched app data for X:", data)
        if (data) {
          setAppData({
            name: data.name || "X",
            description: data.description || "Stay connected with what's happening on X",
            logoURL: data.logoURL || "",
            packageName: data.packageName,
          })
        }
      } catch (error) {
        console.error("Error fetching app data:", error)
      }
    }

    fetchAppData()
  }, [])

  return (
    <div className="min-w-full flex items-center justify-center relative overflow-hidden">
      <motion.img
        src="/slides/banner-x-phone.png"
        alt="X Slide Mobile"
        className="rounded-2xl w-full max-w-full h-auto object-contain"
        initial={{opacity: 0, scale: 0.95}}
        animate={{opacity: 1, scale: 1}}
        transition={{duration: 0.5}}
      />

      <motion.div
        className="absolute bottom-0 w-full min-h-[70px] sm:min-h-[90px] bg-[#d9d9d948] backdrop-blur-[25px] flex flex-row items-center gap-2 sm:gap-3 px-[11px] sm:px-4 py-2 sm:py-3 rounded-b-xl"
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{delay: 0.2, duration: 0.4}}>
        {/* App Image */}
        <div className="shrink-0 flex items-center">
          <div className="relative w-12 h-12 ">
            <div
              className={`absolute inset-0 rounded-xl bg-gray-200 dark:bg-gray-700 flex items-center justify-center transition-opacity duration-200 ${
                imageLoaded ? "opacity-0" : "opacity-100"
              }`}>
              <div className="w-4 h-4 sm:w-6 sm:h-6 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
            </div>

            <img
              src={
                imageError
                  ? "https://placehold.co/48x48/gray/white?text=App"
                  : appData?.logoURL || "https://placehold.co/48x48/gray/white?text=App"
              }
              alt={`${appData?.name || "X"} logo`}
              className={`w-12 h-12 xs:w-12 xs:h-12 sm:w-14 sm:h-14 object-cover rounded-xl transition-opacity duration-200 ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => {
                setImageError(true)
                setImageLoaded(true)
              }}
            />
          </div>
        </div>

        {/* App Information */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 sm:gap-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
          <h3 className="text-white font-semibold xs:text-[12px] sm:text-[14px] leading-tight text-[18px]">
            {appData?.name || "X"}
          </h3>

          <span className="text-white text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
            Social • News • Media
          </span>

          <p className="text-[#d3d3d3] text-[10px] -mt-1 line-clamp-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {appData?.description || "Stay connected with what's happening on X"}
          </p>
        </div>

        {/* Get Now Button */}
        <motion.button
          className="shrink-0 w-[88px] h-[38px] xs:w-[70px] xs:h-[28px] sm:w-[80px] sm:h-[32px] bg-[#0A0A0A] hover:bg-[#000000] hover:text-white text-white shadow-lg rounded-full cursor-pointer xs:text-[14px] sm:text-[14px] text-[14px] font-medium"
          onClick={() => navigate(`/package/${appData?.packageName || "com.augmentos.xstats"}`)}
          whileHover={{scale: 1.05}}
          whileTap={{scale: 0.95}}>
          Get Now
        </motion.button>
      </motion.div>
    </div>
  )
}
