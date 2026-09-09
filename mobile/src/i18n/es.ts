import en, {type TranslationResource} from "./en"

const es = {
  ...en,
  common: {
    ok: "OK",
    cancel: "Cancelar",
    back: "Volver",
    logOut: "Cerrar sesión",
  },
  welcomeScreen: {
    postscript:
      "psst — Esto probablemente no es cómo se va a ver tu app. (A menos que tu diseñador te haya enviado estas pantallas, y en ese caso, ¡lánzalas en producción!)",
    readyForLaunch: "Tu app, casi lista para su lanzamiento",
    exciting: "(¡ohh, esto es emocionante!)",
    letsGo: "¡Vamos!",
  },
  errorScreen: {
    title: "¡Algo salió mal!",
    friendlySubtitle:
      "Esta es la pantalla que verán tus usuarios en producción cuando haya un error. Vas a querer personalizar este mensaje (que está ubicado en `app/i18n/es.ts`) y probablemente también su diseño (`app/screens/ErrorScreen`). Si quieres eliminarlo completamente, revisa `app/app.tsx` y el componente <ErrorBoundary>.",
    reset: "REINICIA LA APP",
    traceTitle: "Error desde %{name}",
  },
  emptyStateComponent: {
    generic: {
      heading: "Muy vacío... muy triste",
      content:
        "No se han encontrado datos por el momento. Intenta darle clic en el botón para refrescar o recargar la app.",
      button: "Intentemos de nuevo",
    },
  },

  errors: {
    invalidEmail: "Email inválido.",
  },
  loginScreen: {
    logIn: "Iniciar sesión",
    enterDetails:
      "Ingresa tus datos a continuación para desbloquear información ultra secreta. Nunca vas a adivinar lo que te espera al otro lado. O quizás si lo harás; la verdad no hay mucha ciencia alrededor.",
    emailFieldLabel: "Email",
    passwordFieldLabel: "Contraseña",
    emailFieldPlaceholder: "Ingresa tu email",
    passwordFieldPlaceholder: "Contraseña super secreta aquí",
    tapToLogIn: "¡Presiona acá para iniciar sesión!",
    hint: "Consejo: puedes usar cualquier email y tu contraseña preferida :)",
  },
  home: {
    hardwareIncompatible: "Hardware Incompatible",
    hardwareIncompatibleMessage:
      "{{app}} requiere hardware que no está disponible en tus lentes conectados: {{missing}}",
  },
  settings: {
    ...en.settings,
    forgetGlassesWhilePairing:
      "El emparejamiento Bluetooth está en curso. Acepta o cierra primero el diálogo de emparejamiento del sistema y luego intenta desvincular las gafas de nuevo.",
  },
  pairing: {
    ...en.pairing,
    nearbyNotInPairingModeHint:
      "Se encontraron gafas Mentra Live cerca, pero no están en modo de emparejamiento. Pulsa el botón de encendido 3 veces rápido y vuelve a intentarlo.",
    notInPairingModeLabel: "No está en modo de emparejamiento",
    notInPairingModeAlertTitle: "Activa el modo de emparejamiento",
    notInPairingModeAlertMessage:
      "Pulsa el botón de encendido 3 veces rápido. El LED parpadea y las gafas dicen un código de 4 caracteres. Luego selecciona las gafas de nuevo.",
    pairingCodeLabel: "Código {{code}}",
    legacyFirmwareLabel: "Firmware heredado",
    livePairingModeInfo:
      "Pulsa el botón de encendido 3 veces rápido. El LED parpadea y las gafas dicen un código de 4 caracteres (0–9, A–F). Compara ese código en la lista si aparece más de una unidad.",
    noGlassesFoundHint: "Asegúrate de pulsar el botón de encendido 3 veces rápido y vuelve a intentarlo.",
  },
  demoNavigator: {
    componentsTab: "Componentes",
    debugTab: "Debug",
    communityTab: "Comunidad",
    podcastListTab: "Podcasts",
  },
  demoCommunityScreen: {
    title: "Conecta con la comunidad",
    tagLine:
      "Únete a la comunidad React Native con los ingenieros de Infinite Red y mejora con nosotros tus habilidades para el desarrollo de apps.",
    joinUsOnSlackTitle: "Únete a nosotros en Slack",
    joinUsOnSlack:
      "¿Quieres conectar con desarrolladores de React Native de todo el mundo? Únete a la conversación en nuestra comunidad de Slack. Nuestra comunidad, que crece día a día, es un espacio seguro para hacer preguntas, aprender de los demás y ampliar tu red.",
    joinSlackLink: "Únete a la comunidad de Slack",
    makeIgniteEvenBetterTitle: "Haz que Ignite sea aún mejor",
    makeIgniteEvenBetter:
      "¿Tienes una idea para hacer que Ignite sea aún mejor? ¡Nos encantaría escucharla! Estamos siempre buscando personas que quieran ayudarnos a construir las mejores herramientas para React Native. Únete a nosotros en GitHub para ayudarnos a construir el futuro de Ignite.",
    contributeToIgniteLink: "Contribuir a Ignite",
    theLatestInReactNativeTitle: "Lo último en el mundo de React Native",
    theLatestInReactNative: "Estamos aquí para mantenerte al día con todo lo que React Native tiene para ofrecer.",
    reactNativeRadioLink: "React Native Radio",
    reactNativeNewsletterLink: "Newsletter de React Native",
    reactNativeLiveLink: "React Native Live",
    chainReactConferenceLink: "Conferencia Chain React",
    hireUsTitle: "Trabaja con Infinite Red en tu próximo proyecto",
    hireUs:
      "Ya sea para gestionar un proyecto de inicio a fin o educación a equipos a través de nuestros cursos y capacitación práctica, Infinite Red puede ayudarte en casi cualquier proyecto de React Native.",
    hireUsLink: "Envíanos un mensaje",
  },
  demoShowroomScreen: {
    jumpStart: "Componentes para comenzar tu proyecto",
    lorem2Sentences:
      "Nulla cupidatat deserunt amet quis aliquip nostrud do adipisicing. Adipisicing excepteur elit laborum Lorem adipisicing do duis.",
    demoHeaderTxExample: "Yay",
    demoViaTxProp: "A través de el atributo `tx`",
    demoViaSpecifiedTxProp: "A través de el atributo específico `{{prop}}Tx`",
  },
  demoDebugScreen: {
    howTo: "CÓMO HACERLO",
    title: "Debug",
    tagLine:
      "Felicidades, aquí tienes una propuesta de arquitectura y base de código avanzada para una app en React Native. ¡Disfrutalos!",
    reactotron: "Enviar a Reactotron",
    reportBugs: "Reportar errores",
    demoList: "Lista demo",
    demoPodcastList: "Lista demo de podcasts",
    androidReactotronHint:
      "Si esto no funciona, asegúrate de que la app de escritorio de Reactotron se esté ejecutando, corre adb reverse tcp:9090 tcp:9090 desde tu terminal, y luego recarga la app.",
    iosReactotronHint:
      "Si esto no funciona, asegúrate de que la app de escritorio de Reactotron se esté ejecutando, y luego recarga la app.",
    macosReactotronHint:
      "Si esto no funciona, asegúrate de que la app de escritorio de Reactotron se esté ejecutando, y luego recarga la app.",
    webReactotronHint:
      "Si esto no funciona, asegúrate de que la app de escritorio de Reactotron se esté ejecutando, y luego recarga la app.",
    windowsReactotronHint:
      "Si esto no funciona, asegúrate de que la app de escritorio de Reactotron se esté ejecutando, y luego recarga la app.",
  },
  demoPodcastListScreen: {
    title: "Episodios de React Native Radio",
    onlyFavorites: "Mostrar solo favoritos",
    favoriteButton: "Favorito",
    unfavoriteButton: "No favorito",
    accessibility: {
      cardHint:
        "Haz doble clic para escuchar el episodio. Haz doble clic y mantén presionado para {{action}} este episodio.",
      switch: "Activa para mostrar solo favoritos",
      favoriteAction: "Cambiar a favorito",
      favoriteIcon: "Episodio no favorito",
      unfavoriteIcon: "Episodio favorito",
      publishLabel: "Publicado el {{date}}",
      durationLabel: "Duración: {{hours}} horas {{minutes}} minutos {{seconds}} segundos",
    },
    noFavoritesEmptyState: {
      heading: "Esto está un poco vacío",
      content:
        "No se han agregado episodios favoritos todavía. ¡Presiona el corazón dentro de un episodio para agregarlo a tus favoritos!",
    },
  },
  qrScan: {
    defaultTitle: "Escanear código QR",
    defaultHint: "Apunta la cámara a un código QR",
    checkingPermission: "Comprobando permiso de cámara\u2026",
    permissionTitle: "Se necesita acceso a la cámara",
    permissionBody: "Necesitamos tu cámara para escanear códigos QR. Solo se usa mientras esta pantalla está abierta.",
    grantAccess: "Permitir acceso a la cámara",
    openSettings: "Abrir ajustes",
    permissionDeniedTitle: "Permiso denegado",
    permissionDeniedBody: "Activa el acceso a la cámara en Ajustes para escanear códigos QR.",
  },
  profileSettings: {
    ...en.profileSettings,
    workspaceName: "Nombre",
    workspaceUrl: "URL del espacio de trabajo",
    mentraWorkspace: "Mentra",
  },
  versionCheck: {
    ...en.versionCheck,
    managedUpdateDescription:
      "Esta versión de la app Mentra ya no es compatible con {{name}}. Las actualizaciones las distribuye la gestión de dispositivos de tu organización. Contacta con tu administrador de TI para actualizar.",
    contactSupport: "Contactar con soporte",
  },
  workspace: {
    or: "o",
    title: "Inicio de sesión de la organización",
    heading: "Conéctate a tu organización",
    description: "Introduce la dirección que te dio tu administrador de TI.",
    connectAction: "Inicia sesión en tu organización",
    urlLabel: "Dirección de la organización",
    urlPlaceholder: "empresa.ejemplo.com",
    urlHelper: "Ejemplo: empresa.ejemplo.com",
    unknownResolutionError: "No pudimos cargar este espacio de trabajo. Inténtalo de nuevo.",
    notFoundError:
      "No encontramos un espacio de trabajo de Mentra en esa dirección. Revisa la dirección o consulta a tu administrador de TI.",
    configurationError:
      "No se pudo verificar este espacio de trabajo. Pide a tu administrador de TI que revise su configuración.",
    confirmTitle: "Confirmar organización",
    candidateExpired: "Esta confirmación caducó. Vuelve a introducir la dirección de tu organización.",
    enterAnotherUrl: "Introducir dirección de la organización",
    connectTo: "Conectar con {{name}}",
    continueTo: "Continuar con {{name}}",
    workspaceLabel: "Espacio de trabajo",
    signInLabel: "Inicio de sesión",
    microsoftOrganizationAccount: "Cuenta de organización de Microsoft",
    mentraAccount: "Cuenta de Mentra",
    confirmDescription:
      "Al continuar, esta organización se convierte en tu despliegue activo de Mentra. Sus servicios y políticas se aplican antes de iniciar sesión.",
    signInDescription: "Continúa con la cuenta de la organización configurada para este espacio de trabajo.",
    continueWithMicrosoft: "Continuar con Microsoft",
    returnToMentra: "Volver a Mentra",
    change: "Cambiar",
    noActiveWorkspace: "No hay ningún espacio de trabajo de organización activo.",
    signInFailedTitle: "Error al iniciar sesión",
    signInFailedDescription:
      "Microsoft no pudo iniciar tu sesión en este espacio de trabajo. Inténtalo de nuevo o contacta con tu equipo de TI.",
  },
} satisfies TranslationResource

export default es
