# Modal System Usage Guide

## Setup
The modal system is already set up in the app root at `App.tsx`:

```tsx
<ModalProvider isDarkTheme={isDarkTheme} />
```

## Usage Option 1: Use the `showAlert` Function
Replace all instances of `Alert.alert` with `showAlert` from `utils/AlertUtils`:

```tsx
import showAlert from '../utils/AlertUtils';

// Instead of:
Alert.alert(
  "Title",
  "Message",
  [{ text: "OK", onPress: () => {} }]
);

// Use:
showAlert(
  "Title",
  "Message",
  [{ text: "OK", onPress: () => {} }],
  { 
    isDarkTheme, // Pass current theme
    iconName: "information-outline", // Optional - can use any icon from react-native-vector-icons/MaterialCommunityIcons
    iconSize: 40, // Optional - defaults to 40
    iconColor: "#2196F3" // Optional - defaults to theme-appropriate color
  }
);
```

### Options
The `showAlert` function accepts the same parameters as `Alert.alert` plus additional options:

```tsx
showAlert(
  title: string,
  message: string,
  buttons: Array<{ text: string, onPress?: () => void }> = [{ text: 'OK' }],
  options?: { 
    cancelable?: boolean; 
    onDismiss?: () => void;
    useNativeAlert?: boolean; // Set to true to force using React Native's Alert.alert
    isDarkTheme?: boolean;
    iconName?: string;
    iconSize?: number;
    iconColor?: string;
  }
)
```

## Usage Option 2: Use the `MessageModal` Component Directly

For more complex modal usage (like in YourAppsList.tsx), you can use the MessageModal component directly:

```tsx
import MessageModal from '../components/MessageModal';

// Inside your functional component:
const [modalVisible, setModalVisible] = useState(false);

// Inside your JSX:
<MessageModal
  visible={modalVisible}
  title="Modal Title"
  message="This is the modal message"
  buttons={[
    { text: "Got it", onPress: () => setModalVisible(false) }
  ]}
  onDismiss={() => setModalVisible(false)}
  isDarkTheme={isDarkTheme}
  iconName="gesture-tap"
  iconSize={40}
/>

// Example with multiple buttons:
<MessageModal
  visible={confirmModalVisible}
  title="Confirm Action"
  message="Are you sure you want to proceed with this action?"
  buttons={[
    { 
      text: "Cancel", 
      onPress: () => setConfirmModalVisible(false),
      style: "cancel" // Styles available: 'default', 'cancel', 'destructive'
    },
    { 
      text: "Yes, proceed", 
      onPress: () => {
        setConfirmModalVisible(false);
        performAction();
      }
    }
  ]}
  isDarkTheme={isDarkTheme}
  iconName="alert-circle-outline"
/>
```

### Props
The `MessageModal` component accepts the following props:

```tsx
interface ButtonProps {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

interface MessageModalProps {
  visible: boolean;
  title: string;
  message: string;
  buttons?: ButtonProps[]; // Array of buttons with text, onPress and optional style
  onDismiss?: () => void;
  isDarkTheme?: boolean; // Defaults to false
  iconName?: string; // Defaults to "information-outline"
  iconSize?: number; // Defaults to 40
  iconColor?: string; // Optional, defaults to theme-appropriate color
}
```

## Advantages

1. **Consistent look and feel** across the app
2. **More modern and customizable** than the native Alert
3. **Better theming support** - automatically adapts to dark/light mode
4. **Icon support** - can show any icon from react-native-vector-icons
5. **Drop-in replacement** - easy to gradually migrate from Alert.alert

## Future Enhancements

1. ✅ Support for multiple buttons (implemented!)
2. ✅ Support for different button styles (primary, cancel, destructive) (implemented!)
3. Support for form inputs within the modal
4. Animation customization
5. Configurable button layout options (row vs column)