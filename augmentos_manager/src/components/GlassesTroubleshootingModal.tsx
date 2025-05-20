import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

interface TroubleshootingModalProps {
  isVisible: boolean;
  onClose: () => void;
  glassesModelName: string;
  isDarkTheme: boolean;
}

export const getModelSpecificTips = (model: string) => {
  switch (model) {
    case 'Even Realities G1':
      return [
        "Make sure you closed the G1's left arm FIRST before putting it in the case",
        "Plug your G1 case into a charger during the pairing process",
        "Try closing the charging case and opening it again",
        "Ensure no other app is currently connected to your G1",
        "Restart your phone's Bluetooth",
        "Make sure your phone is within 3 feet of your glasses & case",
        "If your glasses were previously paired to a different phone, you must unpair/forget the glasses in your phone's Bluetooth settings before retrying the pairing process"
      ];
    case 'Mentra Mach1':
    case 'Vuzix Z100':
      return [
        "Make sure your glasses are turned on",
        "Check that your glasses are paired in the 'Vuzix Connect' app",
        "Try resetting your Bluetooth connection"
      ];
    case 'Mentra Live':
      return [
        "Make sure your Mentra Live is fully charged",
        "Check that your Mentra Live is in pairing mode",
        "Ensure no other app is currently connected to your glasses",
        "Try restarting your glasses",
        "Check that your phone's Bluetooth is enabled"
      ];
    default:
      return [
        "Make sure your glasses are charged and turned on",
        "Ensure no other device is connected to your glasses",
        "Try restarting both your glasses and phone",
        "Make sure your phone is within range of your glasses"
      ];
  }
};

const GlassesTroubleshootingModal: React.FC<TroubleshootingModalProps> = ({ 
  isVisible, 
  onClose, 
  glassesModelName, 
  isDarkTheme 
}) => {

  const themeColors = {
    background: isDarkTheme ? '#2d2d2d' : '#ffffff',
    text: isDarkTheme ? '#ffffff' : '#000000',
    border: isDarkTheme ? '#555555' : '#cccccc',
    buttonBackground: isDarkTheme ? '#3b82f6' : '#007BFF',
    tipBackground: isDarkTheme ? '#404040' : '#f0f0f0',
    overlay: 'rgba(0,0,0,0.7)',
  };

  const tips = getModelSpecificTips(glassesModelName);

  return (
    <Modal visible={isVisible} animationType="slide" transparent>
      <View style={[styles.modalContainer, { backgroundColor: themeColors.overlay }]}>
        <View style={[styles.modalContent, { backgroundColor: themeColors.background }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalHeaderText, { color: themeColors.text }]}>
              Troubleshooting {glassesModelName}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <MaterialIcons name="close" size={24} color={themeColors.text} />
            </TouchableOpacity>
          </View>
          
          <Text style={[styles.modalSubText, { color: themeColors.text }]}>
            Having trouble pairing your glasses? Try these tips:
          </Text>
          
          <ScrollView style={styles.tipsContainer}>
            {tips.map((tip, index) => (
              <View 
                key={index} 
                style={[styles.tipItem, { backgroundColor: themeColors.tipBackground }]}
              >
                <Text style={[styles.tipNumber, { color: themeColors.buttonBackground }]}>
                  {index + 1}
                </Text>
                <Text style={[styles.tipText, { color: themeColors.text }]}>
                  {tip}
                </Text>
              </View>
            ))}
          </ScrollView>
          
          <TouchableOpacity 
            style={[styles.closeModalButton, { backgroundColor: themeColors.buttonBackground }]} 
            onPress={onClose}
          >
            <Text style={styles.closeModalButtonText}>Got it, thanks!</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    maxHeight: '80%',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: {
      width: 0,
      height: 2,
    },
    elevation: 5,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  modalHeaderText: {
    fontSize: 20,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
    flex: 1,
  },
  closeButton: {
    padding: 5,
  },
  modalSubText: {
    fontSize: 16,
    marginBottom: 15,
    fontFamily: 'Montserrat-Regular',
  },
  tipsContainer: {
    maxHeight: 350,
    marginBottom: 20,
  },
  tipItem: {
    flexDirection: 'row',
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    alignItems: 'flex-start',
  },
  tipNumber: {
    fontSize: 16,
    fontWeight: 'bold',
    marginRight: 10,
    fontFamily: 'Montserrat-Bold',
    minWidth: 20,
  },
  tipText: {
    fontSize: 15,
    flex: 1,
    fontFamily: 'Montserrat-Regular',
  },
  closeModalButton: {
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeModalButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
});

export default GlassesTroubleshootingModal;