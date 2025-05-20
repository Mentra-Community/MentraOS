import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Dimensions,
  Animated,
  SafeAreaView,
  Alert,
  BackHandler,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Image,
  ScrollView,
  AppState,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Icon from 'react-native-vector-icons/FontAwesome';
import GoogleIcon from '../icons/GoogleIcon';
import AppleIcon from '../icons/AppleIcon';
import { supabase } from '../supabaseClient';
import { Linking } from 'react-native';
import showAlert from '../utils/AlertUtils';

interface LoginScreenProps {
  navigation: any;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ navigation }) => {
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isFormLoading, setIsFormLoading] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [backPressCount, setBackPressCount] = useState(0);

  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const formScale = useRef(new Animated.Value(0)).current;
  const authOverlayOpacity = useRef(new Animated.Value(0)).current;

  //pswd visibility
  const [showPassword, setShowPassword] = useState(false);
  const togglePasswordVisibility = () => {
    setShowPassword(!showPassword);
  };

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  useEffect(() => {
    if (isSigningUp) {
      Animated.spring(formScale, {
        toValue: 1,
        tension: 50,
        friction: 7,
        useNativeDriver: true,
      }).start();
    } else {
      formScale.setValue(0);
    }
  }, [formScale, isSigningUp]);

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: any) => {
      console.log('App state changed to:', nextAppState);
      // If app comes back to foreground, hide the loading overlay
      if (nextAppState === 'active' && isAuthLoading) {
        console.log('App became active, hiding auth overlay');
        setIsAuthLoading(false);
        authOverlayOpacity.setValue(0);
      }
    };

    // Subscribe to app state changes
    const appStateSubscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );

    return () => {
      appStateSubscription.remove();
    };
  }, [isAuthLoading, authOverlayOpacity]);

  useEffect(() => {
    const handleDeepLink = async (event: any) => {
      console.log('Deep link URL:', event.url);
      const authParams = parseAuthParams(event.url);
      if (authParams && authParams.access_token && authParams.refresh_token) {
        try {
          // Update the Supabase session manually
          const { data, error } = await supabase.auth.setSession({
            access_token: authParams.access_token,
            refresh_token: authParams.refresh_token,
          });
          if (error) {
            console.error('Error setting session:', error);
          } else {
            console.log('Session updated:', data.session);
          }
        } catch (err) {
          console.error('Exception during setSession:', err);
        }
      }

      // Always hide the loading overlay when we get any deep link callback
      // This ensures it gets hidden even if auth was not completed
      console.log('Deep link received, hiding auth overlay');
      setIsAuthLoading(false);
      authOverlayOpacity.setValue(0);
    };

    const linkingSubscription = Linking.addEventListener('url', handleDeepLink);
    // Handle deep links that opened the app
    Linking.getInitialURL().then(url => {
      console.log('Initial URL:', url);
      if (url) {
        handleDeepLink({ url });
      }
    });

    // Add this to see if linking is working at all
    Linking.canOpenURL('com.augmentos://auth/callback').then(supported => {
      console.log('Can open URL:', supported);
    });

    return () => {
      linkingSubscription.remove();
    };
  }, [authOverlayOpacity]);

  const parseAuthParams = (url: string) => {
    const parts = url.split('#');
    if (parts.length < 2) return null;
    const paramsString = parts[1];
    const params = new URLSearchParams(paramsString);
    return {
      access_token: params.get('access_token'),
      refresh_token: params.get('refresh_token'),
      token_type: params.get('token_type'),
      expires_in: params.get('expires_in'),
      // Add any other parameters you might need
    };
  };

  const handleGoogleSignIn = async () => {
    try {
      // Start auth flow
      setIsAuthLoading(true);

      // Show the auth loading overlay
      Animated.timing(authOverlayOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();

      // Automatically hide the overlay after 5 seconds regardless of what happens
      // This is a failsafe in case the auth flow is interrupted
      setTimeout(() => {
        console.log('Auth flow failsafe timeout - hiding loading overlay');
        setIsAuthLoading(false);
        authOverlayOpacity.setValue(0);
      }, 5000);

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Must match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: 'com.augmentos://auth/callback',
        },
      });

      // 2) If there's an error, handle it
      if (error) {
        console.error('Supabase Google sign-in error:', error);
        showAlert('Authentication Error', error.message);
        setIsAuthLoading(false);
        authOverlayOpacity.setValue(0);
        return;
      }

      // 3) If we get a `url` back, we must open it ourselves in RN
      if (data?.url) {
        console.log('Opening browser with:', data.url);
        await Linking.openURL(data.url);

        // Directly hide the loading overlay when we leave the app
        // This ensures it won't be shown when user returns without completing auth
        setIsAuthLoading(false);
        authOverlayOpacity.setValue(0);
      }
    } catch (err) {
      console.error('Google sign in failed:', err);
      showAlert(
        'Authentication Error',
        'Google sign in failed. Please try again.',
      );
      setIsAuthLoading(false);
      authOverlayOpacity.setValue(0);
    }

    console.log('signInWithOAuth call finished');
  };

  const handleAppleSignIn = async () => {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'apple',
        options: {
          // Match the deep link scheme/host/path in your AndroidManifest.xml
          redirectTo: 'com.augmentos://auth/callback',
        },
      });

      // If there's an error, handle it
      if (error) {
        console.error('Supabase Apple sign-in error:', error);
        showAlert('Authentication Error', error.message);
        return;
      }

      // If we get a `url` back, we must open it ourselves in React Native
      if (data?.url) {
        console.log('Opening browser with:', data.url);
        await Linking.openURL(data.url);
      }

      // After returning from the browser, check the session
      const { data: sessionData } = await supabase.auth.getSession();
      console.log('Current session after Apple sign-in:', sessionData.session);

      // Note: The actual navigation to SplashScreen will be handled by
      // the onAuthStateChange listener you already have in place
    } catch (err) {
      console.error('Apple sign in failed:', err);
      showAlert(
        'Authentication Error',
        'Apple sign in failed. Please try again.',
      );
    }

    console.log('signInWithOAuth for Apple finished');
  };

  const handleEmailSignUp = async (email: string, password: string) => {
    setIsFormLoading(true);

    try {
      //const redirectUrl = encodeURIComponent("com.augmentos.augmentos://verify_email/");
      const redirectUrl = 'https://augmentos.org/verify-email'; // No encoding needed
      //const redirectUrl = "com.augmentos.augmentos://verify_email/";

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          //    emailRedirectTo: redirectUrl,
          emailRedirectTo: 'com.augmentos://auth/callback',
        },
      });

      if (error) {
        showAlert('Error', error.message);
      } else if (!data.session) {
        showAlert(
          'Success!',
          'Please check your inbox for email verification!',
        );
      } else {
        console.log('Sign-up successful:', data);
        navigation.replace('SplashScreen');
      }
    } catch (err) {
      console.error('Error during sign-up:', err);
      showAlert('Error', 'Something went wrong. Please try again.');
    } finally {
      setIsFormLoading(false);
    }
  };

  const handleEmailSignIn = async (email: string, password: string) => {
    setIsFormLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      showAlert('Error', error.message);
      // Handle sign-in error
    } else {
      console.log('Sign-in successful:', data);
      //navigation.replace('SplashScreen');
    }
    setIsFormLoading(false);
  };

  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (backPressCount === 0) {
          setBackPressCount(1);
          setTimeout(() => setBackPressCount(0), 2000);
          showAlert('Leaving already?', 'Press back again to exit');
          return true;
        } else {
          BackHandler.exitApp();
          return true;
        }
      },
    );

    return () => backHandler.remove();
  }, [backPressCount]);

  useEffect(() => {
    // Subscribe to auth state changes:
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('onAuthStateChange event:', event, session);
      if (session) {
        // If session is present, user is authenticated
        // Hide the auth loading overlay after a short delay
        setTimeout(() => {
          Animated.timing(authOverlayOpacity, {
            toValue: 0,
            duration: 300,
            useNativeDriver: true,
          }).start(() => {
            setIsAuthLoading(false);
            navigation.replace('SplashScreen');
          });
        }, 500); // Give a slight delay to ensure the animation is seen
      }
    });

    // Also add a focus listener to hide the loading overlay when returning to this screen
    const unsubscribe = navigation.addListener('focus', () => {
      // If we're coming back to this screen and the auth overlay is still showing, hide it
      if (isAuthLoading) {
        console.log('Screen focused, hiding auth overlay if showing');
        Animated.timing(authOverlayOpacity, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          setIsAuthLoading(false);
        });
      }
    });

    // Cleanup subscriptions on unmount
    return () => {
      subscription.unsubscribe();
      unsubscribe();
    };
  }, [navigation, authOverlayOpacity, isAuthLoading]);

  return (
    <LinearGradient colors={['#EFF6FF', '#FFFFFF']} style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}>
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}>
            <View style={styles.card}>
              {/* Auth Loading Overlay */}
              {isAuthLoading && (
                <Animated.View
                  style={[
                    styles.authLoadingOverlay,
                    { opacity: authOverlayOpacity },
                  ]}>
                  <View style={styles.authLoadingContent}>
                    {/* Logo image commented out until we have a new one */}
                    {/* <Image 
                    source={require('../assets/AOS.png')} 
                    style={styles.authLoadingLogo} 
                  /> */}
                    <View style={styles.authLoadingLogoPlaceholder} />
                    <ActivityIndicator
                      size="large"
                      color="#2196F3"
                      style={styles.authLoadingIndicator}
                    />
                    <Text style={styles.authLoadingText}>
                      Connecting to your account...
                    </Text>
                  </View>
                </Animated.View>
              )}
              <Animated.Text
                style={[styles.title, { opacity, transform: [{ translateY }] }]}>
                AugmentOS
              </Animated.Text>
              <Animated.Text
                style={[styles.subtitle, { opacity, transform: [{ translateY }] }]}>
                The future of smart glasses starts here.
              </Animated.Text>
              {/* <Animated.View
            style={[styles.header, { opacity, transform: [{ translateY }] }]}>
            <Animated.Image
              source={require('../assets/AOS.png')}
              style={[styles.image, { opacity, transform: [{ translateY }] }]}
            />
          </Animated.View> */}

              <Animated.View
                style={[styles.content, { opacity, transform: [{ translateY }] }]}>
                {isSigningUp ? (
                  <Animated.View
                    style={[styles.form, { transform: [{ scale: formScale }] }]}>
                    <View style={styles.inputGroup}>
                      <Text style={styles.inputLabel}>Email</Text>
                      <View style={styles.enhancedInputContainer}>
                        <Icon
                          name="envelope"
                          size={16}
                          color="#6B7280"
                          style={styles.inputIcon}
                        />
                        <TextInput
                          hitSlop={{ top: 16, bottom: 16 }}
                          style={styles.enhancedInput}
                          placeholder="you@example.com"
                          value={email}
                          onChangeText={setEmail}
                          keyboardType="email-address"
                          autoCapitalize="none"
                          autoCorrect={false}
                          placeholderTextColor="#9CA3AF"
                        />
                      </View>
                    </View>

                    <View style={styles.inputGroup}>
                      <Text style={styles.inputLabel}>Password</Text>
                      <View style={styles.enhancedInputContainer}>
                        <Icon
                          name="lock"
                          size={16}
                          color="#6B7280"
                          style={styles.inputIcon}
                        />
                        <TextInput
                          hitSlop={{ top: 16, bottom: 16 }}
                          style={styles.enhancedInput}
                          placeholder="Enter your password"
                          value={password}
                          autoCapitalize="none"
                          onChangeText={setPassword}
                          secureTextEntry={!showPassword}
                          placeholderTextColor="#9CA3AF"
                        />
                        <TouchableOpacity hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }} onPress={togglePasswordVisibility}>
                          <Icon
                            name={showPassword ? 'eye' : 'eye-slash'}
                            size={18}
                            color="#6B7280"
                          />
                        </TouchableOpacity>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.enhancedPrimaryButton}
                      onPress={() => {
                        handleEmailSignIn(email, password);
                      }}
                      disabled={isFormLoading}>
                      <LinearGradient
                        colors={['#2196F3', '#1E88E5']}
                        style={styles.buttonGradient}>
                        <Text style={styles.enhancedPrimaryButtonText}>
                          Log in
                        </Text>
                      </LinearGradient>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.enhancedPrimaryButton}
                      onPress={() => {
                        handleEmailSignUp(email, password);
                      }}
                      disabled={isFormLoading}>
                      <LinearGradient
                        colors={['#2196F3', '#1E88E5']}
                        style={styles.buttonGradient}>
                        <Text style={styles.enhancedPrimaryButtonText}>
                          Create Account
                        </Text>
                      </LinearGradient>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.enhancedGhostButton}
                      onPress={() => setIsSigningUp(false)}>
                      <Icon
                        name="arrow-left"
                        size={16}
                        color="#6B7280"
                        style={styles.backIcon}
                      />
                      <Text style={styles.enhancedGhostButtonText}>
                        Back to Sign In Options
                      </Text>
                    </TouchableOpacity>
                  </Animated.View>
                ) : (
                  <View style={styles.signInOptions}>
                    <TouchableOpacity
                      style={[styles.socialButton, styles.googleButton]}
                      onPress={handleGoogleSignIn}>
                      <View style={styles.socialIconContainer}>
                        <GoogleIcon />
                      </View>
                      <Text style={styles.socialButtonText}>
                        Continue with Google
                      </Text>
                    </TouchableOpacity>

                    {Platform.OS == 'ios' && (
                      <TouchableOpacity
                        style={[styles.socialButton, styles.appleButton]}
                        onPress={handleAppleSignIn}>
                        <View style={styles.socialIconContainer}>
                          <AppleIcon />
                        </View>
                        <Text
                          style={[styles.socialButtonText, styles.appleButtonText]}>
                          Continue with Apple
                        </Text>
                      </TouchableOpacity>
                    )}

                    <View style={styles.dividerContainer}>
                      <View style={styles.divider} />
                      <Text style={styles.dividerText}>Or</Text>
                      <View style={styles.divider} />
                    </View>

                    <TouchableOpacity
                      style={styles.enhancedEmailButton}
                      onPress={() => setIsSigningUp(true)}>
                      <LinearGradient
                        colors={['#2196F3', '#1E88E5']}
                        style={styles.buttonGradient}>
                        <Icon
                          name="envelope"
                          size={16}
                          color="white"
                          style={styles.emailIcon}
                        />
                        <Text style={styles.enhancedEmailButtonText}>
                          Sign up with Email
                        </Text>
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                )}
              </Animated.View>

              <Animated.Text style={[styles.termsText, { opacity }]}>
                By continuing, you agree to our Terms of Service and Privacy
                Policy
              </Animated.Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
};

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  card: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  authLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    zIndex: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  authLoadingContent: {
    alignItems: 'center',
    padding: 20,
  },
  authLoadingLogo: {
    width: 100,
    height: 100,
    resizeMode: 'contain',
    marginBottom: 20,
  },
  authLoadingLogoPlaceholder: {
    width: 100,
    height: 100,
    marginBottom: 20,
  },
  authLoadingIndicator: {
    marginBottom: 16,
  },
  authLoadingText: {
    fontSize: 16,
    fontFamily: 'Montserrat-Medium',
    color: '#333',
    textAlign: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  image: {
    width: width * 0.4,
    height: width * 0.4,
    resizeMode: 'contain',
    marginBottom: 20,
  },
  title: {
    fontSize: 46,
    fontWeight: 'bold',
    color: '#000',
    textAlign: 'center',
    marginBottom: 8,
    fontFamily: 'Montserrat-Bold',
  },
  subtitle: {
    fontSize: 16,
    color: '#000',
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: 'Montserrat-Regular',
  },
  content: {
    marginBottom: 20,
  },
  formTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000',
    textAlign: 'center',
    marginBottom: 8,
    fontFamily: 'Montserrat-Bold',
  },
  formSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: 'Montserrat-Regular',
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
    fontFamily: 'Montserrat-Medium',
  },
  form: {
    width: '100%',
  },
  enhancedInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 16,
    backgroundColor: 'white',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  inputIcon: {
    marginRight: 12,
  },
  enhancedInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Montserrat-Regular',
    color: '#111827',
  },
  signInOptions: {
    gap: 8,
  },
  socialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 1,
    elevation: 1,
  },
  googleButton: {
    backgroundColor: 'white',
  },
  appleButton: {
    backgroundColor: 'black',
    borderColor: 'black',
  },
  socialIconContainer: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  socialButtonText: {
    fontSize: 15,
    color: '#000',
    flex: 1,
    textAlign: 'center',
    fontFamily: 'Montserrat-Regular',
  },
  appleButtonText: {
    color: 'white',
  },
  buttonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 44, // Add this line
    paddingHorizontal: 16, // Change from padding to paddingHorizontal
    borderRadius: 8,
  },
  enhancedPrimaryButton: {
    marginTop: 8,
    borderRadius: 8,
    overflow: 'hidden',
    shadowColor: '#2196F3',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  enhancedEmailButton: {
    borderRadius: 8,
    overflow: 'hidden',
    shadowColor: '#2196F3',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  enhancedPrimaryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  enhancedEmailButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  enhancedGhostButton: {
    flexDirection: 'row',
    height: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  backIcon: {
    marginRight: 8,
  },
  emailIcon: {
    marginRight: 8,
  },
  enhancedGhostButtonText: {
    color: '#6B7280',
    fontSize: 15,
    fontFamily: 'Montserrat-Medium',
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: '#E5E7EB',
  },
  dividerText: {
    paddingHorizontal: 16,
    color: '#6B7280',
    fontSize: 12,
    textTransform: 'uppercase',
    fontFamily: 'Montserrat-Regular',
  },
  termsText: {
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
    fontFamily: 'Montserrat-Regular',
    marginTop: 8,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
});

export default LoginScreen;
