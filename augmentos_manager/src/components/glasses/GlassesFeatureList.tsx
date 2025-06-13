import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useAppTheme } from '@/utils/useAppTheme';
import { glassesFeatures, featureLabels, GlassesFeature } from '@/config/glassesFeatures';

interface GlassesFeatureListProps {
  glassesModel: string;
}

export function GlassesFeatureList({ glassesModel }: GlassesFeatureListProps) {
  const { theme } = useAppTheme();
  const features = glassesFeatures[glassesModel];
  
  if (!features) {
    console.warn(`No features defined for glasses model: ${glassesModel}`);
    return null;
  }

  const featureOrder: GlassesFeature[] = ['camera', 'microphone', 'speakers', 'display'];

  return (
    <View style={styles.container}>
      <View style={styles.featureRow}>
        {featureOrder.slice(0, 2).map((feature) => (
          <View key={feature} style={styles.featureItem}>
            <MaterialCommunityIcons
              name={features[feature] ? 'check' : 'close'}
              size={24}
              color={theme.colors.text}
              style={styles.icon}
            />
            <Text style={[styles.featureText, { color: theme.colors.text }]}>
              {featureLabels[feature]}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.featureRow}>
        {featureOrder.slice(2, 4).map((feature) => (
          <View key={feature} style={styles.featureItem}>
            <MaterialCommunityIcons
              name={features[feature] ? 'check' : 'close'}
              size={24}
              color={theme.colors.text}
              style={styles.icon}
            />
            <Text style={[styles.featureText, { color: theme.colors.text }]}>
              {featureLabels[feature]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 20,
  },
  featureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 6,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  icon: {
    marginRight: 10,
  },
  featureText: {
    fontSize: 14,
    fontWeight: '500',
  },
});