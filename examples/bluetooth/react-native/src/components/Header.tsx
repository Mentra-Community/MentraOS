import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from './theme';

export function Header({ title }: { title: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 6,
    paddingBottom: 14,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.17,
  },
});
