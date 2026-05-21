import { useSession } from '@mentra/miniapp/react';

export default function App() {
  const session = useSession();

  return (
    <div style={{ padding: 20 }}>
      <h1>My Miniapp</h1>
      <button
        onClick={() => {
          console.log('Button tapped');
          session.layouts.showTextWall('Hello from my miniapp!');
        }}
      >
        Show on glasses
      </button>
    </div>
  );
}
