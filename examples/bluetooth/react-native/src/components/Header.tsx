import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from './theme';

export function Header({ connected = false, title }: { connected?: boolean; title: string }) {
  const label = connected ? 'Live' : 'Offline';

  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.livePill}>
        <View style={[styles.liveDot, !connected && styles.offlineDot]} />
        <Text style={styles.liveText}>{label}</Text>
      </View>
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
  livePill: {
    position: 'absolute',
    right: 16,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    height: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0F2A1D',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 14,
    elevation: 2,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: colors.greenAccent,
  },
  offlineDot: {
    backgroundColor: colors.mutedSoft,
  },
  liveText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
});
