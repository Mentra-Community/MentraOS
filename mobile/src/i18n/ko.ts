import en, {type TranslationResource} from "./en"

const ko = {
  ...en,
  common: {
    ok: "확인!",
    cancel: "취소",
    back: "뒤로",
    logOut: "로그아웃",
  },
  welcomeScreen: {
    postscript:
      "잠깐! — 지금 보시는 것은 아마도 당신의 앱의 모양새가 아닐겁니다. (디자이너분이 이렇게 건내주셨다면 모를까요. 만약에 그렇다면, 이대로 가져갑시다!) ",
    readyForLaunch: "출시 준비가 거의 끝난 나만의 앱!",
    exciting: "(오, 이거 신나는데요!)",
    letsGo: "가보자구요!",
  },
  errorScreen: {
    title: "뭔가 잘못되었습니다!",
    friendlySubtitle:
      "이 화면은 오류가 발생할 때 프로덕션에서 사용자에게 표시됩니다. 이 메시지를 커스터마이징 할 수 있고(해당 파일은 `app/i18n/ko.ts` 에 있습니다) 레이아웃도 마찬가지로 수정할 수 있습니다(`app/screens/error`). 만약 이 오류화면을 완전히 없에버리고 싶다면 `app/app.tsx` 파일에서 <ErrorBoundary> 컴포넌트를 확인하기 바랍니다.",
    reset: "초기화",
    traceTitle: "%{name} 스택에서의 오류",
  },
  emptyStateComponent: {
    generic: {
      heading: "너무 텅 비어서.. 너무 슬퍼요..",
      content: "데이터가 없습니다. 버튼을 눌러서 리프레쉬 하시거나 앱을 리로드하세요.",
      button: "다시 시도해봅시다",
    },
  },

  errors: {
    invalidEmail: "잘못된 이메일 주소 입니다.",
  },
  loginScreen: {
    logIn: "로그인",
    enterDetails:
      "일급비밀 정보를 해제하기 위해 상세 정보를 입력하세요. 무엇이 기다리고 있는지 절대 모를겁니다. 혹은 알 수 있을지도 모르겠군요. 엄청 복잡한 뭔가는 아닙니다.",
    emailFieldLabel: "이메일",
    passwordFieldLabel: "비밀번호",
    emailFieldPlaceholder: "이메일을 입력하세요",
    passwordFieldPlaceholder: "엄청 비밀스러운 암호를 입력하세요",
    tapToLogIn: "눌러서 로그인 하기!",
    hint: "힌트: 가장 좋아하는 암호와 아무런 아무 이메일 주소나 사용할 수 있어요 :)",
  },
  home: {
    hardwareIncompatible: "하드웨어 비호환",
    hardwareIncompatibleMessage: "{{app}}은(는) 연결된 안경에서 사용할 수 없는 하드웨어가 필요합니다: {{missing}}",
  },
  settings: {
    ...en.settings,
    forgetGlassesWhilePairing:
      "Bluetooth 페어링이 진행 중입니다. 먼저 시스템 페어링 대화상자를 수락하거나 닫은 후 안경 페어링 해제를 다시 시도하세요.",
  },
  pairing: {
    ...en.pairing,
    nearbyNotInPairingModeHint:
      "근처에 Mentra Live 안경이 있지만 페어링 모드가 아닙니다. 전원 버튼을 빠르게 3번 누른 뒤 다시 시도하세요.",
    notInPairingModeLabel: "페어링 모드가 아님",
    notInPairingModeAlertTitle: "페어링 모드 시작",
    notInPairingModeAlertMessage:
      "전원 버튼을 빠르게 3번 누르세요. LED가 깜빡이고 안경이 4자리 코드를 말합니다. 그런 다음 안경을 다시 선택하세요.",
    pairingCodeLabel: "코드 {{code}}",
    legacyFirmwareLabel: "레거시 펌웨어",
    livePairingModeInfo:
      "전원 버튼을 빠르게 3번 누르세요. LED가 깜빡이고 안경이 4자리 코드(0–9, A–F)를 말합니다. 여러 대가 보이면 그 코드로 확인하세요.",
    noGlassesFoundHint: "전원 버튼을 빠르게 3번 눌렀는지 확인한 뒤 다시 시도하세요.",
  },
  demoNavigator: {
    componentsTab: "컴포넌트",
    debugTab: "디버그",
    communityTab: "커뮤니티",
    podcastListTab: "팟캐스트",
  },
  demoCommunityScreen: {
    title: "커뮤니티와 함께해요",
    tagLine:
      "전문적인 React Native 엔지니어들로 구성된 Infinite Red 커뮤니티에 접속해서 함께 개발 실력을 향상시켜 보세요!",
    joinUsOnSlackTitle: "Slack 에 참여하세요",
    joinUsOnSlack:
      "전 세계 React Native 엔지니어들과 함께할 수 있는 곳이 있었으면 좋겠죠? Infinite Red Community Slack 에서 대화에 참여하세요! 우리의 성장하는 커뮤니티는 질문을 던지고, 다른 사람들로부터 배우고, 네트워크를 확장할 수 있는 안전한 공간입니다. ",
    joinSlackLink: "Slack 에 참여하기",
    makeIgniteEvenBetterTitle: "Ignite 을 향상시켜요",
    makeIgniteEvenBetter:
      "Ignite 을 더 좋게 만들 아이디어가 있나요? 기쁜 소식이네요. 우리는 항상 최고의 React Native 도구를 구축하는데 도움을 줄 수 있는 분들을 찾고 있습니다. GitHub 에서 Ignite 의 미래를 만들어 가는것에 함께해 주세요.",
    contributeToIgniteLink: "Ignite 에 기여하기",
    theLatestInReactNativeTitle: "React Native 의 최신정보",
    theLatestInReactNative: "React Native 가 제공하는 모든 최신 정보를 알려드립니다.",
    reactNativeRadioLink: "React Native 라디오",
    reactNativeNewsletterLink: "React Native 뉴스레터",
    reactNativeLiveLink: "React Native 라이브 스트리밍",
    chainReactConferenceLink: "Chain React 컨퍼런스",
    hireUsTitle: "다음 프로젝트에 Infinite Red 를 고용하세요",
    hireUs:
      "프로젝트 전체를 수행하든, 실무 교육을 통해 팀의 개발 속도에 박차를 가하든 상관없이, Infinite Red 는 React Native 프로젝트의 모든 분야의 에서 도움을 드릴 수 있습니다.",
    hireUsLink: "메세지 보내기",
  },
  demoShowroomScreen: {
    jumpStart: "프로젝트를 바로 시작할 수 있는 컴포넌트들!",
    lorem2Sentences:
      "별 하나에 추억과, 별 하나에 사랑과, 별 하나에 쓸쓸함과, 별 하나에 동경(憧憬)과, 별 하나에 시와, 별 하나에 어머니, 어머니",
    demoHeaderTxExample: "야호",
    demoViaTxProp: "`tx` Prop 을 통해",
    demoViaSpecifiedTxProp: "`{{prop}}Tx` Prop 을 통해",
  },
  demoDebugScreen: {
    howTo: "사용방법",
    title: "디버그",
    tagLine: "축하합니다. 여기 아주 고급스러운 React Native 앱 템플릿이 있습니다. 이 보일러 플레이트를 사용해보세요!",
    reactotron: "Reactotron 으로 보내기",
    reportBugs: "버그 보고하기",
    demoList: "데모 목록",
    demoPodcastList: "데모 팟캐스트 목록",
    androidReactotronHint:
      "만약에 동작하지 않는 경우, Reactotron 데스크탑 앱이 실행중인지 확인 후, 터미널에서 adb reverse tcp:9090 tcp:9090 을 실행한 다음 앱을 다시 실행해보세요.",
    iosReactotronHint: "만약에 동작하지 않는 경우, Reactotron 데스크탑 앱이 실행중인지 확인 후 앱을 다시 실행해보세요.",
    macosReactotronHint:
      "만약에 동작하지 않는 경우, Reactotron 데스크탑 앱이 실행중인지 확인 후 앱을 다시 실행해보세요.",
    webReactotronHint: "만약에 동작하지 않는 경우, Reactotron 데스크탑 앱이 실행중인지 확인 후 앱을 다시 실행해보세요.",
    windowsReactotronHint:
      "만약에 동작하지 않는 경우, Reactotron 데스크탑 앱이 실행중인지 확인 후 앱을 다시 실행해보세요.",
  },
  demoPodcastListScreen: {
    title: "React Native 라디오 에피소드",
    onlyFavorites: "즐겨찾기만 보기",
    favoriteButton: "즐겨찾기",
    unfavoriteButton: "즐겨찾기 해제",
    accessibility: {
      cardHint: "에피소드를 들으려면 두 번 탭하세요. 이 에피소드를 좋아하거나 싫어하려면 두 번 탭하고 길게 누르세요.",
      switch: "즐겨찾기를 사용하려면 스위치를 사용하세요.",
      favoriteAction: "즐겨찾기 토글",
      favoriteIcon: "좋아하는 에피소드",
      unfavoriteIcon: "즐겨찾기하지 않은 에피소드",
      publishLabel: "{{date}} 에 발행됨",
      durationLabel: "소요시간: {{hours}}시간 {{minutes}}분 {{seconds}}초",
    },
    noFavoritesEmptyState: {
      heading: "조금 텅 비어 있네요.",
      content: "즐겨찾기가 없습니다. 에피소드에 있는 하트를 눌러서 즐겨찾기에 추가하세요.",
    },
  },
  qrScan: {
    defaultTitle: "QR 코드 스캔",
    defaultHint: "카메라를 QR 코드에 맞춰 주세요",
    checkingPermission: "카메라 권한을 확인하는 중\u2026",
    permissionTitle: "카메라 접근이 필요합니다",
    permissionBody: "QR 코드를 스캔하려면 카메라가 필요합니다. 이 화면이 열려 있는 동안에만 사용합니다.",
    grantAccess: "카메라 접근 허용",
    openSettings: "설정 열기",
    permissionDeniedTitle: "권한이 거부됨",
    permissionDeniedBody: "QR 코드를 스캔하려면 설정에서 카메라 접근을 켜 주세요.",
  },
  profileSettings: {
    ...en.profileSettings,
    workspaceName: "이름",
    workspaceUrl: "워크스페이스 URL",
    mentraWorkspace: "Mentra",
  },
  versionCheck: {
    ...en.versionCheck,
    managedUpdateDescription:
      "이 버전의 Mentra 앱은 {{name}}에서 더 이상 지원되지 않습니다. 업데이트는 조직의 기기 관리 시스템을 통해 배포됩니다. 업데이트하려면 IT 관리자에게 문의하세요.",
    contactSupport: "지원팀에 문의",
  },
  workspace: {
    or: "또는",
    title: "조직 로그인",
    heading: "조직에 연결",
    description: "IT 관리자가 제공한 주소를 입력하세요.",
    connectAction: "조직에 로그인",
    urlLabel: "조직 주소",
    urlPlaceholder: "company.example.com",
    urlHelper: "예: company.example.com",
    unknownResolutionError: "이 워크스페이스를 불러올 수 없습니다. 다시 시도하세요.",
    notFoundError: "해당 주소에서 Mentra 워크스페이스를 찾을 수 없습니다. 주소를 확인하거나 IT 관리자에게 문의하세요.",
    configurationError: "이 워크스페이스를 확인할 수 없습니다. IT 관리자에게 구성 확인을 요청하세요.",
    confirmTitle: "조직 확인",
    candidateExpired: "이 확인이 만료되었습니다. 조직 주소를 다시 입력하세요.",
    enterAnotherUrl: "조직 주소 입력",
    connectTo: "{{name}}에 연결",
    continueTo: "{{name}}(으)로 계속",
    workspaceLabel: "워크스페이스",
    signInLabel: "로그인",
    microsoftOrganizationAccount: "Microsoft 조직 계정",
    mentraAccount: "Mentra 계정",
    confirmDescription: "계속하면 이 조직이 활성 Mentra 배포가 됩니다. 로그인 전에 해당 서비스와 정책이 적용됩니다.",
    signInDescription: "이 워크스페이스에 구성된 조직 계정으로 계속하세요.",
    continueWithMicrosoft: "Microsoft로 계속",
    returnToMentra: "Mentra로 돌아가기",
    change: "변경",
    noActiveWorkspace: "활성화된 조직 워크스페이스가 없습니다.",
    signInFailedTitle: "로그인 실패",
    signInFailedDescription:
      "Microsoft에서 이 워크스페이스에 로그인할 수 없습니다. 다시 시도하거나 IT 팀에 문의하세요.",
  },
} satisfies TranslationResource

export default ko
