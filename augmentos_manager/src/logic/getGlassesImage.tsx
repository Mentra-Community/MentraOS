export const getGlassesImage = (glasses: string | null) => {
    switch (glasses) {
      case 'Vuzix-z100':
      case 'Vuzix Z100':
      case 'Vuzix Ultralite':
      case 'Mentra Mach1':
      case 'Mach1':
        return require('../assets/glasses/vuzix-z100-glasses.png');
      case 'Mentra Live':
      case 'mentra_live':
        return require('../assets/glasses/mentra_live.png');
      case 'inmo_air':
        return require('../assets/glasses/inmo_air.png');
      case 'tcl_rayneo_x_two':
        return require('../assets/glasses/tcl_rayneo_x_two.png');
      case 'Vuzix_shield':
        return require('../assets/glasses/vuzix_shield.png');
      case 'Even Realities G1':
      case 'evenrealities_g1':
      case 'g1':
        return require('../assets/glasses/g1.png');
      case 'virtual-wearable':
      case 'Audio Wearable':
        return require('../assets/glasses/audio_wearable.png');
      case 'Simulated Glasses':
        return require('../assets/glasses/phoneframe.png');
      default:
        return require('../assets/glasses/unknown_wearable.png');
    }
  };