import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Alert, AppState } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { checkNotificationAccessSpecialPermission } from '../utils/NotificationServiceUtils';
import { checkFeaturePermissions, PermissionFeatures } from '../logic/PermissionsUtils';
import { showAlert } from '../utils/AlertUtils';
import { useRoute } from '@react-navigation/native';

interface HeaderProps {
  isDarkTheme: boolean;
  navigation: any;
}

const Header: React.FC<HeaderProps> = ({ isDarkTheme, navigation }) => {
  const [isDropdownVisible, setDropdownVisible] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(true);
  const [hasNotificationListenerPermission, setHasNotificationListenerPermission] = useState(true);
  const [hasCalendarPermission, setHasCalendarPermission] = useState(true);
  const [appState, setAppState] = useState(AppState.currentState);
  const route = useRoute();

  // Check permissions when component mounts
  // and when app comes back to foreground
  useEffect(() => {
    const checkPermissions = async () => {
      // Check notification permission
      if (Platform.OS === 'android') {
        const hasNotificationPermission = await checkNotificationAccessSpecialPermission();
        setHasNotificationListenerPermission(hasNotificationPermission);
      } else {
        // const hasNotificationPermission = await checkFeaturePermissions(PermissionFeatures.NOTIFICATIONS);
        // setHasNotificationListenerPermission(hasNotificationPermission);
        // TODO: ios (there's no way to get the notification permission on ios so just set to true to disable the warning)
        setHasNotificationListenerPermission(true);
      }
      
      // Check calendar permission
      const hasCalPermission = await checkFeaturePermissions(PermissionFeatures.CALENDAR);
      setHasCalendarPermission(hasCalPermission);
    };

    // Check permissions on component mount
    checkPermissions();
    
    // Set up AppState listener to check permissions when app comes back to foreground
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (appState.match(/inactive|background/) && nextAppState === 'active') {
        // App has come to the foreground
        console.log('App has come to foreground, checking permissions');
        checkPermissions();
      }
      setAppState(nextAppState);
    });

    // Clean up subscription
    return () => {
      subscription.remove();
    };
  }, [appState, route.name]);

  const handleLogout = () => {
    setIsLoggedIn(false);
    setDropdownVisible(false);
    if (navigation) {
      navigation.navigate('Intro');
    } else {
      console.error('Navigation prop is undefined');
    }
  };

  const handleProfileSettings = () => {
    if (navigation) {
      navigation.navigate('ProfileSettings');
    } else {
      console.error('Navigation prop is undefined');
    }
  };

  const handleNotificationAlert = () => {
    // Show explanation alert before navigating to privacy settings
    showAlert(
      'Additional Features Available',
      'Enhance your AugmentOS experience by enabling additional permissions.',
      [
        {
          text: 'Go to Settings',
          onPress: () => {
            // Navigate to PrivacySettingsScreen after explaining
            if (navigation) {
              navigation.navigate('PrivacySettingsScreen');
            } else {
              console.error('Navigation prop is undefined');
            }
          }
        }
      ],
      {
        iconName: 'information-outline',
        iconColor: '#007AFF'
      }
    );
  };

  const textColor = isDarkTheme ? '#FFFFFF' : '#000000';
  const dropdownBackgroundColor = isDarkTheme ? '#333333' : '#FFFFFF';
  const shadowColor = isDarkTheme ? '#FFFFFF' : '#000000';

  return (
    <View style={styles.headerContainer}>
      <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
        AugmentOS
      </Text>
      
      {(!hasNotificationListenerPermission || !hasCalendarPermission) && (
        <TouchableOpacity
          style={styles.alertIconContainer}
          onPress={handleNotificationAlert}
        >
          <Icon 
            name="notifications-off" 
            size={24} 
            color="#FF3B30" 
          />
          <View style={styles.alertDot} />
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginLeft: 8,
    zIndex: 1,
    minHeight: 60,
    ...Platform.select({
      ios: {
        paddingTop: 16,
      },
      android: {
        paddingTop: 16,
      },
    }),
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  dropdown: {
    position: 'absolute',
    top: 70,
    right: 16,
    borderRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
    padding: 8,
    zIndex: 2,
  },
  dropdownItem: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  dropdownItemText: {
    fontSize: 16,
    fontFamily: 'Montserrat-Regular',
  },
  alertIconContainer: {
    position: 'relative',
    padding: 8,
  },
  alertDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF3B30',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
});

export default Header;
