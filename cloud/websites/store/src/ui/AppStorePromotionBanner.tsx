import React from "react";

function AppStorePromotionBanner() {
  const cdnUrl = import.meta.env.CLOUDFLARE_CDN_URL || "https://mentra-store-cdn.mentraglass.com";
  const bannerImageUrl = `${cdnUrl}/mentra_store_assets/getAppStoreBannerNew.png`;
  const iPhoneBaderImageUrl = `${cdnUrl}/mentra_store_assets/download_iPhone.svg?v=3`;
  const androidBaderImageUrl = `${cdnUrl}/mentra_store_assets/newAndroidBadge.svg?v=3`;
  const githubBaderImageUrl = `${cdnUrl}/mentra_store_assets/download_github.svg?v=3`;

  return (
    <div className="flex flex-col w-full px-4 sm:px-6 lg:px-8">
      {/* Hero Section */}
      <div className="flex justify-center items-center flex-col text-center mt-12 sm:mt-20 lg:mt-[128px] px-4">
        <div className="text-2xl sm:text-3xl md:text-4xl lg:text-[36px] font-bold mb-4 sm:mb-6">
          Mentra MiniApp Store
        </div>
        <div className="text-base sm:text-xl md:text-2xl lg:text-[20px] max-w-4xl leading-relaxed">
          Mentra MiniApp Store is the only app store for smart glasses. With other smart glasses, your experience is
          limited to whatever the company builds into the device, but not with Mentra Live. You Choose your reality, one
          app at a time.
        </div>
      </div>

      {/* Download Section */}
      <div className="w-full min-h-[200px] sm:h-auto lg:h-[453px] bg-[var(--primary-foreground)] flex flex-col [@media(min-width:1023px)]:flex-row justify-center items-center mt-12 sm:mt-32 lg:mt-[200px] rounded-2xl sm:rounded-3xl lg:rounded-[38px] p-6 sm:p-8 [@media(min-width:1023px)]:p-0 [clip-path:inset(-100%_0_0_0)]">
        <div className="flex flex-1 flex-col h-full justify-center lg:pl-[114px] w-full pr-[120px]">
          <div className="text-2xl sm:text-3xl md:text-4xl lg:text-3xl [@media(min-width:1358px)]:text-[36px] font-semibold mb-3 sm:mb-4 md:mb-5 lg:mb-[20px]">
            Download MentraOS
          </div>
          <div className="flex flex-col gap-2 sm:gap-2.5 md:gap-3 lg:gap-[10px] mb-4 sm:mb-5 md:mb-6">
            <div className="text-xs sm:text-sm md:text-base lg:text-sm [@media(min-width:1358px)]:text-lg 2xl:text-[20px] font-normal leading-relaxed">
              1. Open the App Store website on your phone or computer.
            </div>
            <div className="text-xs sm:text-sm md:text-base lg:text-sm [@media(min-width:1358px)]:text-lg 2xl:text-[20px] font-normal leading-relaxed">
              2. Choose an app and tap Install.
            </div>
            <div className="text-xs sm:text-sm md:text-base lg:text-sm [@media(min-width:1358px)]:text-lg 2xl:text-[20px] font-normal leading-relaxed">
              3. The app will appear on your MentraOS app in your Apps list.
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-3 md:gap-4 w-full">
            <a
              href="https://apps.apple.com/kh/app/mentra-the-smart-glasses-app/id6747363193"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-fit max-w-[180px] sm:max-w-none cursor-pointer">
              <img
                src={iPhoneBaderImageUrl}
                alt="Download on the App Store"
                className="h-9 sm:h-10 md:h-11 [@media(min-width:1023px)]:h-12 xl:h-[50px] w-full sm:w-auto hover:opacity-80 transition-opacity cursor-pointer"
              />
            </a>
            <a
              href="https://play.google.com/store/apps/details?id=com.mentra.mentra&hl=en_US"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-fit max-w-[180px] sm:max-w-none cursor-pointer">
              <img
                src={androidBaderImageUrl}
                alt="Get it on Google Play"
                className="h-9 sm:h-10 md:h-11 [@media(min-width:1023px)]:h-12 xl:h-[50px] w-full sm:w-auto hover:opacity-80 transition-opacity cursor-pointer"
              />
            </a>
            <a
              href="https://github.com/Mentra-Community/MentraOS"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-fit max-w-[180px] sm:max-w-none cursor-pointer">
              <img
                src={githubBaderImageUrl}
                alt="Get it on Github"
                className="h-9 sm:h-10 md:h-11 [@media(min-width:1023px)]:h-12 xl:h-[50px] w-full sm:w-auto hover:opacity-80 transition-opacity cursor-pointer"
              />
            </a>
          </div>
        </div>
        <img
          src={bannerImageUrl}
          alt="Get MentraOS App Store Banner"
          className="hidden [@media(min-width:1023px)]:block w-[300px] [@media(min-width:1228px)]:w-[400px] [@media(min-width:1589px)]:w-[450px] h-auto mr-8 [@media(min-width:1589px)]:mr-[150px] mt-8 [@media(min-width:1023px)]:mt-0 -mb-[150px]"
        />
      </div>
      <div
        className="mt-[80px] sm:mt-24 lg:mt-[80px] h-[290px] sm:h-[290px] lg:h-[290px] rounded-[24px] relative overflow-hidden flex flex-col justify-center items-center px-4 sm:px-6 lg:px-8"
        style={{ background: "linear-gradient(to right, #33CA80, #5fa8a8, #103422)" }}>
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] sm:w-[400px] lg:w-[500px] h-[200px] sm:h-[250px] lg:h-[300px] rounded-full"
          style={{
            background: "radial-gradient(circle, rgba(100, 150, 255, 1) 0%, transparent 100%)",
            filter: "blur(100px)",
          }}></div>
        <div
          className="absolute top-1/2 -left-1/5 -translate-y-2/3 w-[300px] h-[300px] sm:w-[400px] sm:h-[400px] lg:w-[500px] lg:h-[500px] rounded-full"
          style={{ background: "radial-gradient(circle, #F4CE9F 0%, transparent 70%)", filter: "blur(100px)" }}></div>
        <div className="flex justify-center items-center text-center font-normal text-base sm:text[20px] md:text=[20px] lg:text-[20px] z-2 text-[#FFFFFF] px-4 sm:px-6 max-w-4xl">
          With MiniApps from developers around the world, you can continually customize your glasses, adding what you
          want, removing what you don't. They're your glasses, and it's your data.
        </div>
        <a
          href="https://docs.mentraglass.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 sm:px-6 py-2 sm:py-3 mt-6 sm:mt-8 bg-white rounded-full font-medium text-sm sm:text-base z-10 relative hover:opacity-90 transition-opacity cursor-pointer text-black inline-block">
          Build Your Own App
        </a>
      </div>
    </div>
  );
}

export default AppStorePromotionBanner;
