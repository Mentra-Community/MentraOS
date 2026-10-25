import en, {type TranslationResource} from "./en"

const hi = {
  ...en,
  common: {
    ok: "ठीक है!",
    cancel: "रद्द करें",
    back: "वापस",
    logOut: "लॉग आउट",
  },
  welcomeScreen: {
    postscript:
      "psst - शायद आपका ऐप ऐसा नहीं दिखता है। (जब तक कि आपके डिजाइनर ने आपको ये स्क्रीन नहीं दी हों, और उस स्थिति में, इसे लॉन्च करें!)",
    readyForLaunch: "आपका ऐप, लगभग लॉन्च के लिए तैयार है!",
    exciting: "(ओह, यह रोमांचक है!)",
    letsGo: "चलो चलते हैं!",
  },
  errorScreen: {
    title: "कुछ गलत हो गया!",
    friendlySubtitle:
      "यह वह स्क्रीन है जो आपके उपयोगकर्ता संचालन में देखेंगे जब कोई त्रुटि होगी। आप इस संदेश को बदलना चाहेंगे (जो `app/i18n/hi.ts` में स्थित है) और शायद लेआउट भी (`app/screens/ErrorScreen`)। यदि आप इसे पूरी तरह से हटाना चाहते हैं, तो `app/app.tsx` में <ErrorBoundary> कंपोनेंट की जांच करें।",
    reset: "ऐप रीसेट करें",
    traceTitle: "%{name} स्टैक से त्रुटि",
  },
  emptyStateComponent: {
    generic: {
      heading: "इतना खाली... इतना उदास",
      content: "अभी तक कोई डेटा नहीं मिला। रीफ्रेश करने या ऐप को पुनः लोड करने के लिए बटन दबाएं।",
      button: "चलो फिर से कोशिश करते हैं",
    },
  },

  errors: {
    invalidEmail: "अमान्य ईमेल पता।",
  },
  loginScreen: {
    logIn: "लॉग इन करें",
    enterDetails:
      "सर्वश्रेष्ठ रहस्य पता करने के लिए नीचे अपना विवरण दर्ज करें। आप कभी अनुमान नहीं लगा पाएंगे कि हमारे पास क्या इंतजार कर रहा है। या शायद आप कर सकते हैं; यह रॉकेट साइंस नहीं है।",
    emailFieldLabel: "ईमेल",
    passwordFieldLabel: "पासवर्ड",
    emailFieldPlaceholder: "अपना ईमेल पता दर्ज करें",
    passwordFieldPlaceholder: "सुपर सीक्रेट पासवर्ड यहाँ",
    tapToLogIn: "लॉग इन करने के लिए टैप करें!",
    hint: "संकेत: आप किसी भी ईमेल पते और अपने पसंदीदा पासवर्ड का उपयोग कर सकते हैं :)",
  },
  home: {
    developmentBuild: "डेवलपमेंट बिल्ड",
    pairAgain: "फिर से पेयर करें",
    hardwareIncompatible: "हार्डवेयर असंगत",
    hardwareIncompatibleMessage:
      "{{app}} को ऐसे हार्डवेयर की आवश्यकता है जो आपके कनेक्टेड चश्मे में उपलब्ध नहीं है: {{missing}}",
  },
  settings: {
    ...en.settings,
    forgetGlassesWhilePairing:
      "Bluetooth पेयरिंग जारी है। पहले सिस्टम पेयरिंग डायलॉग को स्वीकार या बंद करें, फिर चश्मे को दोबारा अनपेयर करने की कोशिश करें।",
  },
  pairing: {
    ...en.pairing,
    livePairingScanTitle: "अपने चश्मे को पेयरिंग मोड में रखें",
    livePairingScanBody: "पावर बटन को जल्दी से 3 बार दबाएँ। आपका चश्मा 4 अक्षरों का कोड बोलेगा।",
    livePairingScanSearching: "आपका चश्मा खोजा जा रहा है",
    pairingModeAlertTitle: "आपका चश्मा पेयरिंग मोड में है",
    pairingModeAlertBody: "बाहर निकलने के लिए पावर बटन को 3 बार दबाएँ।",
    nearbyNotInPairingModeHint:
      "पास में Mentra Live चश्मे मिले, लेकिन वे पेयरिंग मोड में नहीं हैं। पावर बटन को तेज़ी से 3 बार दबाएँ, फिर फिर से कोशिश करें।",
    notInPairingModeLabel: "पेयरिंग मोड में नहीं",
    notInPairingModeAlertTitle: "पेयरिंग मोड शुरू करें",
    notInPairingModeAlertMessage:
      "पावर बटन को तेज़ी से 3 बार दबाएँ। LED चमकता है और चश्मा 4-अक्षर का कोड बोलता है। फिर चश्मे को फिर से चुनें।",
    pairingCodeLabel: "कोड {{code}}",
    legacyFirmwareLabel: "पुराना फ़र्मवेयर",
    livePairingModeInfo:
      "पावर बटन को तेज़ी से 3 बार दबाएँ। LED चमकता है और चश्मा 4-अक्षर का कोड (0–9, A–F) बोलता है। एक से ज़्यादा यूनिट दिखें तो उसी कोड से मिलाएँ।",
    noGlassesFoundHint: "पक्का करें कि आपने पावर बटन को तेज़ी से 3 बार दबाया, फिर फिर से कोशिश करें।",
  },
  onboarding: {
    ...en.onboarding,
    btClassicStep1: "सेटिंग्स खोलें पर टैप करें",
    btClassicStep2: "Bluetooth पर टैप करें",
    btClassicStep3: 'मेरे डिवाइस या अन्य डिवाइस में "{{name}}" पर टैप करें',
    btClassicStep4: 'जब "कनेक्टेड" दिखे, तो ऐप पर लौटें',
    forgetIosPairingTitle: "पुरानी पेयरिंग हटाएँ",
    forgetIosPairingSubtitle: "जारी रखने के लिए अपने iPhone पर सहेजी गई Bluetooth पेयरिंग हटाएँ।",
    forgetIosPairingStep1: "सेटिंग्स खोलें, फिर Bluetooth पर टैप करें।",
    forgetIosPairingStep2: "{{name}} के बगल में ⓘ पर टैप करें, फिर इस डिवाइस को भूल जाएँ पर टैप करें।",
    forgetIosPairingStep3: "फिर से पेयर करने के लिए Mentra App पर लौटें।",
  },
  demoNavigator: {
    componentsTab: "कंपोनेंट्स",
    debugTab: "डीबग",
    communityTab: "समुदाय",
    podcastListTab: "पॉडकास्ट",
  },
  demoCommunityScreen: {
    title: "समुदाय से जुड़ें",
    tagLine: "Infinite Red के React Native इंजीनियरों के समुदाय से जुड़ें और हमारे साथ अपने ऐप विकास को बेहतर बनाएं!",
    joinUsOnSlackTitle: "Slack पर हमसे जुड़ें",
    joinUsOnSlack:
      "क्या आप चाहते हैं कि दुनिया भर के React Native इंजीनियरों से जुड़ने के लिए कोई जगह हो? Infinite Red Community Slack में बातचीत में शामिल हों! हमारा बढ़ता हुआ समुदाय प्रश्न पूछने, दूसरों से सीखने और अपने नेटवर्क को बढ़ाने के लिए एक सुरक्षित स्थान है।",
    joinSlackLink: "Slack समुदाय में शामिल हों",
    makeIgniteEvenBetterTitle: "Ignite को और बेहतर बनाएं",
    makeIgniteEvenBetter:
      "Ignite को और बेहतर बनाने का कोई विचार है? हमें यह सुनकर खुशी होगी! हम हमेशा ऐसे लोगों की तलाश में रहते हैं जो हमें सर्वश्रेष्ठ React Native टूलिंग बनाने में मदद करना चाहते हैं। Ignite के भविष्य को बनाने में हमारे साथ शामिल होने के लिए GitHub पर हमसे जुड़ें।",
    contributeToIgniteLink: "Ignite में योगदान दें",
    theLatestInReactNativeTitle: "React Native में नवीनतम",
    theLatestInReactNative: "हम आपको React Native के सभी प्रस्तावों पर अपडेट रखने के लिए यहां हैं।",
    reactNativeRadioLink: "React Native रेडियो",
    reactNativeNewsletterLink: "React Native न्यूजलेटर",
    reactNativeLiveLink: "React Native लाइव",
    chainReactConferenceLink: "Chain React कॉन्फ्रेंस",
    hireUsTitle: "अपने अगले प्रोजेक्ट के लिए Infinite Red को काम पर रखें",
    hireUs:
      "चाहे वह एक पूरा प्रोजेक्ट चलाना हो या हमारे हैंड्स-ऑन प्रशिक्षण के साथ टीमों को गति देना हो, Infinite Red लगभग किसी भी React Native प्रोजेक्ट में मदद कर सकता है।",
    hireUsLink: "हमें एक संदेश भेजें",
  },
  demoShowroomScreen: {
    jumpStart: "अपने प्रोजेक्ट को जंप स्टार्ट करने के लिए कंपोनेंट्स!",
    lorem2Sentences:
      "कोई भी काम जो आप नहीं करना चाहते, उसे करने के लिए किसी और को ढूंढना चाहिए। जो लोग दूसरों की मदद करते हैं, वे खुद की भी मदद करते हैं।",
    demoHeaderTxExample: "हाँ",
    demoViaTxProp: "`tx` प्रॉप के माध्यम से",
    demoViaSpecifiedTxProp: "`{{prop}}Tx` प्रॉप के माध्यम से",
  },
  demoDebugScreen: {
    howTo: "कैसे करें",
    title: "डीबग",
    tagLine: "बधाई हो, आपके पास यहां एक बहुत उन्नत React Native ऐप टेम्पलेट है। इस बॉयलरप्लेट का लाभ उठाएं!",
    reactotron: "Reactotron को भेजें",
    reportBugs: "बग्स की रिपोर्ट करें",
    demoList: "डेमो सूची",
    demoPodcastList: "डेमो पॉडकास्ट सूची",
    androidReactotronHint:
      "यदि यह काम नहीं करता है, तो सुनिश्चित करें कि Reactotron डेस्कटॉप ऐप चल रहा है, अपने टर्मिनल से adb reverse tcp:9090 tcp:9090 चलाएं, और ऐप को पुनः लोड करें।",
    iosReactotronHint:
      "यदि यह काम नहीं करता है, तो सुनिश्चित करें कि Reactotron डेस्कटॉप ऐप चल रहा है और ऐप को पुनः लोड करें।",
    macosReactotronHint:
      "यदि यह काम नहीं करता है, तो सुनिश्चित करें कि Reactotron डेस्कटॉप ऐप चल रहा है और ऐप को पुनः लोड करें।",
    webReactotronHint:
      "यदि यह काम नहीं करता है, तो सुनिश्चित करें कि Reactotron डेस्कटॉप ऐप चल रहा है और ऐप को पुनः लोड करें।",
    windowsReactotronHint:
      "यदि यह काम नहीं करता है, तो सुनिश्चित करें कि Reactotron डेस्कटॉप ऐप चल रहा है और ऐप को पुनः लोड करें।",
  },
  demoPodcastListScreen: {
    title: "React Native रेडियो एपिसोड",
    onlyFavorites: "केवल पसंदीदा दिखाएं",
    favoriteButton: "पसंदीदा",
    unfavoriteButton: "नापसंद",
    accessibility: {
      cardHint: "एपिसोड सुनने के लिए डबल टैप करें। इस एपिसोड को {{action}} करने के लिए डबल टैप करें और होल्ड करें।",
      switch: "केवल पसंदीदा दिखाने के लिए स्विच करें",
      favoriteAction: "पसंदीदा टॉगल करें",
      favoriteIcon: "एपिसोड पसंदीदा नहीं है",
      unfavoriteIcon: "एपिसोड पसंदीदा है",
      publishLabel: "{{date}} को प्रकाशित",
      durationLabel: "अवधि: {{hours}} घंटे {{minutes}} मिनट {{seconds}} सेकंड",
    },
    noFavoritesEmptyState: {
      heading: "यह थोड़ा खाली लगता है",
      content:
        "अभी तक कोई पसंदीदा नहीं जोड़ा गया है। इसे अपने पसंदीदा में जोड़ने के लिए किसी एपिसोड पर दिल पर टैप करें!",
    },
  },
  qrScan: {
    defaultTitle: "QR कोड स्कैन करें",
    defaultHint: "कैमरा QR कोड की ओर करें",
    checkingPermission: "कैमरा अनुमति जाँची जा रही है\u2026",
    permissionTitle: "कैमरा ऐक्सेस चाहिए",
    permissionBody: "QR कोड स्कैन करने के लिए कैमरा चाहिए। कैमरा केवल इस स्क्रीन के खुले रहने तक इस्तेमाल होता है।",
    grantAccess: "कैमरा ऐक्सेस दें",
    openSettings: "सेटिंग खोलें",
    permissionDeniedTitle: "अनुमति अस्वीकृत",
    permissionDeniedBody: "QR कोड स्कैन करने के लिए सेटिंग में कैमरा ऐक्सेस चालू करें।",
  },
  profileSettings: {
    ...en.profileSettings,
    workspaceName: "नाम",
    workspaceUrl: "संगठन URL",
    mentraWorkspace: "Mentra",
  },
  versionCheck: {
    ...en.versionCheck,
    managedUpdateDescription:
      "Mentra ऐप का यह संस्करण अब {{name}} द्वारा समर्थित नहीं है। अपडेट आपके संगठन के डिवाइस प्रबंधन द्वारा दिए जाते हैं। अपडेट करने के लिए अपने IT व्यवस्थापक से संपर्क करें।",
    contactSupport: "सहायता से संपर्क करें",
  },
  workspace: {
    or: "या",
    title: "संगठन साइन-इन",
    heading: "अपने संगठन से जुड़ें",
    description: "अपने IT व्यवस्थापक द्वारा दिया गया पता दर्ज करें।",
    connectAction: "अपने संगठन में साइन इन करें",
    urlLabel: "संगठन का पता",
    urlPlaceholder: "company.example.com",
    urlHelper: "उदाहरण: company.example.com",
    unknownResolutionError: "यह संगठन लोड नहीं हो सका। फिर से कोशिश करें।",
    notFoundError: "उस पते पर कोई Mentra संगठन नहीं मिला। पता जांचें या अपने IT व्यवस्थापक से पूछें।",
    configurationError: "इस संगठन की पुष्टि नहीं हो सकी। अपने IT व्यवस्थापक से इसकी कॉन्फ़िगरेशन जांचने के लिए कहें।",
    confirmTitle: "संगठन की पुष्टि करें",
    candidateExpired: "यह पुष्टि समाप्त हो गई। अपने संगठन का पता फिर से दर्ज करें।",
    enterAnotherUrl: "संगठन का पता दर्ज करें",
    connectTo: "{{name}} से जुड़ें",
    continueTo: "{{name}} पर जारी रखें",
    workspaceLabel: "संगठन",
    signInLabel: "साइन-इन",
    microsoftOrganizationAccount: "Microsoft संगठन खाता",
    mentraAccount: "Mentra खाता",
    confirmDescription:
      "जारी रखने पर यह संगठन आपका सक्रिय Mentra डिप्लॉयमेंट बन जाता है। साइन-इन से पहले ही इसकी सेवाएँ और नीतियाँ लागू होती हैं।",
    signInDescription: "इस संगठन के लिए कॉन्फ़िगर किए गए खाते से जारी रखें।",
    continueWithMicrosoft: "Microsoft के साथ जारी रखें",
    returnToMentra: "Mentra पर वापस जाएँ",
    change: "बदलें",
    noActiveWorkspace: "कोई संगठन सक्रिय नहीं है।",
    signInFailedTitle: "साइन-इन विफल",
    signInFailedDescription:
      "Microsoft आपको इस संगठन में साइन इन नहीं कर सका। फिर से कोशिश करें या अपनी IT टीम से संपर्क करें।",
  },
  miniappAge: {
    askTitle: "आपकी उम्र क्या है?",
    askMessage:
      "कुछ miniapps बड़ी उम्र के लोगों के लिए रेट किए गए हैं। हम आपका जवाब आपके Mentra खाते में रखते हैं और इसे कभी miniapps के साथ साझा नहीं करते।",
    agePlaceholder: "आपकी उम्र",
    invalidAge: "अपनी उम्र अंकों में लिखें।",
    continue: "जारी रखें",
    restrictedTitle: "{{name}} की रेटिंग {{rating}} है।",
    restrictedMessage: "यह आपकी उम्र के लिए उपलब्ध नहीं है।",
    unavailableTitle: "हम आपकी उम्र की जाँच नहीं कर सके",
    unavailableMessage: "इंटरनेट से कनेक्ट करें और फिर से कोशिश करें।",
  },
  miniappInstall: {
    fromLocalNetwork: "आपके लोकल नेटवर्क से\n{{address}}",
    install: "इंस्टॉल करें",
    from: "{{host}} से",
    nameWithRating: "{{name}} · {{rating}}",
    replaces: "यह आपके मौजूदा {{name}} की जगह लेगा।",
    opening: "miniapp खोला जा रहा है…",
    installed: "{{name}} आपकी होम स्क्रीन पर है",
    installing: "{{name}} इंस्टॉल हो रहा है…",
    failedTitle: "यह miniapp इंस्टॉल नहीं हो सका",
    notALink: "यह किसी miniapp का लिंक नहीं है।",
    notAMiniapp: "{{host}} कोई miniapp नहीं देता।",
    domainMismatch: "इस miniapp का नाम इसकी वेबसाइट से मेल नहीं खाता।",
    unavailable: "यह miniapp उपलब्ध नहीं है।",
    needsNewerApp: "{{name}} को Mentra App के नए वर्शन की ज़रूरत है।",
    needsNewerAppUnnamed: "इस miniapp को Mentra App के नए वर्शन की ज़रूरत है।",
    accessDenied: "{{host}} ने आपके Mentra खाते को यह miniapp इंस्टॉल करने नहीं दिया।",
    network: "{{host}} तक नहीं पहुँच सके। अपना कनेक्शन जाँचें और फिर से कोशिश करें।",
    integrity: "इस miniapp की फ़ाइलें इसकी वेबसाइट के विवरण से मेल नहीं खातीं। बाद में फिर से कोशिश करें।",
    signatureInvalid: "इस miniapp के हस्ताक्षर की पुष्टि नहीं हो सकी, इसलिए इसे इंस्टॉल नहीं किया गया।",
    directoryUnavailable: "Mentra Miniapp Store तक नहीं पहुँच सके। अपना कनेक्शन जाँचें और फिर से कोशिश करें।",
    failed: "कुछ गलत हो गया। फिर से कोशिश करें।",
    addTitle: "miniapp जोड़ें",
    addBody:
      "किसी miniapp को उसके QR कोड या लिंक से इंस्टॉल करें। इंस्टॉल होने से पहले आप देखेंगे कि यह कहाँ से आता है।",
    scanLabel: "QR कोड स्कैन करें",
    scanSubtitle: "किसी miniapp का QR कोड या उसका Mentra Miniapp Store कोड",
    scanTitle: "किसी miniapp का QR कोड स्कैन करें",
    scanHint: "कैमरे को miniapp के QR कोड की ओर रखें",
    pasteLabel: "URL पेस्ट करें",
    pastePlaceholder: "https://notes.example.com/",
    pasteSubtitle: "किसी miniapp का URL, या Mentra Miniapp Store से उसका लिंक",
    continue: "जारी रखें",
    homeLink: "miniapp जोड़ें",
  },
  login: {
    ...en.login,
    linkSignInTitle: "इस लिंक से साइन इन करें?",
    linkSignInMessage: "यह लिंक आपको {{email}} के रूप में साइन इन करता है। केवल तभी जारी रखें जब यह आपका खाता हो।",
    linkSignInSwitchMessage:
      "आप {{current}} के रूप में साइन इन हैं। यह लिंक आपको इसके बजाय {{email}} के रूप में साइन इन करता है। केवल तभी जारी रखें जब यह आपका खाता हो।",
    linkSignInSwitchUnknownMessage:
      "आप किसी दूसरे खाते में साइन इन हैं। यह लिंक आपको इसके बजाय {{email}} के रूप में साइन इन करता है। केवल तभी जारी रखें जब यह आपका खाता हो।",
    linkSignInContinue: "साइन इन करें",
  },
} satisfies TranslationResource

export default hi
