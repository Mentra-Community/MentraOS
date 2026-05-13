import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {colors} from './theme';

export function OfflineNotice({
  message = 'Connect glasses first. Hardware controls are disabled until the SDK reports an active connection.',
}: {
  message?: string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.icon}>
        <Svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke={colors.greenInk}
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round">
          <Circle cx={12} cy={12} r={9} />
          <Path d="M8.5 8.5 15.5 15.5" />
          <Path d="M15.5 8.5 8.5 15.5" />
        </Svg>
      </View>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    backgroundColor: 'rgba(15,42,29,0.05)',
    borderColor: 'rgba(15,42,29,0.08)',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 4,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: 'rgba(125,216,158,0.18)',
    borderRadius: 999,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  text: {
    color: colors.muted,
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 15,
  },
});
