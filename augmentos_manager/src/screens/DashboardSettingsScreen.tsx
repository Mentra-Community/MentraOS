import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  Platform,
  ScrollView,
  Alert,
  Modal,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/FontAwesome';

import { useStatus } from '../providers/AugmentOSStatusProvider.tsx';
import coreCommunicator from '../bridge/CoreCommunicator';
import HeadUpAngleComponent from '../components/HeadUpAngleComponent.tsx';
import BackendServerComms from '../backend_comms/BackendServerComms';
import { Slider } from 'react-native-elements';

interface DashboardSettingsScreenProps {
  navigation: any;
  isDarkTheme: boolean;
  toggleTheme: () => void;
}

const DashboardSettingsScreen: React.FC<DashboardSettingsScreenProps> = ({
  navigation,
  isDarkTheme,
  toggleTheme,
}) => {
  const { status } = useStatus();
  const backendServerComms = BackendServerComms.getInstance();

  // -- States --
  const [isContextualDashboardEnabled, setIsContextualDashboardEnabled] = useState(
    status.core_info.contextual_dashboard_enabled
  );
  const [headUpAngleComponentVisible, setHeadUpAngleComponentVisible] = useState(false);
  const [headUpAngle, setHeadUpAngle] = useState<number | null>(null);
  const [dashboardContent, setDashboardContent] = useState('');
  const [showContentPicker, setShowContentPicker] = useState(false);
  const [serverSettings, setServerSettings] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [dashboardHeight, setDashboardHeight] = useState<number | null>(null);
  const [isMetricSystemEnabled, setIsMetricSystemEnabled] = useState(status.core_info.metric_system_enabled);
  const [depth, setDepth] = useState<number | null>(null);

  const dashboardContentOptions = [
    { label: 'None', value: 'none' },
    { label: 'Fun Facts', value: 'fun_facts' },
    { label: 'Famous Quotes', value: 'famous_quotes' },
    // { label: "Trash Talk", value: "trash_talk" },
    { label: 'Chinese Words', value: 'chinese_words' },
    { label: 'Gratitude Ping', value: 'gratitude_ping' }
  ];

  // -- Handlers --
  const toggleContextualDashboard = async () => {
    const newVal = !isContextualDashboardEnabled;
    await coreCommunicator.sendToggleContextualDashboard(newVal);
    setIsContextualDashboardEnabled(newVal);
  };

  const toggleMetricSystem = async () => {
    const newVal = !isMetricSystemEnabled;
    try {
      await coreCommunicator.sendSetMetricSystemEnabled(newVal);
      setIsMetricSystemEnabled(newVal);
    } catch (error) {
      console.error('Error toggling metric system:', error);
    }
  };

  const onSaveHeadUpAngle = async (newHeadUpAngle: number) => {
    if (!status.glasses_info) {
      Alert.alert('Glasses not connected', 'Please connect your smart glasses first.');
      return;
    }
    if (newHeadUpAngle == null) {
      return;
    }

    setHeadUpAngleComponentVisible(false);
    await coreCommunicator.setGlassesHeadUpAngle(newHeadUpAngle);
    setHeadUpAngle(newHeadUpAngle);
  };

  const onCancelHeadUpAngle = () => {
    setHeadUpAngleComponentVisible(false);
  };

  // -- Effects --
  // useEffect(() => {
  //   fetchDashboardSettings();
  // }, []);

  // const fetchDashboardSettings = async () => {
  //   try {
  //     setIsLoading(true);
  //     const data = await backendServerComms.getTpaSettings('com.augmentos.dashboard');
  //     setServerSettings(data);
  //     const contentSetting = data.settings?.find((setting: any) => setting.key === 'dashboard_content');
  //     if (contentSetting) {
  //       setDashboardContent(contentSetting.selected);
  //     }
  //   } catch (error) {
  //     console.error('Error fetching dashboard settings:', error);
  //   } finally {
  //     setIsLoading(false);
  //   }
  // };

  // const handleDashboardContentChange = async (value: string) => {
  //   try {
  //     setIsUpdating(true);
  //     setDashboardContent(value);
  //     await backendServerComms.updateTpaSetting('com.augmentos.dashboard', {
  //       key: 'dashboard_content',
  //       value: value
  //     });
  //   } catch (error) {
  //     console.error('Error updating dashboard content:', error);
  //     Alert.alert('Error', 'Failed to update dashboard content');
  //     setDashboardContent(dashboardContent);
  //   } finally {
  //     setIsUpdating(false);
  //     setShowContentPicker(false);
  //   }
  // };

  useEffect(() => {
    if (status.glasses_settings.head_up_angle != null) {
      setHeadUpAngle(status.glasses_settings.head_up_angle);
    }
  }, [status.glasses_settings.head_up_angle]);

  // Update isMetricSystemEnabled when status changes
  useEffect(() => {
    setIsMetricSystemEnabled(status.core_info.metric_system_enabled);
  }, [status.core_info.metric_system_enabled]);

  // Update isContextualDashboardEnabled when status changes
  useEffect(() => {
    setIsContextualDashboardEnabled(status.core_info.contextual_dashboard_enabled);
  }, [status.core_info.contextual_dashboard_enabled]);

  // Switch track colors
  const switchColors = {
    trackColor: {
      false: '#D1D1D6',
      true: '#2196F3',
    },
    thumbColor: Platform.OS === 'ios' ? undefined : '#FFFFFF',
    ios_backgroundColor: '#D1D1D6',
  };

  // ContentPicker Modal
  const renderContentPicker = () => (
    <Modal
      visible={showContentPicker}
      transparent={true}
      animationType="fade"
      onRequestClose={() => !isUpdating && setShowContentPicker(false)}
    >
      <View style={[styles.modalOverlay]}>
        <View style={[styles.pickerContainer]}>
          <View style={styles.pickerHeader}>
            <Text style={styles.pickerTitle}>
              Select Dashboard Content
            </Text>
            <TouchableOpacity 
              onPress={() => !isUpdating && setShowContentPicker(false)}
              style={[styles.closeButton, isUpdating && styles.disabledButton]}
              disabled={isUpdating}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
          {/* <ScrollView style={styles.pickerOptionsContainer}>
            {dashboardContentOptions.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[
                  styles.pickerOption,
                  dashboardContent === option.value && styles.selectedOption,
                  isUpdating && styles.disabledItem
                ]}
                onPress={() => !isUpdating && handleDashboardContentChange(option.value)}
                disabled={isUpdating}
              >
                <View style={styles.optionContent}>
                  <Text style={[
                    styles.pickerOptionText,
                    dashboardContent === option.value && styles.selectedOptionText
                  ]}>
                    {option.label}
                  </Text>
                  {dashboardContent === option.value && (
                    isUpdating ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Icon name="check" size={20} color="#FFFFFF" />
                    )
                  )}
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView> */}
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* <View style={styles.header}>
        <Text style={styles.headerTitle}>
          Dashboard Settings
        </Text>
      </View> */}
      <ScrollView 
        style={styles.scrollViewContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* Contextual Dashboard */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            General Settings
          </Text>
          <View style={[styles.settingItem, styles.elevatedCard]}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.label}>
                Contextual Dashboard
              </Text>
              {status.glasses_info?.model_name && (
                <Text style={styles.value}>
                  {`Show a summary of your phone notifications when you ${
                    status.glasses_info?.model_name
                      .toLowerCase()
                      .includes('even')
                      ? 'look up'
                      : 'tap your smart glasses'
                  }.`}
                </Text>
              )}
            </View>
            <Switch
              value={isContextualDashboardEnabled}
              onValueChange={toggleContextualDashboard}
              trackColor={switchColors.trackColor}
              thumbColor={switchColors.thumbColor}
              ios_backgroundColor={switchColors.ios_backgroundColor}
            />
          </View>
          
          <View style={[styles.settingItem, styles.elevatedCard]}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.label}>
                Use Metric System
              </Text>
              <Text style={styles.value}>
                Metric System (°C) or Imperial System (°F).
              </Text>
            </View>
            <Switch
              value={isMetricSystemEnabled}
              onValueChange={toggleMetricSystem}
              trackColor={switchColors.trackColor}
              thumbColor={switchColors.thumbColor}
              ios_backgroundColor={switchColors.ios_backgroundColor}
            />
          </View>
        </View>

        {/* Dashboard Content Selection */}
        {/* <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Content Settings
          </Text>
          <TouchableOpacity
            style={[styles.settingItem, styles.elevatedCard]}
            onPress={() => !isLoading && setShowContentPicker(true)}
            disabled={isLoading}
          >
            <View style={styles.settingTextContainer}>
              <Text style={styles.label}>
                Dashboard Content
              </Text>
              <Text style={styles.value}>
                Choose what additional content to display in your dashboard along with your notifications.
              </Text>
            </View>
            <View style={styles.selectedValueContainer}>
              {isLoading ? (
                <ActivityIndicator size="small" color="#007AFF" />
              ) : (
                <>
                  <Text style={styles.selectedValue}>
                    {dashboardContentOptions.find(opt => opt.value === dashboardContent)?.label}
                  </Text>
                  <Icon name="chevron-right" size={16} color="#000000" />
                </>
              )}
            </View>
            {isUpdating && (
              <View style={styles.loadingOverlay}>
                <ActivityIndicator size="small" color="#007AFF" />
              </View>
            )}
          </TouchableOpacity>
        </View> */}

        {/* Display Settings Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            Display Settings
          </Text>
          
          {/* Head-Up Angle Setting */}
          <TouchableOpacity
            style={[
              styles.settingItem,
              styles.elevatedCard,
            ]}
            onPress={() => setHeadUpAngleComponentVisible(true)}
          >
            <View style={styles.settingTextContainer}>
              <Text style={styles.label}>
                Adjust Head-Up Angle
              </Text>
              <Text style={[styles.value]}>
                Adjust the angle at which the contextual dashboard appears when you look up.
              </Text>
            </View>
            <Icon name="chevron-right" size={16} color="#000000" />
          </TouchableOpacity>
        </View>
      </ScrollView>

      {renderContentPicker()}
      {headUpAngle !== null && (
        <HeadUpAngleComponent
          visible={headUpAngleComponentVisible}
          initialAngle={headUpAngle}
          onCancel={onCancelHeadUpAngle}
          onSave={onSaveHeadUpAngle}
        />
      )}
    </SafeAreaView>
  );
};

