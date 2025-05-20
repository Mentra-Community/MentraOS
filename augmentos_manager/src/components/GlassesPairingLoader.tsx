import React, {useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Easing,
  useWindowDimensions,
} from 'react-native';
import Icon from 'react-native-vector-icons/FontAwesome';
import {getModelSpecificTips} from './GlassesTroubleshootingModal';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

interface GlassesPairingLoaderProps {
  glassesModelName: string;
  isDarkTheme: boolean;
}

const GlassesPairingLoader: React.FC<GlassesPairingLoaderProps> = ({
  glassesModelName,
  isDarkTheme,
}) => {
  const {width} = useWindowDimensions();

  // Animation values
  const glassesAnim = useRef(new Animated.Value(0)).current;
  const signalAnim = useRef(new Animated.Value(0)).current;
  const dotAnim1 = useRef(new Animated.Value(0)).current;
  const dotAnim2 = useRef(new Animated.Value(0)).current;
  const dotAnim3 = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Animation value for ping-pong motion
  const pingPongAnim = useRef(new Animated.Value(0)).current;

  const [currentTipIndex, setCurrentTipIndex] = React.useState(0);
  const progressValue = useRef(0);
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingPongDirection = useRef(1); // 1 for right, -1 for left

  let tips = getModelSpecificTips(glassesModelName);

  // Set up all animations
  useEffect(() => {
    // Glasses bobbing animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(glassesAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.sin),
        }),
        Animated.timing(glassesAnim, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.sin),
        }),
      ]),
    ).start();

    // Signal waves animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(signalAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
          easing: Easing.out(Easing.ease),
        }),
        Animated.timing(signalAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    ).start();

    // Dots typing effect
    Animated.loop(
      Animated.sequence([
        // First dot
        Animated.timing(dotAnim1, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Second dot
        Animated.timing(dotAnim2, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Third dot
        Animated.timing(dotAnim3, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Pause at full
        Animated.delay(300),
        // Reset all dots
        Animated.parallel([
          Animated.timing(dotAnim1, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(dotAnim2, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(dotAnim3, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
        ]),
        // Pause when empty
        Animated.delay(300),
      ]),
    ).start();

    // Ping-pong animation function
    const animatePingPong = () => {
      Animated.timing(pingPongAnim, {
        toValue: pingPongDirection.current,
        duration: 1200,
        useNativeDriver: true,
        easing: Easing.inOut(Easing.cubic),
      }).start(() => {
        // Flip direction and continue
        pingPongDirection.current *= -1;
        animatePingPong();
      });
    };

    // Start the ping-pong animation
    animatePingPong();

    Animated.timing(progressAnim, {
      toValue: 85,
      duration: 75000,
      useNativeDriver: false,
      easing: Easing.out(Easing.exp),
    }).start();

    // Set up fact rotator
    const rotateTips = () => {
      tipTimerRef.current = setTimeout(() => {
        setCurrentTipIndex(prevIndex => (prevIndex + 1) % tips.length);
        rotateTips();
      }, 8000); // Change tip every 8 seconds
    };

    rotateTips();

    return () => {
      if (tipTimerRef.current) {
        clearTimeout(tipTimerRef.current);
      }
    };
  }, []);

  const signalOpacity = signalAnim.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [1, 0.7, 0],
  });

  const signalScale = signalAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 2],
  });

  const dot1Opacity = dotAnim1.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  });

  const dot2Opacity = dotAnim2.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  });

  const dot3Opacity = dotAnim3.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  });

  // Width of the entire animation area
  const ANIMATION_WIDTH = 55;

  // Ping-pong animation for dot positions
  // We interpolate based on the pingPongAnim value which goes from -1 to 1

  const dot1Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [
            -ANIMATION_WIDTH * 0.9,
            ANIMATION_WIDTH * 0.35,
            ANIMATION_WIDTH * 0.9,
          ],
        }),
      },
    ],
  };

  // Dot 2 (middle dot)
  const dot2Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-ANIMATION_WIDTH * 0.9, 0, ANIMATION_WIDTH * 0.9],
        }),
      },
    ],
  };

  // Dot 3 (last dot)
  const dot3Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [
            -ANIMATION_WIDTH * 0.9,
            -ANIMATION_WIDTH * 0.35,
            ANIMATION_WIDTH * 0.9,
          ],
        }),
      },
    ],
  };

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  // Update progress bar listener
  progressAnim.addListener(({value}) => {
    progressValue.current = value;
  });

  return (
    <View
      style={[
        styles.container,
        isDarkTheme ? styles.darkContainer : styles.lightContainer,
      ]}>
      <View style={styles.animationContainer}>
        <View style={styles.signalContainer}>
          <View style={styles.phoneContainer}>
            <Icon
              name="mobile-phone"
              size={48}
              color={isDarkTheme ? '#c7d2fe' : '#4338ca'}
              style={styles.phoneIcon}
            />
          </View>

          {/* Ping-pong bouncing dots between phone and glasses */}
          <View style={styles.bouncingDotsContainer}>
            <Animated.View
              style={[
                styles.bouncingDot,
                dot1Transform,
                isDarkTheme ? styles.darkBouncingDot : styles.lightBouncingDot,
              ]}
            />
            <Animated.View
              style={[
                styles.bouncingDot,
                dot2Transform,
                isDarkTheme ? styles.darkBouncingDot : styles.lightBouncingDot,
              ]}
            />
            <Animated.View
              style={[
                styles.bouncingDot,
                dot3Transform,
                isDarkTheme ? styles.darkBouncingDot : styles.lightBouncingDot,
              ]}
            />
          </View>

          <Animated.View style={[styles.glassesContainer]}>
            <MaterialCommunityIcons
              name="glasses"
              size={48}
              color={isDarkTheme ? '#c7d2fe' : '#4338ca'}
              style={styles.glassesIcon}
            />
          </Animated.View>
        </View>
      </View>

      {/* Status text */}
      <View style={styles.statusContainer}>
        <Text
          style={[
            styles.statusText,
            isDarkTheme ? styles.darkText : styles.lightText,
          ]}>
          Pairing {glassesModelName}
        </Text>
      </View>

      {/* Progress bar */}
      <View
        style={[
          styles.progressBarContainer,
          isDarkTheme
            ? styles.darkProgressContainer
            : styles.lightProgressContainer,
        ]}>
        <Animated.View
          style={[
            styles.progressBar,
            {width: progressWidth},
            isDarkTheme ? styles.darkProgressBar : styles.lightProgressBar,
          ]}
        />
      </View>

      {/* Tips carousel */}
      <View style={styles.tipsContainer}>
        <Text
          style={[
            styles.tipText,
            isDarkTheme ? styles.darkTip : styles.lightTip,
          ]}>
          {tips[currentTipIndex]}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  darkContainer: {
    backgroundColor: '#111827',
  },
  lightContainer: {
    backgroundColor: '#f3f4f6',
  },
  animationContainer: {
    height: 200,
    flexShrink: 1,
    alignContent: 'center',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  signalContainer: {
    width: 200,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  glassesContainer: {},
  glassesIcon: {
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  phoneContainer: {},
  phoneIcon: {
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  bouncingDotsContainer: {},
  bouncingDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  darkBouncingDot: {
    backgroundColor: '#a5b4fc',
  },
  lightBouncingDot: {
    backgroundColor: '#4f46e5',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statusText: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'Montserrat-SemiBold',
  },
  dotsContainer: {
    flexDirection: 'row',
  },
  dot: {
    fontSize: 24,
    lineHeight: 20,
    marginHorizontal: 2,
  },
  darkText: {
    color: '#f9fafb',
  },
  lightText: {
    color: '#1f2937',
  },
  progressBarContainer: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    marginBottom: 40,
    overflow: 'hidden',
  },
  darkProgressContainer: {
    backgroundColor: '#374151',
  },
  lightProgressContainer: {
    backgroundColor: '#d1d5db',
  },
  progressBar: {
    height: '100%',
    borderRadius: 3,
  },
  darkProgressBar: {
    backgroundColor: '#8b5cf6',
  },
  lightProgressBar: {
    backgroundColor: '#6366f1',
  },
  tipsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 80,
    paddingHorizontal: 10,
  },
  tipText: {
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 24,
    fontFamily: 'Montserrat-Regular',
  },
  darkTip: {
    color: '#d1d5db',
  },
  lightTip: {
    color: '#4b5563',
  },
});

export default GlassesPairingLoader;
