// SelectWithSearchSetting.tsx
import React, {useState, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Modal,
  TouchableOpacity,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from 'react-native';

type Option = {
  label: string;
  value: string;
};

type Theme = {
  backgroundColor: string;
  textColor: string;
};

type SelectWithSearchSettingProps = {
  label: string;
  value: string;
  options: Option[];
  onValueChange: (value: string) => void;
  theme: Theme;
};

const SelectWithSearchSetting: React.FC<SelectWithSearchSettingProps> = ({
  label,
  value,
  options,
  onValueChange,
  theme,
}) => {
  const [search, setSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);

  // Filter options based on search
  const filteredOptions = useMemo(() => {
    if (!search) return options;
    return options.filter(option => option.label.toLowerCase().includes(search.toLowerCase()));
  }, [search, options]);

  const selectedLabel = options.find(option => option.value === value)?.label || 'Select...';

  return (
    <View style={styles.container}>
      <Text style={[styles.label, {color: theme.textColor}]}>{label}</Text>
      <TouchableOpacity
        style={[styles.selectField, {borderColor: theme.textColor, backgroundColor: theme.backgroundColor}]}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}>
        <Text style={[styles.selectText, {color: theme.textColor}]}>{selectedLabel}</Text>
      </TouchableOpacity>
      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={true}
        style={{flex: 1}}
        onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{flex: 1}}>
          <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
            <View style={styles.modalOverlay}>
              <View style={[styles.modalContent, {backgroundColor: theme.backgroundColor}]}>
                <TouchableWithoutFeedback>
                  <View style={styles.modalHeader}>
                    <Text style={[styles.modalLabel, {color: theme.textColor}]}>{label}</Text>
                    <TouchableOpacity hitSlop={10} onPress={() => setModalVisible(false)}>
                      <Text style={[styles.closeButton, {color: theme.textColor, marginRight: -8}]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </TouchableWithoutFeedback>
                <TextInput
                  style={[
                    styles.searchInput,
                    {color: theme.textColor, borderColor: theme.textColor, backgroundColor: theme.backgroundColor},
                  ]}
                  placeholder="Search..."
                  placeholderTextColor={theme.textColor + '99'}
                  value={search}
                  onChangeText={setSearch}
                  autoFocus
                />
                <FlatList
                  data={filteredOptions}
                  keyExtractor={item => item.value}
                  keyboardShouldPersistTaps="always"
                  style={styles.optionsList}
                  renderItem={({item}) => (
                    <Pressable
                      style={[styles.optionItem, item.value === value && {backgroundColor: theme.textColor + '22'}]}
                      onPress={() => {
                        onValueChange(item.value);
                        setModalVisible(false);
                        setSearch('');
                      }}>
                      <Text style={[styles.optionText, {color: theme.textColor}]}>{item.label}</Text>
                    </Pressable>
                  )}
                  ListEmptyComponent={
                    <Text style={[styles.emptyText, {color: theme.textColor + '99'}]}>No options found</Text>
                  }
                />
              </View>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>
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
  selectField: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    marginBottom: 2,
  },
  selectText: {
    fontSize: 16,
    opacity: 0.9,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxHeight: '70%',
    borderRadius: 10,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 5,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalLabel: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeButton: {
    fontSize: 22,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
    fontSize: 16,
  },
  optionsList: {
    flexGrow: 0,
    maxHeight: 250,
  },
  optionItem: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 5,
    marginBottom: 4,
  },
  optionText: {
    fontSize: 16,
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 20,
    fontSize: 15,
  },
});

export default SelectWithSearchSetting;
