import React from 'react';
import { TouchableOpacity, Text, StyleSheet, GestureResponderEvent, ViewStyle } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

interface ButtonProps {
  onPress: (event: GestureResponderEvent) => void;
  title?: string;
  children?: React.ReactNode;
  isDarkTheme?: boolean;
  iconName?: string;
  disabled?: boolean;
  type?: 'primary' | 'secondary';
  style?: ViewStyle;
}

const Button: React.FC<ButtonProps> = ({ 
  onPress, 
  disabled = false, 
  children, 
  title, 
  isDarkTheme, 
  iconName, 
  type = 'primary',
  style,
  ...props 
}) => {
  return (
    <TouchableOpacity
      style={[
        styles.button, 
        isDarkTheme && styles.buttonDark,
        type === 'secondary' && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        style
      ]}
      onPress={onPress}
      disabled={disabled}
      {...props}>
      {iconName && (
        <Icon 
          name={iconName} 
          size={16}           
          color={disabled ? '#999' : (type === 'secondary' ? '#2196F3' : 'white')} 
          style={styles.buttonIcon} 
        />
      )}
      <Text 
        style={[
          styles.buttonText, 
          disabled && styles.buttonTextDisabled,
          type === 'secondary' && styles.buttonTextSecondary
        ]}
      >
        {title || children}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    width: '100%',
    maxWidth: 300,
    height: 44,
    backgroundColor: '#2196F3',
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
  },
  buttonDark: {
    backgroundColor: '#1976D2',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2196F3',
    elevation: 0,
    shadowOpacity: 0,
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  buttonTextSecondary: {
    color: '#2196F3',
  },
  buttonDisabled: {
    backgroundColor: '#cccccc',
    borderColor: '#cccccc',
    elevation: 0,
    shadowOpacity: 0,
  },
  buttonTextDisabled: {
    color: '#999',
  },
});

export default Button;