export default DashboardSettingsScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
  header: {
    padding: 20,
    paddingTop: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
    color: '#333333',
  },
  scrollViewContainer: {
    flex: 1,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    marginLeft: 4,
    color: '#333333',
  },
  elevatedCard: {
    borderRadius: 12,
    marginBottom: 12,
    backgroundColor: '#FFFFFF',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      },
      android: {
        elevation: 3,
      },
    }),
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  settingTextContainer: {
    flex: 1,
    paddingRight: 12,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
    color: '#333333',
  },
  value: {
    fontSize: 14,
    lineHeight: 20,
    color: '#666666',
  },
  selectedValueContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  selectedValue: {
    fontSize: 16,
    marginRight: 4,
    color: '#333333',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  pickerContainer: {
    width: '90%',
    maxHeight: '80%',
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  closeButton: {
    padding: 8,
  },
  closeButtonText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333333',
  },
  pickerOptionsContainer: {
    maxHeight: 400,
  },
  pickerOption: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 0, 0, 0.1)',
  },
  optionContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pickerOptionText: {
    fontSize: 16,
    flex: 1,
    color: '#333333',
  },
  selectedOption: {
    backgroundColor: '#007AFF',
  },
  selectedOptionText: {
    color: '#FFFFFF',
  },
  disabledItem: {
    opacity: 0.5,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
  },
  pickerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#333333',
  },
  disabledButton: {
    opacity: 0.5,
  },
});