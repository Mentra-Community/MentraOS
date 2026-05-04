import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Polyline } from 'react-native-svg';
import { Header } from '../components/Header';
import { StatusBarBar } from '../components/StatusBarBar';
import { colors } from '../components/theme';
import type { MentraSdkModel, SdkConsoleEvent } from '../useMentraSdk';

export function ConsoleScreen({ sdk }: { sdk: MentraSdkModel }) {
  const [filter, setFilter] = useState<'ALL' | SdkConsoleEvent['tag']>('ALL');
  const events = filter === 'ALL' ? sdk.events : sdk.events.filter((item) => item.tag === filter);
  const counts = {
    ALL: sdk.events.length,
    BLE: sdk.events.filter((item) => item.tag === 'BLE').length,
    LIVE: sdk.events.filter((item) => item.tag === 'LIVE').length,
    STORE: sdk.events.filter((item) => item.tag === 'STORE').length,
    TX: sdk.events.filter((item) => item.tag === 'TX').length,
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 140 }}>
      <StatusBarBar />
      <Header title="Console" />

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 6 }} style={{ marginTop: 8 }}>
        <Pressable onPress={() => setFilter('ALL')}>
          <LinearGradient colors={['#28473A', '#1F3A2A']} style={[styles.chip, styles.chipDark]}>
            <Text style={styles.chipDarkText}>ALL</Text>
            <Text style={styles.chipDarkCount}>{counts.ALL}</Text>
          </LinearGradient>
        </Pressable>
        <FilterChip color="#00C7BE" labelColor="#00807B" label="LIVE" count={String(counts.LIVE)} onPress={() => setFilter('LIVE')} />
        <FilterChip color="#84B5E8" labelColor="#3478B8" label="BLE" count={String(counts.BLE)} onPress={() => setFilter('BLE')} />
        <FilterChip color={colors.amber} labelColor="#B86A00" label="TX" count={String(counts.TX)} onPress={() => setFilter('TX')} />
        <FilterChip color={colors.gold} labelColor="#8C7400" label="STORE" count={String(counts.STORE)} onPress={() => setFilter('STORE')} />
      </ScrollView>

      {/* Console block */}
      <View style={styles.consoleCard}>
        <View style={styles.consoleHead}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={styles.dots}>
              <View style={[styles.dot, { backgroundColor: '#FF5F57' }]} />
              <View style={[styles.dot, { backgroundColor: '#FEBC2E' }]} />
              <View style={[styles.dot, { backgroundColor: '#27C93F' }]} />
            </View>
            <Text style={styles.consoleTitle}>mentra-sdk · live</Text>
          </View>
          <View style={styles.recPill}>
            <View style={styles.recDot} />
            <Text style={styles.recText}>REC</Text>
          </View>
        </View>
        <View style={{ gap: 10 }}>
          {events.map((e, i) => (
            <View key={i} style={styles.eventRow}>
              <Text style={styles.eventTime}>{e.time}</Text>
              <View style={[styles.eventTag, { backgroundColor: `${tagColor(e.tag)}29` }]}>
                <Text style={[styles.eventTagText, { color: tagColor(e.tag) }]}>{e.tag}</Text>
              </View>
              <Text style={styles.eventText}>{e.text}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Raw JSON disclosure */}
      <Pressable style={{ marginHorizontal: 16, marginTop: 12 }} onPress={() => sdk.setRawJsonExpanded(!sdk.rawJsonExpanded)}>
        <LinearGradient colors={['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.5)']} style={styles.jsonCard}>
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <Polyline points="16 18 22 12 16 6" />
            <Polyline points="8 6 2 12 8 18" />
          </Svg>
          <View style={{ flex: 1 }}>
            <Text style={styles.jsonTitle}>Raw status JSON</Text>
            <Text style={styles.jsonSub}>{Object.keys(sdk.glassesStatus).length + Object.keys(sdk.bluetoothStatus).length} keys · glassesStatus, bluetoothStatus</Text>
          </View>
          <Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <Polyline points="6 9 12 15 18 9" />
          </Svg>
        </LinearGradient>
      </Pressable>
      {sdk.rawJsonExpanded ? (
        <Text style={styles.rawJson}>
          {JSON.stringify({ glassesStatus: sdk.glassesStatus, bluetoothStatus: sdk.bluetoothStatus }, null, 2)}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function FilterChip({ color, labelColor, label, count, onPress }: { color: string; labelColor: string; label: string; count: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress}>
      <View style={styles.chip}>
        <View style={[styles.chipDot, { backgroundColor: color }]} />
        <Text style={[styles.chipLabel, { color: labelColor }]}>{label}</Text>
        <Text style={styles.chipCount}>{count}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: colors.border, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipDark: { borderWidth: 0 },
  chipDarkText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  chipDarkCount: { color: 'rgba(255,255,255,0.5)', fontSize: 10, fontWeight: '500' },
  chipDot: { width: 6, height: 6, borderRadius: 999 },
  chipLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  chipCount: { color: colors.muted, fontSize: 10, fontWeight: '500' },

  consoleCard: { marginHorizontal: 16, marginTop: 12, borderRadius: 24, paddingVertical: 18, paddingHorizontal: 18, gap: 12, backgroundColor: 'rgba(20,22,21,0.92)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', shadowColor: '#0F2A1D', shadowOpacity: 0.18, shadowOffset: { width: 0, height: 12 }, shadowRadius: 40, elevation: 8 },
  consoleHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 6, borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  dots: { flexDirection: 'row', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 999 },
  consoleTitle: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '500' },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(125,216,158,0.14)', borderWidth: 1, borderColor: 'rgba(125,216,158,0.3)', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  recDot: { width: 5, height: 5, borderRadius: 999, backgroundColor: '#7DD89E' },
  recText: { color: '#7DD89E', fontSize: 9, fontWeight: '700', letterSpacing: 0.7 },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  eventTime: { width: 50, color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '500', fontFamily: 'Courier', paddingTop: 2 },
  eventTag: { width: 50, alignItems: 'center', paddingVertical: 3, paddingHorizontal: 6, borderRadius: 5 },
  eventTagText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  eventText: { flex: 1, color: colors.consoleText, fontSize: 11, lineHeight: 16, fontFamily: 'Courier' },

  jsonCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: colors.borderSoft },
  jsonTitle: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  jsonSub: { color: colors.muted, fontSize: 10 },
  rawJson: { marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 14, backgroundColor: '#0E1A14', color: colors.consoleText, fontFamily: 'Courier', fontSize: 10 },
});

function tagColor(tag: SdkConsoleEvent['tag']) {
  switch (tag) {
    case 'BLE':
      return '#84B5E8';
    case 'STORE':
      return '#E8C66B';
    case 'TX':
      return '#E89C7D';
    case 'LIVE':
    default:
      return '#7DD89E';
  }
}
