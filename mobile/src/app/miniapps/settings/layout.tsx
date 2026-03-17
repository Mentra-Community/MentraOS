import {Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {View} from "react-native"
import {DraggableMasonryList} from "react-native-draggable-masonry"

export default function LayoutSettingsScreen() {
  const {goBack} = useNavigationHistory()

  const data = [
    {id: "1", height: 100, title: "Item 1"},
    {id: "2", height: 150, title: "Item 2"},
    {id: "3", height: 120, title: "Item 3"},
    {id: "4", height: 130, title: "Item 4"},
    {id: "5", height: 140, title: "Item 5"},
    // {id: "6", height: 150, title: "Item 6"},
    // {id: "7", height: 160, title: "Item 7"},
    // {id: "8", height: 170, title: "Item 8"},
    // {id: "9", height: 180, title: "Item 9"},
    // {id: "10", height: 190, title: "Item 10"},
  ]
  const renderItem = ({item}: {item: {id: string; height: number; title: string}}) => {
    const backgroundColor = `#${Math.floor(Math.random() * 16777215).toString(16)}`
    return (
      <View style={{height: item.height, backgroundColor}}>
        <Text>{item.title}</Text>
      </View>
    )
  }

  return (
    <Screen preset="fixed">
      <Header title="Layout Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <View className="h-6" />

      <DraggableMasonryList
        data={data}
        renderItem={renderItem}
        columns={2}
        onDragEnd={({data}) => console.log("New order:", data)}
      />
    </Screen>
  )
}
