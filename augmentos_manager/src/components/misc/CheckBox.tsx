// CheckBox.tsx

import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { useAppTheme } from '@/utils/useAppTheme';
import { Text } from '@/components/ignite';

interface CheckBoxProps {
  checked: boolean;
  onChange: (newValue: boolean) => void;
  label?: string;
  disabled?: boolean;
  containerStyle?: object;
  boxStyle?: object;
  labelStyle?: object;
}

const CheckBox: React.FC<CheckBoxProps> = ({
  checked,
  onChange,
  label,
  disabled,
  containerStyle,
  boxStyle,
  labelStyle,
}) => {
  const { theme } = useAppTheme();
  
  return (
    <Pressable
      style={[styles.container, containerStyle]}
      onPress={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <View style={[
        styles.box, 
        { borderColor: theme.colors.border },
        boxStyle, 
        checked && [styles.boxChecked, { 
          backgroundColor: theme.colors.buttonPrimary, 
          borderColor: theme.colors.buttonPrimary 
        }]
      ]}>
        {checked && <Text text="✓" style={[styles.checkMark, { color: theme.colors.palette.neutral100 }]} />}
      </View>
      {label ? <Text text={label} style={[styles.label, { color: theme.colors.text }, labelStyle]} /> : null}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  box: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderRadius: 3,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  boxChecked: {
    // Colors handled dynamically with theme
  },
  checkMark: {
    fontWeight: 'bold',
  },
  label: {
    fontSize: 16,
  },
});

export default CheckBox;
