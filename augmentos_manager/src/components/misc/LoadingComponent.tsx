import React from 'react';
import { View, ActivityIndicator, StyleSheet, SafeAreaView } from 'react-native';
import { Text } from '@/components/ignite';

const LoadingComponent = ({ message = 'Loading...', theme }: { message?: string; theme?: { backgroundColor?: string; textColor?: string } }) => {
  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme?.backgroundColor || '#ffffff' }]}>
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#999999" />
        <Text 
          text={message}
          style={[styles.text, { color: theme?.textColor || '#000000' }]} />
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 20,
  },
  text: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
});

export default LoadingComponent;
