// SelectSetting.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import PickerSelect, { PickerItem } from '../PickerSelect';

type Option = {
  label: string;
  value: string;
};

type Theme = {
  backgroundColor: string;
  textColor: string;
};

type SelectSettingProps = {
  label: string;
  value: string;
  options: Option[];
  onValueChange: (value: string) => void;
  theme: Theme;
  description?: string;
};

const SelectSetting: React.FC<SelectSettingProps> = ({
  label,
  value,
  options,
  onValueChange,
  theme,
  description,
}) => {
  // Convert your Option[] to PickerItem[]
  const pickerItems: PickerItem[] = options.map((option) => ({
    label: option.label,
    value: option.value,
  }));

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: theme.textColor }]}>{label}</Text>
      {description && <Text style={[styles.description, { color: theme.textColor }]}>{description}</Text>}
      <View
        style={[
          styles.pickerContainer,
          { borderColor: theme.textColor, backgroundColor: theme.backgroundColor },
        ]}
      >
        <PickerSelect
          items={pickerItems}
          value={value}
          onValueChange={onValueChange}
          // placeholder={{ label: 'Select an option...', value: '' }}
          style={{
            touchable: { borderColor: theme.textColor },
            touchableText: { color: theme.textColor },
            // You can override or extend other styles here as well
          }}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 10,
    width: '100%',
  },
  label: {
    fontSize: 16,
    marginBottom: 5,
  },
  pickerContainer: {
    borderWidth: 1,
    borderRadius: 5,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  description: {
    fontSize: 12,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
});

export default SelectSetting;
