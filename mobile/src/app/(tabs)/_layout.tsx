import {TabList, Tabs, TabSlot, TabTrigger} from "expo-router/ui"

export default function Layout() {
  return (
    <Tabs>
      <TabSlot />
      <TabList className="h-0">
        <TabTrigger name="home" href="/home" asChild></TabTrigger>
      </TabList>
    </Tabs>
  )
}
