import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

interface ButtonProps {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

interface MessageModalProps {
  visible: boolean;
  title: string;
  message: string;
  buttons?: ButtonProps[];
  onDismiss?: () => void;
  isDarkTheme?: boolean;
  iconName?: string;
  iconSize?: number;
  iconColor?: string;
}

const MessageModal: React.FC<MessageModalProps> = ({
  visible,
  title,
  message,
  buttons = [{ text: 'Okay' }],
  onDismiss,
  isDarkTheme = false,
  iconName,
  iconSize = 40,
  iconColor,
}) => {
  const defaultIconColor = iconColor || (isDarkTheme ? '#FFFFFF' : '#2196F3');

  // Handle button press and dismiss modal
  const handleButtonPress = (onPress?: () => void) => {
    if (onPress) {
      onPress();
    }
    if (onDismiss) {
      onDismiss();
    }
  };

  // Determine how to render buttons based on count
  const renderButtons = () => {
    if (buttons.length === 0) {
      // Fallback to default button
      return (
        <TouchableOpacity
          style={[styles.modalButton, styles.singleButton]}
          onPress={() => handleButtonPress(undefined)}
        >
          <Text style={styles.modalButtonText}>OK</Text>
        </TouchableOpacity>
      );
    } else if (buttons.length === 1) {
      // Single button - full width with minimum width
      return (
        <TouchableOpacity
          style={[styles.modalButton, styles.singleButton]}
          onPress={() => handleButtonPress(buttons[0].onPress)}
        >
          <Text style={styles.modalButtonText}>{buttons[0].text}</Text>
        </TouchableOpacity>
      );
    } else {
      // Multiple buttons
      return (
        <View style={buttons.length > 2 ? styles.buttonColumnContainer : styles.buttonRowContainer}>
          {buttons.map((button, index) => {
            const isDestructive = button.style === 'destructive';
            const isCancel = button.style === 'cancel';
            
            return (
              <TouchableOpacity 
                key={index}
                style={[
                  styles.modalButton,
                  buttons.length > 2 ? styles.buttonFullWidth : styles.buttonHalfWidth,
                  isDestructive && styles.destructiveButton,
                  isCancel && styles.cancelButton,
                  index < buttons.length - 1 && buttons.length > 2 && styles.buttonMarginBottom,
                  index === 0 && buttons.length === 2 && styles.buttonMarginRight,
                ]}
                onPress={() => handleButtonPress(button.onPress)}
              >
                <Text style={[
                  styles.modalButtonText,
                  isDestructive && styles.destructiveButtonText,
                  isCancel && styles.cancelButtonText,
                ]}>
                  {button.text}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      );
    }
  };

  return (
    <Modal
      transparent={true}
      visible={visible}
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.modalOverlay}>
        <View style={[
          styles.modalContent,
          isDarkTheme ? styles.modalContentDark : styles.modalContentLight
        ]}>
          {iconName && (
            <Icon 
              name={iconName} 
              size={iconSize} 
              color={defaultIconColor} 
            />
          )}
          <Text style={[
            styles.modalTitle,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            {title}
          </Text>
          <Text style={[
            styles.modalDescription,
            isDarkTheme ? styles.lightSubtext : styles.darkSubtext
          ]}>
            {message}
          </Text>
          {renderButtons()}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
  },
  modalContentLight: {
    backgroundColor: '#FFFFFF',
  },
  modalContentDark: {
    backgroundColor: '#1c1c1c',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  modalDescription: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  // Button styles
  buttonRowContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
  },
  buttonColumnContainer: {
    flexDirection: 'column',
    width: '100%',
  },
  modalButton: {
    backgroundColor: '#2196F3',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  singleButton: {
    width: '100%', // Use full width for single buttons
    marginHorizontal: 0, // No horizontal margins
  },
  buttonFullWidth: {
    width: '100%',
  },
  buttonHalfWidth: {
    flex: 1,
  },
  buttonMarginBottom: {
    marginBottom: 10,
  },
  buttonMarginRight: {
    marginRight: 10,
  },
  modalButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  // Button type styles
  destructiveButton: {
    backgroundColor: '#F44336', // Red
  },
  destructiveButtonText: {
    color: '#FFFFFF',
  },
  cancelButton: {
    backgroundColor: '#9E9E9E', // Gray
  },
  cancelButtonText: {
    color: '#FFFFFF',
  },
  // Text styles
  lightText: {
    color: '#FFFFFF',
  },
  darkText: {
    color: '#1a1a1a',
  },
  lightSubtext: {
    color: '#e0e0e0',
  },
  darkSubtext: {
    color: '#4a4a4a',
  },
});

export default MessageModal;