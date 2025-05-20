import React from 'react';
import { View, StyleSheet } from 'react-native';

const SettingsSkeleton: React.FC = () => {
  // Render 5 placeholder rows for settings
  return (
    <View style={styles.container}>
      {[...Array(5)].map((_, idx) => (
        <View key={idx} style={styles.skeletonRow}>
          <View style={styles.skeletonLabel} />
          <View style={styles.skeletonControl} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    gap: 12,
    paddingVertical: 8,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  skeletonLabel: {
    width: 120,
    height: 18,
    borderRadius: 6,
    backgroundColor: '#e0e0e0',
    marginRight: 16,
  },
  skeletonControl: {
    flex: 1,
    height: 18,
    borderRadius: 6,
    backgroundColor: '#ececec',
  },
});

export default SettingsSkeleton; 