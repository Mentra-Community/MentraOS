import React from "react";

function AppStorePromotionBanner() {
  const cdnUrl = import.meta.env.CLOUDFLARE_CDN_URL || "https://mentra-store-cdn.mentraglass.com";
  const bannerImageUrl = `${cdnUrl}/mentra_store_assets/getAppStoreBanner.png`;

  return (
    <div>
      <div>
        <div></div>
      </div>
      <div>
        <img src={bannerImageUrl} alt="Get MentraOS App Store Banner" className="w-full h-auto" />
      </div>
    </div>
  );
}

export default AppStorePromotionBanner;
