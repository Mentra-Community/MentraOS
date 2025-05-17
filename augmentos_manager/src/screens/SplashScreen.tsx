import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NavigationProps } from '../components/types';
import { useAuth } from '../AuthContext';
import { useStatus } from '../providers/AugmentOSStatusProvider';
import { doesHaveAllPermissions } from '../logic/PermissionsUtils';
import { loadSetting } from '../logic/SettingsHelper';
import { SETTINGS_KEYS } from '../consts';
import { useRoute } from '@react-navigation/native';

interface SplashScreenProps {
  //navigation: any;
}

const SplashScreen: React.FC<SplashScreenProps> = ({ }) => {
  const navigation = useNavigation<NavigationProps>();
  const { user, loading } = useAuth();
  const { status, initializeCoreConnection } = useStatus();
  const route = useRoute();
  const redirectPath = (route.params as any)?.path;

  useEffect(() => {
    const initializeApp = async () => {

      /*
      The purpose of SplashScreen is to route the user wherever the user needs to be
      If they're not logged in => login screen
      If they're logged in, but no perms => perm screen
      If they're logged in + perms => SimulatedPucK setup
      */
      if (!user) {
        navigation.reset({
          index: 0,
          routes: [{ name: 'Login' }],
        });
        return;
      }

      // We're now skipping the Grant Permissions screen completely
      // Optional permissions will be handled via the Additional Permissions screen
      // accessed through the alert icon on the homepage

      initializeCoreConnection();

      navigation.reset({
        index: 0,
        routes: [{ name: 'ConnectingToPuck', params: { redirectPath } }],
      });
    };

    if (!loading) {
      initializeApp();
    }
  }, [navigation, user, loading, status, initializeCoreConnection]);

  return (
    <View style={styles.container}>
      {loading ? (
        <View>
          <Text style={styles.text}>Loading...</Text>
          <Text style={styles.subText}>Please wait while we authenticate</Text>
        </View>
      ) : user ? (
        <View>
          <Text style={styles.text}>Welcome Back!</Text>
          <Text style={styles.subText}>{user.email}</Text>
        </View>
      ) : (
        <View>
          <Text style={styles.text}>AugmentOS</Text>
          <Text style={styles.subText}>Please log in to continue</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  text: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  subText: {  // Add this new style
    fontSize: 16,
    marginTop: 8,
  },
});

export default SplashScreen;
