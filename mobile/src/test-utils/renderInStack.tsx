import {NavigationContainer, createNavigationContainerRef} from "@react-navigation/native"
import {createNativeStackNavigator} from "@react-navigation/native-stack"
import {act, render} from "@testing-library/react-native"
import {useState, type ReactElement} from "react"
import {Text} from "react-native"

type Routes = {subject: undefined; next: undefined}

const Stack = createNativeStackNavigator<Routes>()

function NextScreen() {
  return <Text>next screen</Text>
}

/**
 * Renders [initial] as a real native-stack screen, like an Expo Router Stack route. `push()`
 * navigates to another route, which keeps the subject mounted but unfocused; `back()` returns
 * to it. `update()` replaces the subject's element, including while it is hidden.
 */
export function renderInStack(initial: ReactElement) {
  const navigation = createNavigationContainerRef<Routes>()
  let setSubject: ((element: ReactElement) => void) | undefined

  function Subject() {
    const [element, setElement] = useState(initial)
    setSubject = setElement
    return element
  }

  const screen = render(
    <NavigationContainer ref={navigation}>
      <Stack.Navigator>
        <Stack.Screen name="subject" component={Subject} />
        <Stack.Screen name="next" component={NextScreen} />
      </Stack.Navigator>
    </NavigationContainer>,
  )

  return {
    screen,
    update: (element: ReactElement) => act(() => setSubject?.(element)),
    push: () => act(() => navigation.navigate("next")),
    back: () => act(() => navigation.goBack()),
  }
}
