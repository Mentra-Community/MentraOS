import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import NavigationBar from '../components/NavigationBar';
import {supabase} from '../supabaseClient';
import Icon from 'react-native-vector-icons/FontAwesome';
import BackendServerComms from '../backend_comms/BackendServerComms';
import { useAuth } from '../AuthContext';

interface ProfileSettingsPageProps {
  isDarkTheme: boolean;
  navigation: any;
}

const ProfileSettingsPage: React.FC<ProfileSettingsPageProps> = ({isDarkTheme, navigation}) => {
  const [userData, setUserData] = useState<{
    fullName: string | null;
    avatarUrl: string | null;
    email: string | null;
    createdAt: string | null;
    provider: string | null;
  } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMatched, setPasswordMatched] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const {logout} = useAuth();

  useEffect(() => {
    const fetchUserData = async () => {
      setLoading(true);
      try {
        const {
          data: {user},
          error,
        } = await supabase.auth.getUser();
        if (error) {
          console.error(error);
          setUserData(null);
        } else if (user) {
          const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null;
          const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
          const email = user.email || null;
          const createdAt = user.created_at || null;
          const provider = user.app_metadata?.provider || null;

          setUserData({
            fullName,
            avatarUrl,
            email,
            createdAt,
            provider,
          });
        }
      } catch (error) {
        console.error(error);
        setUserData(null);
      } finally {
        setLoading(false);
      }
    };

    fetchUserData();
  }, []);

  const handleRequestDataExport = () => {
    console.log('Requesting data export');
    // BackendServerComms.getInstance().requestDataExport();
    // show an alert saying the user will receive an email with a link to download the data
    Alert.alert('Data export requested', 'You will receive an email with a link to download the data.', [
      {text: 'OK', style: 'default'},
    ]);
  };

  const handleDeleteAccount = () => {
    console.log('Deleting account');
    Alert.alert('Are you sure you want to delete your account?', 'This action cannot be undone.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await BackendServerComms.getInstance().requestAccountDeletion();
          } catch (error) {
            console.error(error);
          }
          await logout();
        },
      },
    ]);
  };

  const containerStyle = isDarkTheme ? styles.darkContainer : styles.lightContainer;
  const textStyle = isDarkTheme ? styles.darkText : styles.lightText;
  const profilePlaceholderStyle = isDarkTheme ? styles.darkProfilePlaceholder : styles.lightProfilePlaceholder;

  return (
    <View style={[styles.container, containerStyle]}>
      <ScrollView style={[styles.container, containerStyle]} contentContainerStyle={{paddingBottom: 100}}>
        {loading ? (
          <ActivityIndicator size="large" color={isDarkTheme ? '#ffffff' : '#0000ff'} />
        ) : userData ? (
          <>
            {userData.avatarUrl ? (
              <Image source={{uri: userData.avatarUrl}} style={styles.profileImage} />
            ) : (
              <View style={[styles.profilePlaceholder, profilePlaceholderStyle]}>
                <Text style={[styles.profilePlaceholderText, textStyle]}>No Profile Picture</Text>
              </View>
            )}

            <View style={styles.infoContainer}>
              <Text style={[styles.label, textStyle]}>Name:</Text>
              <Text style={[styles.infoText, textStyle]}>{userData.fullName || 'N/A'}</Text>
            </View>

            <View style={styles.infoContainer}>
              <Text style={[styles.label, textStyle]}>Email:</Text>
              <Text style={[styles.infoText, textStyle]}>{userData.email || 'N/A'}</Text>
            </View>

            <View style={styles.infoContainer}>
              <Text style={[styles.label, textStyle]}>Created at:</Text>
              <Text style={[styles.infoText, textStyle]}>
                {userData.createdAt ? new Date(userData.createdAt).toLocaleString() : 'N/A'}
              </Text>
            </View>

            <View style={styles.infoContainer}>
              <Text style={[styles.label, textStyle]}>Provider:</Text>
              <View style={{flexDirection: 'row', alignItems: 'center', marginTop: 4}}>
                {userData.provider === 'google' && (
                  <>
                    <Icon name="google" size={18} color={isDarkTheme ? '#fff' : '#4285F4'} />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === 'apple' && (
                  <>
                    <Icon name="apple" size={18} color={isDarkTheme ? '#fff' : '#000'} />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === 'facebook' && (
                  <>
                    <Icon name="facebook" size={18} color="#4267B2" />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === 'email' && (
                  <>
                    <Icon name="envelope" size={18} color={isDarkTheme ? '#fff' : '#666'} />
                    <View style={{width: 6}} />
                  </>
                )}
              </View>
            </View>

            {userData.provider == 'email' && (
              <TouchableOpacity
                onPress={() => setShowChangePassword(!showChangePassword)}
                style={styles.changePasswordButton}>
                <Text style={styles.changePasswordButtonText}>Change Password</Text>
              </TouchableOpacity>
            )}

            {showChangePassword && (
              <View style={styles.passwordChangeContainer}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>New Password</Text>
                  <View style={styles.enhancedInputContainer}>
                    <Icon name="lock" size={16} color="#6B7280" style={styles.inputIcon} />
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={styles.enhancedInput}
                      placeholder="Enter new password"
                      value={newPassword}
                      autoCapitalize="none"
                      onChangeText={text => {
                        setNewPassword(text);
                        setPasswordMatched(text === confirmPassword);
                      }}
                      secureTextEntry={!showNewPassword}
                      placeholderTextColor="#9CA3AF"
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowNewPassword(!showNewPassword)}>
                      <Icon name={showNewPassword ? 'eye' : 'eye-slash'} size={18} color="#6B7280" />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Confirm Password</Text>
                  <View style={styles.enhancedInputContainer}>
                    <Icon name="lock" size={16} color="#6B7280" style={styles.inputIcon} />
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={styles.enhancedInput}
                      placeholder="Confirm new password"
                      value={confirmPassword}
                      autoCapitalize="none"
                      onChangeText={text => {
                        setConfirmPassword(text);
                        setPasswordMatched(text === newPassword);
                      }}
                      secureTextEntry={!showConfirmPassword}
                      placeholderTextColor="#9CA3AF"
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowConfirmPassword(!showConfirmPassword)}>
                      <Icon name={showConfirmPassword ? 'eye' : 'eye-slash'} size={18} color="#6B7280" />
                    </TouchableOpacity>
                  </View>
                </View>

                <TouchableOpacity
                  style={[
                    styles.updatePasswordButton,
                    passwordMatched ? styles.activeUpdatePasswordButton : styles.disabledUpdatePasswordButton,
                  ]}
                  disabled={!passwordMatched}
                  onPress={() => {
                    console.log('Password updated:', newPassword);
                    setShowChangePassword(false);
                    setNewPassword('');
                    setConfirmPassword('');
                  }}>
                  <Text style={styles.updatePasswordButtonText}>Update Password</Text>
                </TouchableOpacity>
              </View>
            )}

            <TouchableOpacity style={styles.requestDataExportButton} onPress={handleRequestDataExport}>
              <Text style={styles.deleteAccountButtonText}>Request Data Export</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.deleteAccountButton} onPress={handleDeleteAccount}>
              <Text style={styles.deleteAccountButtonText}>Delete Account</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={textStyle}>Error, while getting User info</Text>
        )}
      </ScrollView>

      <View style={styles.navigationBarContainer}>
        <NavigationBar toggleTheme={() => {}} isDarkTheme={isDarkTheme} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  lightContainer: {
    backgroundColor: '#ffffff',
  },
  darkContainer: {
    backgroundColor: '#000000',
  },
  deleteAccountButton: {
    backgroundColor: '#FF0000',
    padding: 10,
    borderRadius: 5,
  },
  requestDataExportButton: {
    backgroundColor: '#2196F3',
    padding: 10,
    marginTop: 24,
    marginBottom: 24,
    borderRadius: 5,
  },
  requestDataExportButtonText: {
    color: '#ffffff',
  },
  deleteAccountButtonText: {
    color: '#ffffff',
  },
  headerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 60,
  },
  backButtonText: {
    marginLeft: 5,
    fontSize: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  lightText: {
    color: '#000000',
  },
  darkText: {
    color: '#ffffff',
  },
  inputGroup: {
    marginBottom: 16,
  },
  profileImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignSelf: 'center',
    marginBottom: 20,
  },
  profilePlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 20,
  },
  lightProfilePlaceholder: {
    backgroundColor: '#cccccc',
  },
  darkProfilePlaceholder: {
    backgroundColor: '#444444',
  },
  profilePlaceholderText: {
    textAlign: 'center',
  },
  infoContainer: {
    marginBottom: 15,
  },
  label: {
    fontWeight: 'bold',
    fontSize: 16,
  },
  infoText: {
    fontSize: 16,
    marginTop: 4,
  },
  navigationBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  changePasswordButton: {
    alignSelf: 'auto',
    marginVertical: 10,
  },
  changePasswordButtonText: {
    fontSize: 16,
    color: '#2196F3',
    textDecorationLine: 'underline',
  },
  passwordChangeContainer: {
    marginVertical: 20,
  },
  updatePasswordButton: {
    marginTop: 20,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  activeUpdatePasswordButton: {
    backgroundColor: '#2196F3',
  },
  disabledUpdatePasswordButton: {
    backgroundColor: '#cccccc',
  },
  updatePasswordButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
    fontFamily: 'Montserrat-Medium',
  },
  enhancedInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 16,
    backgroundColor: 'white',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  inputIcon: {
    marginRight: 12,
  },
  enhancedInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Montserrat-Regular',
    color: '#111827',
  },
});

export default ProfileSettingsPage;
