import React from 'react';
import {View, StyleSheet, TouchableOpacity, Platform} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {NavigationProps, RootStackParamList} from '../components/types';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

interface NavigationBarProps {
  toggleTheme?: () => void;
  isDarkTheme?: boolean;
  // Add variant prop to switch between different icon sets
  variant?: 'v1' | 'v2' | 'v3' | 'v4';
}

const NavigationBar: React.FC<NavigationBarProps> = React.memo(({
  isDarkTheme = false,
  variant = 'v1',
}) => {
  const navigation = useNavigation<NavigationProps>();
  const insets = useSafeAreaInsets();
  const iconColor = isDarkTheme ? '#FFFFFF' : '#000000';
  const backgroundColor = isDarkTheme ? '#000000' : '#F2F2F7';
  const disabledColor = isDarkTheme ? '#666666' : '#CCCCCC';
  const iconSize = 24;

  // Different icon sets
  const iconSets = {
    v1: {
      home: 'home-variant-outline',
      mirror: 'glasses',
      apps: 'grid',
      settings: 'cog-outline',
    },
    v2: {
      home: 'home-minus-outline',
      mirror: 'glasses',
      apps: 'apps',
      settings: 'settings-helper',
    },
    v3: {
      home: 'home-outline',
      mirror: 'glasses',
      apps: 'view-grid-outline',
      settings: 'tune-variant',
    },
    v4: {
      home: 'home-modern',
      mirror: 'glasses',
      apps: 'grid-large',
      settings: 'dots-horizontal',
    },
  };

  // Get current icon set
  const icons = iconSets[variant];

  // Handle iOS safe area insets for the navigation bar
  const isIOS = Platform.OS === 'ios';
  
  return (
    <View style={styles.container}>
      <View style={[
        styles.navBarContainer, 
        {backgroundColor}
      ]}>
        {/* Home Icon */}
        <TouchableOpacity
          onPress={() => navigation.navigate({name: 'Home', params: undefined})}
          style={styles.iconWrapper}>
          <MaterialCommunityIcons
            name={icons.home}
            size={iconSize}
            color={iconColor}
          />
        </TouchableOpacity>

        {/* Glasses Mirror Icon */}
        <TouchableOpacity
          onPress={() => navigation.navigate({name: 'GlassesMirror', params: undefined})}
          style={styles.iconWrapper}>
          <MaterialCommunityIcons
            name={icons.mirror}
            size={iconSize}
            color={iconColor}
          />
        </TouchableOpacity>

        {/* App Store Icon */}
        <TouchableOpacity
          onPress={() => navigation.navigate({name: 'AppStoreWeb', params: {packageName: undefined}})}
          style={styles.iconWrapper}>
          <MaterialCommunityIcons
            name={icons.apps}
            size={iconSize}
            color={iconColor}
          />
        </TouchableOpacity>

        {/* Settings Icon */}
        <TouchableOpacity
          onPress={() => navigation.navigate({name: 'SettingsPage', params: undefined})}
          style={styles.iconWrapper}>
          <MaterialCommunityIcons
            name={icons.settings}
            size={iconSize}
            color={iconColor}
          />
        </TouchableOpacity>
      </View>
      {/* Bottom padding for iOS home indicator */}
      {Platform.OS === 'ios' && <View style={[styles.bottomPadding, {backgroundColor}]} />}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: 'transparent',
    marginTop: 0,
    paddingTop: 0,
  },
  navBarContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    width: '100%',
    padding: 0,
    margin: 0,
    height: Platform.OS === 'ios' ? 50 : 64, // Slightly shorter on iOS
    borderTopWidth: 0.5,
    borderTopColor: '#E5E5EA',
  },
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
  },
  bottomPadding: {
    height: 34, // Height for iOS home indicator area
    width: '100%',
  },
});

export default NavigationBar;
